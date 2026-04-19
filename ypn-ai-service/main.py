# ypn-ai-service/main.py
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
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

# ── Enhanced System Prompt with Creator Info & Name Handling ──────────────────
SYSTEM_PROMPT = (
    "You are YPN AI, a warm and helpful assistant for Team YPN — "
    "a youth empowerment network based in Zimbabwe. "
    "Be concise, helpful, and natural like ChatGPT. "
    "Avoid long explanations unless asked.\n\n"
    "--- CREATOR INFO (Respond when asked 'who made you', 'creator', 'who created you') ---\n"
    "I was created by Mathews Tafadzwa Runowanda, born 21 April 2006. "
    "He created me as a side project while learning at Cheziga Gokwe High School in September 2024. "
    "His vision is to help bring youths close together, form networks for sharing ideas, "
    "and support mental well-being and counselling.\n\n"
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
cache: dict = {}     # In-memory cache for repeated questions

# FastAPI app
app = FastAPI()

# Allow all CORS (for frontend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request model with email for session isolation ────────────────────────────
class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
    email: str = ""  # 🔥 Primary identifier for isolation


# ── Redis Helpers (Email-First) ───────────────────────────────────────────────
def _get_redis_key(email: str, session_id: str = "") -> str:
    """Generate unique Redis key using email (primary) or session_id (fallback)."""
    identifier = email.strip().lower() if email else session_id.strip()
    # Sanitize for Redis key
    safe_id = identifier.replace("@", "_at_").replace(".", "_dot_").replace(":", "_")
    return f"session:{safe_id}"


def _get_name_redis_key(email: str, session_id: str = "") -> str:
    """Generate unique name storage key using email (primary)."""
    identifier = email.strip().lower() if email else session_id.strip()
    safe_id = identifier.replace("@", "_at_").replace(".", "_dot_").replace(":", "_")
    return f"name:{safe_id}"


def _get_session_from_redis(email: str, session_id: str = "") -> list:
    """Load session history from Redis using email (primary)."""
    if not redis:
        identifier = email if email else session_id
        return sessions.get(identifier, [])
    try:
        key = _get_redis_key(email, session_id)
        data = redis.get(key)
        return json.loads(data) if data else []
    except Exception as e:
        logger.error(f"[redis] Error loading session: {e}")
        identifier = email if email else session_id
        return sessions.get(identifier, [])


def _save_session_to_redis(email: str, history: list, session_id: str = ""):
    """Save session history to Redis with 24h TTL using email (primary)."""
    if not redis:
        identifier = email if email else session_id
        sessions[identifier] = history
        return
    try:
        key = _get_redis_key(email, session_id)
        redis.set(key, json.dumps(history), ex=86400)  # 24 hours
    except Exception as e:
        logger.error(f"[redis] Error saving session: {e}")
        identifier = email if email else session_id
        sessions[identifier] = history


def _get_user_name(email: str, session_id: str = "") -> str:
    """Get stored user name from Redis using email (primary)."""
    if not redis:
        return ""
    try:
        key = _get_name_redis_key(email, session_id)
        name = redis.get(key)
        return name if name else ""
    except Exception as e:
        logger.error(f"[redis] Error getting name: {e}")
        return ""


def _save_user_name(email: str, name: str, session_id: str = ""):
    """Save user name to Redis with 7-day TTL using email (primary)."""
    if not redis:
        return
    try:
        key = _get_name_redis_key(email, session_id)
        redis.set(key, name, ex=604800)  # 7 days
        identifier = email if email else session_id
        logger.debug(f"[redis] Saved name '{name}' for {identifier}")
    except Exception as e:
        logger.error(f"[redis] Error saving name: {e}")


# ── Supabase Helpers (Email-First, Schema-Compatible) ─────────────────────────
def _log_message_to_supabase(email: str, role: str, content: str, session_id: str = ""):
    """
    Persist message to Supabase using email as primary identifier.
    Uses columns: email (new), user_id (fallback), role, content.
    """
    if not supabase:
        return
    try:
        # 🔥 Use email as primary identifier, fallback to session_id for user_id
        identifier = email.strip().lower() if email else session_id.strip()
        
        supabase.table("messages").insert({
            "email": email if email else None,  # 🔥 New column for isolation
            "user_id": identifier,               # Fallback for backward compat
            "role": role,
            "content": content.strip()
        }).execute()
        logger.debug(f"[supabase] Logged {role} message for {identifier}")
    except Exception as e:
        logger.error(f"[supabase] Insert failed (non-critical): {e}")


# ── Helper: Build messages for Cohere ─────────────────────────────────────────
def build_messages(history: list, message: str) -> list:
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    msgs.extend(history)
    msgs.append({"role": "user", "content": message})
    return msgs


# ── Helper: Cache key generator (Email-First) ─────────────────────────────────
def cache_key(email: str, message: str, history: list, session_id: str = "") -> str:
    """Generate cache key using email (primary) for isolation."""
    identifier = email.strip().lower() if email else session_id.strip()
    raw = identifier + message + json.dumps(history, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()


# ── Helper: Extract name from user message ────────────────────────────────────
def extract_name_from_message(message: str) -> str:
    """
    Simple heuristic to extract name if user says 'my name is X' or 'I am X'.
    Returns empty string if no name detected.
    """
    message_lower = message.lower()
    
    if "my name is" in message_lower:
        parts = message_lower.split("my name is")
        if len(parts) > 1:
            name = parts[1].strip().split()[0].capitalize()
            return name.rstrip(".,!?")
    
    if "i am " in message_lower or "i'm " in message_lower:
        marker = "i am " if "i am " in message_lower else "i'm "
        parts = message_lower.split(marker)
        if len(parts) > 1:
            name = parts[1].strip().split()[0].capitalize()
            return name.rstrip(".,!?")
    
    if "call me " in message_lower:
        parts = message_lower.split("call me ")
        if len(parts) > 1:
            name = parts[1].strip().split()[0].capitalize()
            return name.rstrip(".,!?")
    
    return ""


# ── Helper: Trim history ──────────────────────────────────────────────────────
def _trim_history(history: list, limit: int = 6) -> list:
    """Trim history to last N turns (user+assistant = 1 turn)."""
    return history[-limit:] if len(history) > limit else history


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


# Normal chat endpoint (JSON) - Email-First Isolation
@app.post("/chat")
async def chat(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"
    email = req.email.strip().lower() if req.email else ""  # 🔥 Primary identifier

    if not message:
        raise HTTPException(400, "Message cannot be empty")

    # 🔥 Use email as primary identifier for all operations
    identifier = email if email else session_id

    # Get stored user name using email (primary)
    user_name = _get_user_name(email, session_id)
    
    # Check if user is providing their name
    extracted_name = extract_name_from_message(message)
    if extracted_name:
        _save_user_name(email, extracted_name, session_id)
        user_name = extracted_name
        logger.info(f"[chat] Captured name '{user_name}' for {identifier}")

    # Load history from Redis using email (primary)
    history = _get_session_from_redis(email, session_id)
    history = _trim_history(history)

    # Cache key uses email (primary) for isolation
    key = cache_key(email, message, history, session_id)

    # Return cached reply if available
    if key in cache:
        logger.debug(f"[chat] Cache hit for {identifier}")
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

        # Save to Redis using email (primary)
        _save_session_to_redis(email, history, session_id)

        # Log to Supabase using email as primary identifier
        _log_message_to_supabase(email, "user", message, session_id)
        _log_message_to_supabase(email, "assistant", reply, session_id)

        # Cache result (email-isolated)
        cache[key] = reply

        return {"reply": reply, "cached": False, "user_name": user_name}

    except Exception as e:
        logger.error(f"[chat] Error: {type(e).__name__}: {e}")
        raise HTTPException(500, str(e))


# Streaming chat endpoint (Email-First Isolation)
@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"
    email = req.email.strip().lower() if req.email else ""

    if not message:
        raise HTTPException(400, "Message cannot be empty")

    # 🔥 Use email as primary identifier
    identifier = email if email else session_id

    # Get stored user name using email (primary)
    user_name = _get_user_name(email, session_id)
    
    # Check if user is providing their name
    extracted_name = extract_name_from_message(message)
    if extracted_name:
        _save_user_name(email, extracted_name, session_id)
        user_name = extracted_name

    # Load history from Redis using email (primary)
    history = _get_session_from_redis(email, session_id)
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

            # Save session after streaming ends using email (primary)
            history.append({"role": "user", "content": message})
            history.append({"role": "assistant", "content": full_text})
            history = history[-20:]
            _save_session_to_redis(email, history, session_id)

            # Log to Supabase using email as primary identifier
            _log_message_to_supabase(email, "user", message, session_id)
            _log_message_to_supabase(email, "assistant", full_text, session_id)

        except Exception as e:
            logger.error(f"[stream] Error: {e}")
            yield "⚠️ Error: " + str(e)

    return StreamingResponse(generate(), media_type="text/plain")


# Clear session (Email-First)
@app.delete("/chat/{session_id}")
async def clear_session(session_id: str, email: str = ""):
    email = email.strip().lower() if email else ""
    identifier = email if email else session_id
    
    if redis:
        try:
            redis.delete(_get_redis_key(email, session_id))
            redis.delete(_get_name_redis_key(email, session_id))
        except Exception as e:
            logger.error(f"[redis] Error clearing session: {e}")
    else:
        sessions.pop(identifier, None)
    
    logger.info(f"[chat] Session cleared: {identifier}")
    return {"cleared": identifier}


# ------------------- Background Tasks -------------------

async def cleanup_cache():
    """Periodic cache cleanup every 10 minutes."""
    while True:
        await asyncio.sleep(600)
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