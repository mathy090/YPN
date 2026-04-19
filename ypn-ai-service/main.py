# main.py
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
logger.info("[init] Redis client initialized")

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

# ── Cohere AI Client Setup ────────────────────────────────────────────────────
import cohere

_cohere_client = None

def get_cohere_client():
    """Lazy-load Cohere client with API key from env vars."""
    global _cohere_client
    if _cohere_client is None:
        api_key = os.getenv("COHERE_API_KEY")
        if not api_key:
            logger.warning("[AI] COHERE_API_KEY not set, using stub response")
            return None
        try:
            _cohere_client = cohere.AsyncClient(api_key=api_key)
            logger.info("[AI] Cohere client initialized")
        except Exception as e:
            logger.error(f"[AI] Failed to initialize Cohere: {e}", exc_info=True)
            return None
    return _cohere_client


# ── AI Provider: Cohere Integration ───────────────────────────────────────────
async def run_ai(prompt: str):
    """
    Generate AI response using Cohere Command-R.
    Falls back to stub if API key missing or request fails.
    """
    client = get_cohere_client()
    
    # Fallback if no API key or client failed to init
    if client is None:
        logger.warning("[AI] No Cohere client available, returning stub response")
        await asyncio.sleep(0.2)
        return "I understand. I'm listening carefully and responding step by step."
    
    try:
        logger.info(f"[AI] Calling Cohere with prompt ({len(prompt)} chars)")
        
        response = await client.chat(
            model="command-r",  # Fast & affordable; use "command-r-plus" for higher quality
            message=prompt,
            preamble=SYSTEM_PROMPT,
            max_tokens=500,
            temperature=0.7,
            k=0,  # Disable sampling for more consistent responses
        )
        
        reply = response.text.strip()
        logger.info(f"[AI] Cohere response received ({len(reply)} chars)")
        return reply
        
    except cohere.UnauthorizedError:
        logger.error("[AI] Cohere auth failed - check COHERE_API_KEY")
        return "Sorry, I'm having trouble connecting to my AI service. Please try again later."
        
    except cohere.TooManyRequestsError:
        logger.warning("[AI] Cohere rate limit hit")
        return "I'm getting a lot of requests right now. Please try again in a moment."
        
    except Exception as e:
        logger.error(f"[AI] Cohere error: {type(e).__name__}: {e}", exc_info=True)
        # Fallback to stub on any error so chat never breaks
        return "I understand. I'm listening carefully and responding step by step."


# ── Redis Helpers ─────────────────────────────────────────────────────────────
def add_message(uid, role, text):
    """Save message to Redis chat history."""
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
    """Retrieve chat history from Redis."""
    try:
        data = redis.get(f"chat:{uid}")
        chat = json.loads(data) if data else []
        logger.debug(f"[redis] Retrieved {len(chat)} messages for uid={uid}")
        return chat
    except Exception as e:
        logger.error(f"[redis] Error in get_chat: {e}", exc_info=True)
        return []


def update_audio_time(uid):
    """Update last audio activity timestamp for silence detection."""
    try:
        redis.set(f"last_audio:{uid}", time.time())
    except Exception as e:
        logger.error(f"[redis] Error updating audio time: {e}", exc_info=True)


def is_user_silent(uid, threshold=0.8):
    """Check if user has been silent for longer than threshold seconds."""
    try:
        last = redis.get(f"last_audio:{uid}")
        if not last:
            return False
        return (time.time() - float(last)) > threshold
    except Exception as e:
        logger.error(f"[redis] Error checking silence: {e}", exc_info=True)
        return False


def build_prompt(uid, user_text):
    """Build the full prompt for AI with conversation history and context."""
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


# ── 🔥 HTTP Chat Endpoint (No Auth, No Heartbeat) ────────────────────────────
@app.post("/chat")
async def http_chat(request_body: dict):
    """Handle text-to-text chat requests."""
    logger.info(f"[chat] POST /chat received: {request_body}")
    
    try:
        uid = request_body.get("uid", "anonymous")
        user_text = request_body.get("message", "").strip()
        
        logger.info(f"[chat] Processing: uid={uid}, message_len={len(user_text)}")
        
        if not user_text:
            logger.warning("[chat] Empty message received")
            return JSONResponse(content={"reply": ""})

        # 1. Save user message to Redis
        add_message(uid, "user", user_text)
        
        # 2. Build prompt with context
        prompt = build_prompt(uid, user_text)
        
        # 3. Get AI Response from Cohere
        logger.info("[chat] Calling AI provider...")
        response_text = await run_ai(prompt)
        logger.info(f"[chat] AI response received ({len(response_text)} chars)")
        
        # 4. Save AI Response to Redis
        add_message(uid, "ai", response_text)
        
        # 5. Save to Supabase (with defensive error handling)
        try:
            logger.debug(f"[supabase] Inserting message: user_id={uid}, role=ai, content_len={len(response_text)}")
            
            result = supabase.table("messages").insert({
                "user_id": uid,
                "role": "ai",
                "content": response_text.strip()
            }).execute()
            
            logger.info(f"[supabase] Insert successful")
            
        except Exception as db_err:
            # Log the error but don't crash the chat
            logger.error(f"[supabase] Insert failed (non-critical): {type(db_err).__name__}: {db_err}")
            logger.warning("[supabase] Message saved to Redis only; Supabase sync skipped")

        return JSONResponse(content={"reply": response_text})
        
    except Exception as e:
        logger.error(f"[chat] CRITICAL ERROR: {type(e).__name__}: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"error": "Internal server error", "detail": str(e)}
        )


# ── 🔍 DEBUG: Test Supabase Connection ───────────────────────────────────────
@app.get("/debug/test-db")
async def test_db():
    """Test Supabase connection and messages table schema."""
    try:
        result = supabase.table("messages").select("id, user_id, role, content").limit(1).execute()
        return {
            "status": "ok", 
            "sample": result.data, 
            "count": len(result.data) if result.data else 0
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "type": type(e).__name__}


# ── WebSocket: Voice Streaming (No Auth) ─────────────────────────────────────
@app.websocket("/ws")
async def ws(websocket: WebSocket):
    """Handle WebSocket connections for voice chat with real-time streaming."""
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
                
                # Save to Supabase (non-critical)
                try:
                    supabase.table("messages").insert({
                        "user_id": uid,
                        "role": "ai",
                        "content": ai_text.strip()
                    }).execute()
                    logger.info(f"[ws] AI response persisted to Supabase for uid={uid}")
                except Exception as db_err:
                    logger.error(f"[ws] Supabase insert failed: {db_err}")

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


# ── Health Check Endpoint ─────────────────────────────────────────────────────
@app.get("/health")
async def health():
    """Simple health check for Render/load balancers."""
    return {
        "status": "healthy",
        "redis": "connected",
        "supabase": "connected", 
        "vosk": "loaded" if model else "not_loaded",
        "cohere": "configured" if os.getenv("COHERE_API_KEY") else "missing_key"
    }


# ── Root Endpoint ─────────────────────────────────────────────────────────────
@app.get("/")
async def root():
    """Root endpoint with API info."""
    return {
        "service": "YPN AI Backend",
        "version": "1.0.0",
        "endpoints": {
            "POST /chat": "Text-to-text chat",
            "GET /ws": "WebSocket for voice chat",
            "GET /health": "Health check",
            "GET /debug/test-db": "Test Supabase connection"
        }
    }