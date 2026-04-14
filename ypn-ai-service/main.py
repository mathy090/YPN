# main.py
# FastAPI WebSocket + HTTP API with:
# - Redis (double cache: request/response + session cache)
# - Supabase (persistent memory)
# - Firebase Admin (JWT verification)
# - Streaming AI responses

import os
import json
import asyncio
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import redis
import httpx

# Supabase
from supabase import create_client, Client

# Firebase Admin
import firebase_admin
from firebase_admin import credentials, auth

# ─────────────────────────────────────────────
# ENV
# ─────────────────────────────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
AI_API_URL = os.getenv("AI_API_URL")
AI_API_KEY = os.getenv("AI_API_KEY")

# Firebase
FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID")
FIREBASE_CLIENT_EMAIL = os.getenv("FIREBASE_CLIENT_EMAIL")
FIREBASE_PRIVATE_KEY = os.getenv("FIREBASE_PRIVATE_KEY")

# ─────────────────────────────────────────────
# INIT
# ─────────────────────────────────────────────
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Redis (double cache)
redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)

# Supabase
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Firebase init
firebase_admin.initialize_app(
    credentials.Certificate({
        "type": "service_account",
        "project_id": FIREBASE_PROJECT_ID,
        "private_key": FIREBASE_PRIVATE_KEY.replace("\\n", "\n"),
        "client_email": FIREBASE_CLIENT_EMAIL,
        "token_uri": "https://oauth2.googleapis.com/token",
    })
)

# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
def verify_token(token: str):
    try:
        decoded = auth.verify_id_token(token)
        return decoded
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")


def redis_session_key(session_id: str):
    return f"session:{session_id}"


def redis_response_key(text: str):
    return f"resp:{hash(text)}"


async def load_session(session_id: str):
    cached = redis_client.get(redis_session_key(session_id))
    if cached:
        return json.loads(cached)

    res = supabase.table("chat_sessions").select("*").eq("session_id", session_id).execute()

    if res.data:
        data = res.data[0]
        redis_client.set(redis_session_key(session_id), json.dumps(data), ex=3600)
        return data

    new_data = {
        "session_id": session_id,
        "messages": [],
        "emotion_state": "neutral"
    }

    supabase.table("chat_sessions").insert(new_data).execute()
    redis_client.set(redis_session_key(session_id), json.dumps(new_data), ex=3600)

    return new_data


async def save_session(session_id: str, data: dict):
    redis_client.set(redis_session_key(session_id), json.dumps(data), ex=3600)

    supabase.table("chat_sessions").upsert(data).execute()


# ─────────────────────────────────────────────
# AI STREAM (WITH CACHE)
# ─────────────────────────────────────────────
async def stream_ai(text: str):
    cache_key = redis_response_key(text)

    cached = redis_client.get(cache_key)
    if cached:
        for token in cached.split():
            yield token + " "
        return

    # Replace with real AI API call
    response = f"I understand. Let's take this step by step."

    redis_client.set(cache_key, response, ex=600)

    for token in response.split():
        await asyncio.sleep(0.05)
        yield token + " "


# ─────────────────────────────────────────────
# HTTP ENDPOINT (fallback)
# ─────────────────────────────────────────────
@app.post("/chat")
async def chat(request: Request):
    body = await request.json()

    token = body.get("token")
    message = body.get("message")
    session_id = body.get("session_id")

    verify_token(token)

    session = await load_session(session_id)

    session["messages"].append({"role": "user", "content": message})

    reply = ""
    async for token in stream_ai(message):
        reply += token

    session["messages"].append({"role": "ai", "content": reply})

    await save_session(session_id, session)

    return {"reply": reply}


# ─────────────────────────────────────────────
# WEBSOCKET (REALTIME)
# ─────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    try:
        while True:
            data = await ws.receive_json()

            token = data.get("token")
            session_id = data.get("session_id")
            msg_type = data.get("type")

            verify_token(token)

            session = await load_session(session_id)

            if msg_type == "text":
                user_text = data.get("message")

                session["messages"].append({
                    "role": "user",
                    "content": user_text
                })

                await ws.send_json({"type": "state", "value": "THINKING"})

                ai_text = ""

                async for token in stream_ai(user_text):
                    ai_text += token

                    await ws.send_json({
                        "type": "ai_token",
                        "text": token
                    })

                session["messages"].append({
                    "role": "ai",
                    "content": ai_text
                })

                await save_session(session_id, session)

                await ws.send_json({"type": "ai_done"})
                await ws.send_json({"type": "state", "value": "LISTENING"})

            elif msg_type == "interrupt":
                await ws.send_json({"type": "state", "value": "LISTENING"})

    except WebSocketDisconnect:
        pass