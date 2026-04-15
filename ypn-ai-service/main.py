import os
import json
import time
import base64
import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status

import firebase_admin
from firebase_admin import credentials, auth

from vosk import Model, KaldiRecognizer

from upstash_redis import Redis
from supabase import create_client

from retrievers import retrieve
from prompts import SYSTEM_PROMPT


# ── Firebase Init ─────────────────────────────────────────────────────────────
cred_raw = os.getenv("FIREBASE_CREDENTIALS")
if not cred_raw:
    raise Exception("FIREBASE_CREDENTIALS missing")

cred_json = json.loads(cred_raw)
if not firebase_admin._apps:
    firebase_admin.initialize_app(credentials.Certificate(cred_json))


# ── Redis & Supabase ──────────────────────────────────────────────────────────
redis = Redis(
    url=os.getenv("UPSTASH_REDIS_REST_URL"),
    token=os.getenv("UPSTASH_REDIS_REST_TOKEN")
)

supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_KEY")
if not supabase_url or not supabase_key:
    raise Exception("SUPABASE_URL or SUPABASE_KEY missing")

supabase = create_client(supabase_url, supabase_key)


# ── Vosk Model ────────────────────────────────────────────────────────────────
VOSK_MODEL_PATH = os.getenv("VOSK_MODEL_PATH", "models/vosk-model-small-en-us-0.15")
model = None

if os.path.isdir(VOSK_MODEL_PATH) and os.path.exists(os.path.join(VOSK_MODEL_PATH, "conf")):
    try:
        model = Model(VOSK_MODEL_PATH)
        print("[VOSK] Model loaded successfully")
    except Exception as e:
        print(f"[VOSK] Load error: {e}")
        model = None
else:
    print("[VOSK] Model missing or invalid")


app = FastAPI()


# ── Auth: Verify Firebase ID Token ONLY ───────────────────────────────────────
def verify_token(token: str):
    """Returns decoded token dict if valid, None otherwise."""
    try:
        return auth.verify_id_token(token)
    except Exception:
        return None


# ── AI Stub (Replace with your real async provider) ───────────────────────────
async def run_ai(prompt: str):
    """Async generator yielding tokens. Replace with Cohere/OpenAI/etc."""
    await asyncio.sleep(0.2)  # Simulate latency
    return "I understand. I'm listening carefully and responding step by step."


# ── Redis Helpers ─────────────────────────────────────────────────────────────
def add_message(uid, role, text):
    key = f"chat:{uid}"
    data = redis.get(key)
    chat = json.loads(data) if data else []
    chat.append({"role": role, "text": text, "t": time.time()})
    chat = chat[-20:]  # Keep last 20 messages
    redis.set(key, json.dumps(chat))
    return chat


def get_chat(uid):
    data = redis.get(f"chat:{uid}")
    return json.loads(data) if data else []


def update_audio_time(uid):
    redis.set(f"last_audio:{uid}", time.time())


def is_user_silent(uid, threshold=0.8):
    last = redis.get(f"last_audio:{uid}")
    if not last:
        return False
    return (time.time() - float(last)) > threshold


def build_prompt(uid, user_text):
    chat = get_chat(uid)
    context = retrieve(user_text, chat)
    return f"""
{SYSTEM_PROMPT}

Conversation:
{json.dumps(chat)}

Context:
{json.dumps(context)}

User:
{user_text}
"""


# ── WebSocket: Auth-First, Then Stream ────────────────────────────────────────
@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()

    uid = None
    recognizer = None
    pending_text = ""

    try:
        # 🔥 1. AUTH PHASE: Wait for auth message ONLY
        auth_data = await asyncio.wait_for(websocket.receive_json(), timeout=5.0)
        
        if auth_data.get("type") != "auth":
            await websocket.send_json({"type": "auth_error", "status": 400, "message": "Missing auth"})
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        token = auth_data.get("token")
        if not token:
            await websocket.send_json({"type": "auth_error", "status": 401, "message": "Token missing"})
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        # 🔥 2. Verify Firebase ID Token — NO FALLBACK
        user = verify_token(token)
        if not user:
            await websocket.send_json({"type": "auth_error", "status": 401, "message": "Invalid token"})
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        # 🔥 3. Auth success — proceed
        uid = user["uid"]
        redis.setnx(f"chat:{uid}", json.dumps([]))  # Init chat if new user

        if model:
            recognizer = KaldiRecognizer(model, 16000)

        # 🔥 4. Notify client auth succeeded — now start streaming
        await websocket.send_json({"type": "auth_success", "uid": uid})

        # ── MAIN LOOP: Handle audio/text/interrupt ───────────────────────────
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            user_text = None

            # ── Text message ─────────────────────────────────────────────────
            if msg_type == "text":
                user_text = data.get("message", "").strip()

            # ── Audio chunk (Vosk) ───────────────────────────────────────────
            elif msg_type == "audio" and recognizer:
                pcm = base64.b64decode(data["audio"])
                update_audio_time(uid)

                if recognizer.AcceptWaveform(pcm):
                    res = json.loads(recognizer.Result())
                    user_text = res.get("text", "").strip()
                else:
                    partial = json.loads(recognizer.PartialResult())
                    pending_text = partial.get("partial", "")

                    await websocket.send_json({
                        "type": "partial",
                        "text": pending_text
                    })

                    # Auto-submit if user goes silent mid-sentence
                    if is_user_silent(uid) and pending_text:
                        user_text = pending_text
                        pending_text = ""

            # ── Interrupt (cancel current AI response) ───────────────────────
            elif msg_type == "interrupt":
                redis.set(f"interrupt:{uid}", "1")
                continue

            # Skip if no usable input
            if not user_text:
                continue

            # ── Process user input ───────────────────────────────────────────
            add_message(uid, "user", user_text)
            prompt = build_prompt(uid, user_text)

            await websocket.send_json({"type": "state", "value": "thinking"})

            # Stream AI response token-by-token
            response = await run_ai(prompt)
            await websocket.send_json({"type": "state", "value": "speaking"})

            ai_text = ""
            for word in response.split():
                # Check for interrupt during streaming
                if redis.get(f"interrupt:{uid}") == "1":
                    redis.delete(f"interrupt:{uid}")
                    break

                ai_text += word + " "
                await websocket.send_json({
                    "type": "ai_token",
                    "text": word + " "
                })
                await asyncio.sleep(0.03)  # Simulate token delay

            # Persist & notify completion
            if ai_text.strip():
                add_message(uid, "ai", ai_text)
                supabase.table("messages").insert({
                    "user_id": uid,
                    "role": "ai",
                    "content": ai_text.strip()
                }).execute()

            await websocket.send_json({"type": "done"})
            await websocket.send_json({"type": "state", "value": "listening"})

    except WebSocketDisconnect:
        print(f"[WS] Disconnected: {uid}")
    except asyncio.TimeoutError:
        # Client didn't send auth within 5s
        try:
            await websocket.send_json({"type": "auth_error", "status": 408, "message": "Auth timeout"})
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except:
            pass
        print("[WS] Auth timeout")
    except Exception as e:
        print(f"[WS] Error: {uid} — {e}")
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except:
            pass