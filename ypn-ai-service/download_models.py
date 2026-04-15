import os
import json
import time
import base64
import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import firebase_admin
from firebase_admin import credentials, auth

from vosk import Model, KaldiRecognizer

from upstash_redis import Redis
from supabase import create_client

from retrievers import retrieve
from prompts import SYSTEM_PROMPT


# ─────────────────────────────────────────────
# FIREBASE
# ─────────────────────────────────────────────
cred_raw = os.getenv("FIREBASE_CREDENTIALS")

if not cred_raw:
    raise Exception("FIREBASE_CREDENTIALS missing")

cred_json = json.loads(cred_raw)

if not firebase_admin._apps:
    firebase_admin.initialize_app(
        credentials.Certificate(cred_json)
    )


# ─────────────────────────────────────────────
# REDIS
# ─────────────────────────────────────────────
redis = Redis(
    url=os.getenv("UPSTASH_REDIS_REST_URL"),
    token=os.getenv("UPSTASH_REDIS_REST_TOKEN")
)


# ─────────────────────────────────────────────
# SUPABASE
# ─────────────────────────────────────────────
supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_KEY")

if not supabase_url or not supabase_key:
    raise Exception("SUPABASE_URL or SUPABASE_KEY missing")

supabase = create_client(supabase_url, supabase_key)


# ─────────────────────────────────────────────
# VOSK (SAFE LOADING)
# ─────────────────────────────────────────────
VOSK_MODEL_PATH = os.getenv(
    "VOSK_MODEL_PATH",
    "models/vosk-model-small-en-us-0.15"
)

model = None

if os.path.isdir(VOSK_MODEL_PATH):
    try:
        model = Model(VOSK_MODEL_PATH)
        print("[VOSK] Model loaded successfully")
    except Exception as e:
        print("[VOSK] Failed to load model:", e)
        model = None
else:
    print("[VOSK] Model folder not found, speech disabled")


# ─────────────────────────────────────────────
# FASTAPI
# ─────────────────────────────────────────────
app = FastAPI()


# ─────────────────────────────────────────────
# AUTH
# ─────────────────────────────────────────────
def verify_token(token: str):
    try:
        return auth.verify_id_token(token)
    except:
        return None


# ─────────────────────────────────────────────
# AI ENGINE (placeholder)
# ─────────────────────────────────────────────
async def run_ai(prompt: str):
    await asyncio.sleep(0.2)
    return "I understand. I'm listening carefully and responding step by step."


# ─────────────────────────────────────────────
# REDIS CHAT
# ─────────────────────────────────────────────
def add_message(uid, role, text):
    key = f"chat:{uid}"
    data = redis.get(key)

    chat = json.loads(data) if data else []

    chat.append({
        "role": role,
        "text": text,
        "t": time.time()
    })

    chat = chat[-20:]

    redis.set(key, json.dumps(chat))
    return chat


def get_chat(uid):
    data = redis.get(f"chat:{uid}")
    return json.loads(data) if data else []


# ─────────────────────────────────────────────
# VAD
# ─────────────────────────────────────────────
def update_audio_time(uid):
    redis.set(f"last_audio:{uid}", time.time())


def is_user_silent(uid, threshold=0.8):
    last = redis.get(f"last_audio:{uid}")
    if not last:
        return False
    return (time.time() - float(last)) > threshold


# ─────────────────────────────────────────────
# PROMPT BUILDER
# ─────────────────────────────────────────────
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


# ─────────────────────────────────────────────
# WEBSOCKET
# ─────────────────────────────────────────────
@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()

    uid = None
    recognizer = None
    pending_text = ""

    try:
        auth_data = await websocket.receive_json()

        token = auth_data.get("token")
        user = verify_token(token)

        uid = user["uid"] if user else "test_user"

        redis.setnx(f"chat:{uid}", json.dumps([]))

        # only create recognizer if model exists
        if model:
            recognizer = KaldiRecognizer(model, 16000)

        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            user_text = None

            # ───── TEXT ─────
            if msg_type == "text":
                user_text = data.get("message", "").strip()

            # ───── AUDIO ─────
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

                    if is_user_silent(uid) and pending_text:
                        user_text = pending_text
                        pending_text = ""

            # ───── INTERRUPT ─────
            elif msg_type == "interrupt":
                redis.set(f"interrupt:{uid}", "1")
                continue

            if not user_text:
                continue

            add_message(uid, "user", user_text)

            prompt = build_prompt(uid, user_text)

            await websocket.send_json({
                "type": "state",
                "value": "thinking"
            })

            response = await run_ai(prompt)

            await websocket.send_json({
                "type": "state",
                "value": "speaking"
            })

            ai_text = ""

            for word in response.split():

                if redis.get(f"interrupt:{uid}") == "1":
                    redis.delete(f"interrupt:{uid}")
                    break

                ai_text += word + " "

                await websocket.send_json({
                    "type": "ai_token",
                    "text": word + " "
                })

                await asyncio.sleep(0.03)

            add_message(uid, "ai", ai_text)

            supabase.table("messages").insert({
                "user_id": uid,
                "role": "ai",
                "content": ai_text
            }).execute()

            await websocket.send_json({"type": "done"})
            await websocket.send_json({
                "type": "state",
                "value": "listening"
            })

    except WebSocketDisconnect:
        print("Disconnected:", uid)