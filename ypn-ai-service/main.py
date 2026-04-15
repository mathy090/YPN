# main.py
import os
import json
import time
import base64
import asyncio
from collections import defaultdict, deque

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import firebase_admin
from firebase_admin import credentials, auth

from vosk import Model, KaldiRecognizer

from supabase import create_client

from memory import load_memory, append_message
from retrievers import retrieve
from prompts import SYSTEM_PROMPT


# ─────────────────────────────────────────────
# FIREBASE INIT
# ─────────────────────────────────────────────
cred_json = json.loads(os.getenv("FIREBASE_CREDENTIALS"))

if not firebase_admin._apps:
    firebase_admin.initialize_app(
        credentials.Certificate(cred_json)
    )


# ─────────────────────────────────────────────
# SUPABASE (TEXT ONLY STORAGE)
# ─────────────────────────────────────────────
supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_KEY")
)


# ─────────────────────────────────────────────
# VOSK MODEL (SMALL ENGLISH US)
# ─────────────────────────────────────────────
model = Model("models/vosk-small-en-us-0.15")


# ─────────────────────────────────────────────
# APP
# ─────────────────────────────────────────────
app = FastAPI()


# ─────────────────────────────────────────────
# SESSION STATE
# ─────────────────────────────────────────────
sessions = {}          # {uid: {interrupted: bool}}
memory_cache = {}      # {uid: memory}
recognizers = {}       # {uid: vosk recognizer}

rate_limit = defaultdict(lambda: deque(maxlen=5))


# ─────────────────────────────────────────────
# AUTH
# ─────────────────────────────────────────────
def verify_token(token: str):
    try:
        return auth.verify_id_token(token)
    except Exception as e:
        print("Auth error:", e)
        return None


# ─────────────────────────────────────────────
# RATE LIMIT (5 msgs / 10 sec)
# ─────────────────────────────────────────────
def is_rate_limited(uid: str):
    now = time.time()
    q = rate_limit[uid]

    while q and now - q[0] > 10:
        q.popleft()

    if len(q) >= 5:
        return True

    q.append(now)
    return False


# ─────────────────────────────────────────────
# AI ENGINE (REPLACE WITH GPT / GROQ)
# ─────────────────────────────────────────────
async def run_ai(prompt: str):
    await asyncio.sleep(0.2)
    return "I understand your message. Let's work through this step by step."


# ─────────────────────────────────────────────
# WEBSOCKET
# ─────────────────────────────────────────────
@app.websocket("/ws")
async def websocket(ws: WebSocket):
    await ws.accept()

    session_id = None

    try:
        # ── AUTH ─────────────────────────
        auth_data = await ws.receive_json()

        token = auth_data.get("token")
        user = verify_token(token) if token else None

        session_id = user["uid"] if user else "test_user"

        sessions[session_id] = {"interrupted": False}

        # ── INIT MEMORY ──────────────────
        if session_id not in memory_cache:
            memory_cache[session_id] = load_memory(session_id)

        # ── INIT VOSK RECOGNIZER ─────────
        recognizers[session_id] = KaldiRecognizer(model, 16000)

        recognizer = recognizers[session_id]

        # ────────────────────────────────
        # MAIN LOOP
        # ────────────────────────────────
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            user_text = None

            # ───────── TEXT INPUT ─────────
            if msg_type == "text":
                user_text = data.get("message", "").strip()

            # ───────── PCM AUDIO INPUT ─────
            elif msg_type == "audio":

                # PCM base64 → raw bytes
                pcm_bytes = base64.b64decode(data["audio"])

                if recognizer.AcceptWaveform(pcm_bytes):
                    result = json.loads(recognizer.Result())
                    user_text = result.get("text", "").strip()
                else:
                    partial = json.loads(recognizer.PartialResult())
                    await ws.send_json({
                        "type": "partial_transcript",
                        "text": partial.get("partial", "")
                    })
                    continue

            # ───────── INTERRUPT ───────────
            elif msg_type == "interrupt":
                sessions[session_id]["interrupted"] = True
                continue

            if not user_text:
                continue

            # ───────── RATE LIMIT ───────────
            if is_rate_limited(session_id):
                await ws.send_json({
                    "type": "error",
                    "message": "Too many requests. Slow down."
                })
                continue

            sessions[session_id]["interrupted"] = False

            # ───────── STORE USER TEXT ──────
            supabase.table("messages").insert({
                "user_id": session_id,
                "role": "user",
                "content": user_text
            }).execute()

            append_message(session_id, "user", user_text)

            # ───────── MEMORY CACHE ─────────
            memory_cache[session_id] = load_memory(session_id)

            context = retrieve(user_text, memory_cache[session_id])

            prompt = f"""
{SYSTEM_PROMPT}

Context:
{json.dumps(context)}

Memory:
{json.dumps(memory_cache[session_id])}

User:
{user_text}
"""

            await ws.send_json({"type": "state", "value": "thinking"})

            # ───────── AI RESPONSE ─────────
            response = await run_ai(prompt)

            await ws.send_json({"type": "state", "value": "speaking"})

            ai_text = ""

            for word in response.split():
                if sessions[session_id]["interrupted"]:
                    break

                await asyncio.sleep(0.03)

                ai_text += word + " "

                await ws.send_json({
                    "type": "ai_token",
                    "text": word + " "
                })

            # ───────── STORE AI TEXT ────────
            supabase.table("messages").insert({
                "user_id": session_id,
                "role": "ai",
                "content": ai_text
            }).execute()

            append_message(session_id, "ai", ai_text)

            memory_cache[session_id] = load_memory(session_id)

            await ws.send_json({"type": "ai_done"})
            await ws.send_json({"type": "state", "value": "listening"})


    except WebSocketDisconnect:
        print(f"Disconnected: {session_id}")

    except Exception as e:
        print("Error:", e)

    finally:
        if session_id:
            sessions.pop(session_id, None)
            memory_cache.pop(session_id, None)
            recognizers.pop(session_id, None)