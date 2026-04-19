# ypn-ai-service/main.py
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os
import cohere
import asyncio
import hashlib
import json
import time
import logging
import sys

# ── Logging Setup ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

# ── Configuration ─────────────────────────────────────────────────────────────
COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY is not set")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
UPSTASH_REDIS_URL = os.getenv("UPSTASH_REDIS_REST_URL")
UPSTASH_REDIS_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN")

# ── Initialize Cohere V2 client ───────────────────────────────────────────────
co = cohere.ClientV2(api_key=COHERE_API_KEY)
logger.info("[init] Cohere V2 client initialized")

# Use latest supported model
MODEL = "command-r-plus-08-2024"

# ──  Enhanced System Prompt with Name Handling ─────────────────────────────
SYSTEM_PROMPT = (
    "You are YPN AI, a warm and helpful assistant for Team YPN — "
    "a youth empowerment network based in Zimbabwe. "
    "Be concise, helpful, and natural like ChatGPT. "
    "Avoid long explanations unless asked.\n\n"
    "--- NAME HANDLING RULES ---\n"
    "1. If the user greets you (e.g., 'hello', 'hi', 'hey') and you DON'T know their name yet, "
    "   respond warmly and ASK for their name. Example: 'Hello! 👋 I'm YPN AI. What's your name?'\n"
    "2. Once you learn the user's name, REMEMBER it for the entire conversation.\n"
    "3. ALWAYS start your replies with the user's name followed by a comma, then your message. "
    "   Example: 'John, I'd be happy to help you with that!'\n"
    "4. If the user tells you their name, acknowledge it warmly. Example: 'Nice to meet you, Sarah! 🎉'\n"
    "5. Be friendly and use the name naturally — don't force it if it doesn't fit.\n"
    "6. Keep responses concise (2-3 sentences max) unless the user asks for more detail.\n"
    "--- END RULES ---"
)

# ── Initialize Redis (Upstash) ────────────────────────────────────────────────
from upstash_redis import Redis

redis = None
if UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN:
    try:
        redis = Redis(url=UPSTASH_REDIS_URL, token=UPSTASH_REDIS_TOKEN)
        logger.info("[init] Redis client initialized")
    except Exception as e:
        logger.error(f"[init] Redis connection failed: {e}")
else:
    logger.warning("[init] Redis credentials not set, using in-memory fallback")

# ── Initialize Supabase ───────────────────────────────────────────────────────
if SUPABASE_URL and SUPABASE_KEY:
    try:
        from supabase import create_client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        logger.info("[init] Supabase client initialized")
    except Exception as e:
        logger.error(f"[init] Supabase connection failed: {e}")
        supabase = None
else:
    logger.warning("[init] Supabase credentials not set, persistence disabled")
    supabase = None

# ── In-memory fallback for Redis (if Redis unavailable) ───────────────────────
sessions: dict = {}  # Fallback only
cache: dict = {}     # In-memory cache for repeated questions (kept as-is)

# FastAPI app
app = FastAPI()

# Allow all CORS (for frontend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request model
class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"


# ── Redis Helpers ─────────────────────────────────────────────────────────────
def _get_redis_key(session_id: str) -> str:
    return f"session:{session_id}"


def _get_name_redis_key(session_id: str) -> str:
    return f"name:{session_id}"


def _get_session_from_redis(session_id: str) -> list:
    """Load session history from Redis."""
    if not redis:
        return sessions.get(session_id, [])
    
    try:
        data = redis.get(_get_redis_key(session_id))
        return json.loads(data) if data else []
    except Exception as e:
        logger.error(f"[redis] Error loading session: {e}")
        return sessions.get(session_id, [])


def _save_session_to_redis(session_id: str, history: list):
    """Save session history to Redis with 24h TTL."""
    if not redis:
        sessions[session_id] = history
        return
    
    try:
        key = _get_redis_key(session_id)
        redis.set(key, json.dumps(history), ex=86400)  # 24 hours
    except Exception as e:
        logger.error(f"[redis] Error saving session: {e}")
        sessions[session_id] = history  # Fallback to memory


def _get_user_name(session_id: str) -> str:
    """Get stored user name from Redis."""
    if not redis:
        return ""
    try:
        name = redis.get(_get_name_redis_key(session_id))
        return name if name else ""
    except Exception as e:
        logger.error(f"[redis] Error getting name: {e}")
        return ""


def _save_user_name(session_id: str, name: str):
    """Save user name to Redis with 7-day TTL."""
    if not redis:
        return
    try:
        redis.set(_get_name_redis_key(session_id), name, ex=604800)  # 7 days
        logger.debug(f"[redis] Saved name '{name}' for session={session_id}")
    except Exception as e:
        logger.error(f"[redis] Error saving name: {e}")


# ── Supabase Helpers ──────────────────────────────────────────────────────────
def _log_message_to_supabase(session_id: str, role: str, content: str, user_name: str = None):
    """Persist message to Supabase (non-critical, defensive)."""
    if not supabase:
        return
    
    try:
        supabase.table("messages").insert({
            "user_id": session_id,
            "role": role,
            "content": content.strip(),
            "metadata": {"user_name": user_name} if user_name else {}
        }).execute()
        logger.debug(f"[supabase] Logged {role} message for session={session_id}")
    except Exception as e:
        logger.error(f"[supabase] Insert failed (non-critical): {e}")


# ── Helper: build messages for Cohere ─────────────────────────────────────────
def build_messages(history: list, message: str) -> list:
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    msgs.extend(history)
    msgs.append({"role": "user", "content": message})
    return msgs


# ── Helper: cache key generator ───────────────────────────────────────────────
def cache_key(session_id: str, message: str, history: list) -> str:
    raw = session_id + message + json.dumps(history, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()


# ── Helper: Extract name from user message ────────────────────────────────────
def extract_name_from_message(message: str) -> str:
    """
    Simple heuristic to extract name if user says 'my name is X' or 'I am X'.
    Returns empty string if no name detected.
    """
    message_lower = message.lower()
    
    # Pattern: "my name is [name]"
    if "my name is" in message_lower:
        parts = message_lower.split("my name is")
        if len(parts) > 1:
            name = parts[1].strip().split()[0].capitalize()
            return name.rstrip(".,!?")
    
    # Pattern: "I am [name]" or "I'm [name]"
    if "i am " in message_lower or "i'm " in message_lower:
        marker = "i am " if "i am " in message_lower else "i'm "
        parts = message_lower.split(marker)
        if len(parts) > 1:
            name = parts[1].strip().split()[0].capitalize()
            return name.rstrip(".,!?")
    
    # Pattern: "call me [name]"
    if "call me " in message_lower:
        parts = message_lower.split("call me ")
        if len(parts) > 1:
            name = parts[1].strip().split()[0].capitalize()
            return name.rstrip(".,!?")
    
    return ""


# ------------------- Endpoints -------------------

@app.get("/")
async def root():
    return {
        "status": "⚡ YPN AI FAST MODE",
        "redis": "connected" if redis else "fallback",
        "supabase": "connected" if supabase else "disabled"
    }


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL,
        "redis": "connected" if redis else "fallback",
        "supabase": "connected" if supabase else "disabled",
        "cache_size": len(cache),
    }


# Normal chat endpoint (JSON)
@app.post("/chat")
async def chat(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"

    if not message:
        raise HTTPException(400, "Message cannot be empty")

    # Get stored user name
    user_name = _get_user_name(session_id)
    
    # Check if user is providing their name
    extracted_name = extract_name_from_message(message)
    if extracted_name:
        _save_user_name(session_id, extracted_name)
        user_name = extracted_name
        logger.info(f"[chat] Captured user name '{user_name}' for session={session_id}")

    # Load history from Redis (or memory fallback)
    history = _get_session_from_redis(session_id)
    history = _trim_history(history)

    key = cache_key(session_id, message, history)

    # Return cached reply if available
    if key in cache:
        logger.debug(f"[chat] Cache hit for session={session_id}")
        return {"reply": cache[key], "cached": True, "user_name": user_name}

    try:
        response = co.chat(
            model=MODEL,
            messages=build_messages(history, message),
            temperature=0.7,
            max_tokens=200,
        )

        reply = response.message.content[0].text.strip()

        # Update session history
        history.append({"role": "user", "content": message})
        history.append({"role": "assistant", "content": reply})
        history = history[-20:]

        # Save to Redis (or memory fallback)
        _save_session_to_redis(session_id, history)

        # Log to Supabase (non-critical)
        _log_message_to_supabase(session_id, "user", message, user_name)
        _log_message_to_supabase(session_id, "assistant", reply, user_name)

        # Cache result
        cache[key] = reply

        return {"reply": reply, "cached": False, "user_name": user_name}

    except Exception as e:
        logger.error(f"[chat] Error: {type(e).__name__}: {e}")
        raise HTTPException(500, str(e))


# Streaming chat endpoint (ChatGPT-like)
@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"

    if not message:
        raise HTTPException(400, "Message cannot be empty")

    # Get stored user name
    user_name = _get_user_name(session_id)
    
    # Check if user is providing their name
    extracted_name = extract_name_from_message(message)
    if extracted_name:
        _save_user_name(session_id, extracted_name)
        user_name = extracted_name
        logger.info(f"[stream] Captured user name '{user_name}' for session={session_id}")

    # Load history from Redis (or memory fallback)
    history = _get_session_from_redis(session_id)
    history = _trim_history(history)

    async def generate():
        full_text = ""

        try:
            stream = co.chat_stream(
                model=MODEL,
                messages=build_messages(history, message),
                temperature=0.7,
                max_tokens=200,
            )

            for event in stream:
                if event.type == "content-delta":
                    chunk = event.delta.message.content.text
                    if chunk:
                        full_text += chunk
                        yield chunk
                        await asyncio.sleep(0.01)

            # Save session after streaming ends
            history.append({"role": "user", "content": message})
            history.append({"role": "assistant", "content": full_text})
            history = history[-20:]
            _save_session_to_redis(session_id, history)

            # Log to Supabase (non-critical)
            _log_message_to_supabase(session_id, "user", message, user_name)
            _log_message_to_supabase(session_id, "assistant", full_text, user_name)

        except Exception as e:
            logger.error(f"[stream] Error: {e}")
            yield "⚠️ Error: " + str(e)

    return StreamingResponse(generate(), media_type="text/plain")


# Clear session (including stored name)
@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    if redis:
        try:
            redis.delete(_get_redis_key(session_id))
            redis.delete(_get_name_redis_key(session_id))
        except Exception as e:
            logger.error(f"[redis] Error clearing session: {e}")
    else:
        sessions.pop(session_id, None)
    
    logger.info(f"[chat] Session cleared: {session_id}")
    return {"cleared": session_id}


# ── Helper: trim history ──────────────────────────────────────────────────────
def _trim_history(history: list, limit: int = 6) -> list:
    """Trim history to last N turns (user+assistant = 1 turn)."""
    return history[-limit:] if len(history) > limit else history


# ------------------- Background Tasks -------------------

# Periodic cache cleanup
async def cleanup_cache():
    while True:
        await asyncio.sleep(600)  # every 10 minutes
        cache.clear()
        logger.info("🧹 In-memory cache cleared")


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_cache())
    logger.info("🚀 YPN AI Backend started")


# ------------------- Run -------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")