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

load_dotenv()

# ── Configuration ─────────────────────────────────────────────────────────────
COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY is not set")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
UPSTASH_REDIS_URL = os.getenv("UPSTASH_REDIS_REST_URL")
UPSTASH_REDIS_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN")

co = cohere.ClientV2(api_key=COHERE_API_KEY)
logger.info("[init] Cohere V2 client initialized")

MODEL = "command-r-plus-08-2024"

# ── Initialize Redis ──────────────────────────────────────────────────────────
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
supabase = None
if SUPABASE_URL and SUPABASE_KEY:
    try:
        from supabase import create_client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        logger.info("[init] Supabase client initialized")
    except Exception as e:
        logger.error(f"[init] Supabase connection failed: {e}")
else:
    logger.warning("[init] Supabase credentials not set, persistence disabled")

# ── In-memory fallbacks ───────────────────────────────────────────────────────
sessions: dict = {}
cache: dict = {}

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request model — username field added, everything else unchanged ────────────
class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
    email: str = ""
    username: str = ""  # sent from device SQLite cache via TeamYPN.tsx


# ── Redis key helpers ─────────────────────────────────────────────────────────
def _get_redis_key(email: str, session_id: str = "") -> str:
    if email:
        identifier = email.strip().lower()
    else:
        # hash so different devices don't share one key when no email available
        identifier = f"anon_{hashlib.md5(session_id.strip().encode()).hexdigest()[:12]}"
    safe_id = identifier.replace("@", "_at_").replace(".", "_dot_").replace(":", "_")
    return f"session:{safe_id}"


def _get_name_redis_key(email: str, session_id: str = "") -> str:
    if email:
        identifier = email.strip().lower()
    else:
        identifier = f"anon_{hashlib.md5(session_id.strip().encode()).hexdigest()[:12]}"
    safe_id = identifier.replace("@", "_at_").replace(".", "_dot_").replace(":", "_")
    return f"name:{safe_id}"


def _get_session_from_redis(email: str, session_id: str = "") -> list:
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
    if not redis:
        identifier = email if email else session_id
        sessions[identifier] = history
        return
    try:
        key = _get_redis_key(email, session_id)
        redis.set(key, json.dumps(history), ex=86400)
    except Exception as e:
        logger.error(f"[redis] Error saving session: {e}")
        identifier = email if email else session_id
        sessions[identifier] = history


def _get_user_name(email: str, session_id: str = "") -> str:
    """Check Redis cache for stored username."""
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
    """Persist username to Redis with 7-day TTL."""
    if not redis:
        return
    try:
        key = _get_name_redis_key(email, session_id)
        redis.set(key, name, ex=604800)
        identifier = email if email else session_id
        logger.debug(f"[redis] Saved name '{name}' for {identifier}")
    except Exception as e:
        logger.error(f"[redis] Error saving name: {e}")


# ── Supabase username lookup — last resort only ───────────────────────────────
def _sync_username_lookup(email: str) -> str:
    """Synchronous Supabase query — run in executor to avoid blocking."""
    if not supabase or not email:
        return ""
    try:
        result = (
            supabase.table("users")
            .select("username")
            .eq("email", email.strip().lower())
            .limit(1)
            .execute()
        )
        if result.data and len(result.data) > 0:
            return result.data[0].get("username", "")
    except Exception as e:
        logger.error(f"[supabase] username lookup failed: {e}")
    return ""


async def get_username_from_supabase(email: str) -> str:
    """Async wrapper — keeps FastAPI event loop unblocked."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _sync_username_lookup, email)


# ── Name resolution — priority order ─────────────────────────────────────────
# 1. Redis cache (no network, instant)
# 2. Username sent directly from device SQLite (no network, instant)
# 3. Supabase lookup (network, only if Redis expired and device sent no username)
# 4. Extract from message text (last resort)
async def resolve_username(
    email: str,
    session_id: str,
    device_username: str,
    message: str,
) -> str:
    # 1. Redis cache hit
    user_name = _get_user_name(email, session_id)
    if user_name:
        logger.debug(f"[name] Redis cache hit: '{user_name}'")
        return user_name

    # 2. Device sent username directly from SQLite — fastest path, no DB call
    if device_username:
        user_name = device_username.strip()
        _save_user_name(email, user_name, session_id)
        logger.info(f"[name] From device SQLite: '{user_name}'")
        return user_name

    # 3. Supabase — only if email available and Redis expired
    if email:
        user_name = await get_username_from_supabase(email)
        if user_name:
            _save_user_name(email, user_name, session_id)
            logger.info(f"[name] From Supabase: '{user_name}'")
            return user_name

    # 4. Text extraction — user typed their name in the message
    extracted = extract_name_from_message(message)
    if extracted:
        _save_user_name(email, extracted, session_id)
        logger.info(f"[name] Extracted from message: '{extracted}'")
        return extracted

    return ""


# ── Dynamic system prompt — name injected per request ────────────────────────
def build_system_prompt(username: str = "") -> str:
    if username:
        name_rule = (
            f"The user's name is {username}. "
            f"Always address them as {username} naturally in your replies."
        )
    else:
        name_rule = (
            "You don't know the user's name yet. "
            "Ask for it warmly on the first greeting."
        )

    return (
        f"You are YPN AI, a warm and helpful assistant for Team YPN — "
        f"a youth empowerment network based in Zimbabwe. "
        f"Be concise, helpful, and natural like ChatGPT. "
        f"Avoid long explanations unless asked.\n\n"
        f"--- CREATOR INFO ---\n"
        f"I was created by Mathews Tafadzwa Runowanda, born 21 April 2006. "
        f"He created me as a side project while learning at Cheziga Gokwe High School in September 2024. "
        f"His vision is to help bring youths close together, form networks for sharing ideas, "
        f"and support mental well-being and counselling.\n\n"
        f"--- NAME RULES ---\n"
        f"{name_rule}\n"
        f"Keep responses concise (2-3 sentences max) unless the user asks for more detail.\n"
        f"--- END RULES ---"
    )


def build_messages(history: list, message: str, username: str = "") -> list:
    msgs = [{"role": "system", "content": build_system_prompt(username)}]
    msgs.extend(history)
    msgs.append({"role": "user", "content": message})
    return msgs


# ── Cache key — email-first for isolation ─────────────────────────────────────
def cache_key(email: str, message: str, history: list, session_id: str = "") -> str:
    identifier = email.strip().lower() if email else session_id.strip()
    raw = identifier + message + json.dumps(history, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()


# ── Name extraction from message text ─────────────────────────────────────────
def extract_name_from_message(message: str) -> str:
    message_lower = message.lower()

    for marker in ["my name is ", "i am ", "i'm ", "call me "]:
        if marker in message_lower:
            parts = message_lower.split(marker)
            if len(parts) > 1:
                name = parts[1].strip().split()[0].capitalize()
                return name.rstrip(".,!?")

    return ""


def _trim_history(history: list, limit: int = 6) -> list:
    return history[-limit:] if len(history) > limit else history


# ── Supabase message logging ──────────────────────────────────────────────────
def _log_message_to_supabase(email: str, role: str, content: str, session_id: str = ""):
    if not supabase:
        return
    try:
        identifier = email.strip().lower() if email else session_id.strip()
        supabase.table("messages").insert({
            "email": email if email else None,
            "user_id": identifier,
            "role": role,
            "content": content.strip()
        }).execute()
    except Exception as e:
        logger.error(f"[supabase] Insert failed (non-critical): {e}")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {
        "status": "YPN AI running",
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


@app.post("/chat")
async def chat(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"
    email = req.email.strip().lower() if req.email else ""
    device_username = req.username.strip() if req.username else ""

    if not message:
        raise HTTPException(400, "Message cannot be empty")

    # Resolve name using priority chain: Redis → SQLite device → Supabase → extraction
    user_name = await resolve_username(email, session_id, device_username, message)

    history = _get_session_from_redis(email, session_id)
    history = _trim_history(history)

    key = cache_key(email, message, history, session_id)
    if key in cache:
        logger.debug(f"[chat] Cache hit")
        return {"reply": cache[key], "cached": True, "user_name": user_name}

    try:
        response = co.chat(
            model=MODEL,
            messages=build_messages(history, message, user_name),
            temperature=0.7,
            max_tokens=200,
        )

        reply = response.message.content[0].text.strip()

        history.append({"role": "user", "content": message})
        history.append({"role": "assistant", "content": reply})
        history = history[-20:]

        _save_session_to_redis(email, history, session_id)

        _log_message_to_supabase(email, "user", message, session_id)
        _log_message_to_supabase(email, "assistant", reply, session_id)

        cache[key] = reply

        return {"reply": reply, "cached": False, "user_name": user_name}

    except Exception as e:
        logger.error(f"[chat] Error: {type(e).__name__}: {e}")
        raise HTTPException(500, str(e))


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"
    email = req.email.strip().lower() if req.email else ""
    device_username = req.username.strip() if req.username else ""

    if not message:
        raise HTTPException(400, "Message cannot be empty")

    user_name = await resolve_username(email, session_id, device_username, message)

    history = _get_session_from_redis(email, session_id)
    history = _trim_history(history)

    async def generate():
        full_text = ""
        try:
            stream = co.chat_stream(
                model=MODEL,
                messages=build_messages(history, message, user_name),
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

            history.append({"role": "user", "content": message})
            history.append({"role": "assistant", "content": full_text})
            trimmed = history[-20:]
            _save_session_to_redis(email, trimmed, session_id)

            _log_message_to_supabase(email, "user", message, session_id)
            _log_message_to_supabase(email, "assistant", full_text, session_id)

        except Exception as e:
            logger.error(f"[stream] Error: {e}")
            yield "Error: " + str(e)

    return StreamingResponse(generate(), media_type="text/plain")


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


# ── Background cache cleanup ──────────────────────────────────────────────────
async def cleanup_cache():
    while True:
        await asyncio.sleep(600)
        cache.clear()
        logger.info("Cache cleared")


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_cache())
    logger.info("YPN AI Backend started")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")