import os
import json
import time
import base64
import asyncio
import logging
import sys
import uuid

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse
from vosk import Model, KaldiRecognizer

from upstash_redis import Redis
from supabase import create_client

from retrievers import retrieve
from prompts import SYSTEM_PROMPT

# ── Logging Setup ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────
EXPRESS_BACKEND_URL = os.getenv("EXPRESS_BACKEND_URL")

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
logger.info("[init] Supabase client created")

# ── Vosk Model ────────────────────────────────────────────────────────────────
VOSK_MODEL_PATH = os.getenv("VOSK_MODEL_PATH", "models/vosk-model-small-en-us-0.15")
model = None

if os.path.isdir(VOSK_MODEL_PATH) and os.path.exists(os.path.join(VOSK_MODEL_PATH, "conf")):
    try:
        model = Model(VOSK_MODEL_PATH)
        logger.info("[VOSK] Model loaded successfully")
    except Exception as e:
        logger.error(f"[VOSK] Load error: {e}", exc_info=True)
        model = None
else:
    logger.warning(f"[VOSK] Model missing or invalid at: {VOSK_MODEL_PATH}")

app = FastAPI()
logger.info("[init] FastAPI app created")

# ── AI Stub (Replace with your real async provider) ───────────────────────────
async def run_ai(prompt: str):
    """Async generator yielding tokens. Replace with Cohere/OpenAI/etc."""
    logger.debug(f"[AI] Prompt received ({len(prompt)} chars)")
    await asyncio.sleep(0.2)  # Simulate latency
    return "I understand. I'm listening carefully and responding step by step."

# ── Redis Helpers ─────────────────────────────────────────────────────────────
def add_message(uid, role, text):
    key = f"chat:{uid}"
    try:
        data = redis.get(key)
        chat = json.loads(data) if data else []
        chat.append({"role": role, "text": text, "t": time.time()})
        chat = chat[-20:]  # Keep last 20 messages
        redis.set(key, json.dumps(chat))
        logger.debug(f"[redis] Added {role} message for uid={uid}, chat length: {len(chat)}")
        return chat
    except Exception as e:
        logger.error(f"[redis] Error in add_message: {e}", exc_info=True)
        return []

def get_chat(uid):
    try:
        data = redis.get(f"chat:{uid}")
        chat = json.loads(data) if data else []
        logger.debug(f"[redis] Retrieved {len(chat)} messages for uid={uid}")
        return chat
    except Exception as e:
        logger.error(f"[redis] Error in get_chat: {e}", exc_info=True)
        return []

def update_audio_time(uid):
    try:
        redis.set(f"last_audio:{uid}", time.time())
    except Exception as e:
        logger.error(f"[redis] Error updating audio time: {e}", exc_info=True)

def is_user_silent(uid, threshold=0.8):
    try:
        last = redis.get(f"last_audio:{uid}")
        if not last:
            return False
        return (time.time() - float(last)) > threshold
    except Exception as e:
        logger.error(f"[redis] Error checking silence: {e}", exc_info=True)
        return False

def build_prompt(uid, user_text):
    logger.info(f"[prompt] Building prompt for uid={uid}, user_text='{user_text[:50]}...'")
    try:
        chat = get_chat(uid)
        context = retrieve(user_text, chat)
        logger.debug(f"[prompt] Context retrieved: {context.get('meta', {})}")
        
        prompt = f"""
{SYSTEM_PROMPT}

Conversation:
{json.dumps(chat)}

Context:
{json.dumps(context)}

User:
{user_text}
"""
        logger.debug(f"[prompt] Final prompt length: {len(prompt)} chars")
        return prompt
    except Exception as e:
        logger.error(f"[prompt] Error building prompt: {e}", exc_info=True)
        # Fallback prompt
        return f"{SYSTEM_PROMPT}\n\nUser: {user_text}"

# ── 🔥 HTTP Chat Endpoint (Auth + Heartbeat Removed) ─────────────────────────
@app.post("/chat")
async def http_chat(request_body: dict):
    logger.info(f"[chat] POST /chat received: {request_body}")
    
    try:
        # Default to "anonymous" if no uid is provided by client
        uid = request_body.get("uid", "anonymous")
        user_text = request_body.get("message", "").strip()
        
        logger.info(f"[chat] Processing: uid={uid}, message_len={len(user_text)}")
        
        if not user_text:
            logger.warning("[chat] Empty message received")
            return JSONResponse(content={"reply": ""})

        # 1. Save user message
        add_message(uid, "user", user_text)
        
        # 2. Build prompt with context
        prompt = build_prompt(uid, user_text)
        
        # 3. Get AI Response
        logger.info("[chat] Calling AI provider...")
        response_text = await run_ai(prompt)
        logger.info(f"[chat] AI response received ({len(response_text)} chars)")
        
        # 4. Save AI Response
        add_message(uid, "ai", response_text)
        supabase.table("messages").insert({
            "user_id": uid,
            "role": "ai",
            "content": response_text.strip()
        }).execute()
        logger.info(f"[chat] Message persisted to Supabase for uid={uid}")
        
        return JSONResponse(content={"reply": response_text})
        
    except Exception as e:
        logger.error(f"[chat] CRITICAL ERROR: {type(e).__name__}: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"error": "Internal server error", "detail": str(e)}
        )

# ── WebSocket: Direct Connection (Auth Removed) ───────────────────────────────
@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    logger.info("[ws] New WebSocket connection accepted")

    # Generate a session ID for this connection
    uid = str(uuid.uuid4())[:8]
    recognizer = None
    pending_text = ""

    try:
        # Initialize chat & recognizer
        redis.setnx(f"chat:{uid}", json.dumps([]))
        if model:
            recognizer = KaldiRecognizer(model, 16000)
            logger.info(f"[ws] Vosk recognizer initialized for uid={uid}")
        else:
            logger.warning(f"[ws] Vosk model not available, speech recognition disabled for uid={uid}")

        # Notify client connection is ready
        await websocket.send_json({"type": "connected", "uid": uid})
        logger.info(f"[ws] Sent 'connected' signal to uid={uid}")

        # ── MAIN LOOP: Handle audio/text/interrupt ───────────────────────────
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            logger.debug(f"[ws] Received message type='{msg_type}' for uid={uid}")

            user_text = None

            # ── Text message ─────────────────────────────────────────────────
            if msg_type == "text":
                user_text = data.get("message", "").strip()
                logger.debug(f"[ws] Text input: '{user_text[:50]}...'")

            # ── Audio chunk (Vosk) ───────────────────────────────────────────
            elif msg_type == "audio" and recognizer:
                try:
                    pcm = base64.b64decode(data["audio"])
                    update_audio_time(uid)

                    if recognizer.AcceptWaveform(pcm):
                        res = json.loads(recognizer.Result())
                        user_text = res.get("text", "").strip()
                        logger.debug(f"[ws] Recognized final: '{user_text}'")
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
                            logger.debug(f"[ws] Auto-submitted partial: '{user_text}'")
                except Exception as e:
                    logger.error(f"[ws] Audio processing error: {e}", exc_info=True)

            # ── Interrupt (cancel current AI response) ───────────────────────
            elif msg_type == "interrupt":
                redis.set(f"interrupt:{uid}", "1")
                logger.debug(f"[ws] Interrupt signal received for uid={uid}")
                continue

            # Skip if no usable input
            if not user_text:
                continue

            # ── Process user input ───────────────────────────────────────────
            add_message(uid, "user", user_text)
            prompt = build_prompt(uid, user_text)

            await websocket.send_json({"type": "state", "value": "thinking"})

            # Stream AI response token-by-token
            logger.info(f"[ws] Generating AI response for uid={uid}")
            response = await run_ai(prompt)
            await websocket.send_json({"type": "state", "value": "speaking"})

            ai_text = ""
            for word in response.split():
                # Check for interrupt during streaming
                if redis.get(f"interrupt:{uid}") == "1":
                    redis.delete(f"interrupt:{uid}")
                    logger.debug(f"[ws] Interrupted AI response for uid={uid}")
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
                logger.info(f"[ws] AI response persisted for uid={uid}")

            await websocket.send_json({"type": "done"})
            await websocket.send_json({"type": "state", "value": "listening"})

    except WebSocketDisconnect:
        logger.info(f"[ws] Disconnected: uid={uid}")
    except Exception as e:
        logger.error(f"[ws] CRITICAL ERROR for uid={uid}: {type(e).__name__}: {e}", exc_info=True)
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except:
            pass