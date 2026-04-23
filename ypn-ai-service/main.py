# ypn-ai-service/main.py
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os, cohere, asyncio, hashlib, json, logging, sys

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────────
COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY is not set")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
UPSTASH_REDIS_URL = os.getenv("UPSTASH_REDIS_REST_URL")
UPSTASH_REDIS_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN")

co = cohere.ClientV2(api_key=COHERE_API_KEY)
MODEL = "command-r-plus-08-2024"

# ── Redis ─────────────────────────────────────────────────────────────────────
from upstash_redis import Redis

redis = None
if UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN:
    try:
        redis = Redis(url=UPSTASH_REDIS_URL, token=UPSTASH_REDIS_TOKEN)
        logger.info("Redis connected")
    except Exception as e:
        logger.error(f"Redis failed: {e}")

# ── Supabase ──────────────────────────────────────────────────────────────────
supabase = None
if SUPABASE_URL and SUPABASE_KEY:
    try:
        from supabase import create_client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        logger.info("Supabase connected")
    except Exception as e:
        logger.error(f"Supabase failed: {e}")

# ── Fallbacks ─────────────────────────────────────────────────────────────────
sessions, cache = {}, {}

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ────────────────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
    email: str = ""
    username: str = ""

# ── Helpers ───────────────────────────────────────────────────────────────────
def _id(email, session_id):
    return email.strip().lower() if email else session_id.strip()

def _redis_key(email, session_id, prefix="session"):
    base = _id(email, session_id)
    safe = base.replace("@", "_").replace(".", "_")
    return f"{prefix}:{safe}"

def _get_session(email, session_id):
    if not redis:
        return sessions.get(_id(email, session_id), [])
    try:
        data = redis.get(_redis_key(email, session_id))
        return json.loads(data) if data else []
    except:
        return []

def _save_session(email, session_id, history):
    if not redis:
        sessions[_id(email, session_id)] = history
        return
    redis.set(_redis_key(email, session_id), json.dumps(history), ex=86400)

def _trim(history, n=6):
    return history[-n:] if len(history) > n else history

def cache_key(email, session_id, message, history):
    raw = _id(email, session_id) + message + json.dumps(history, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()

# ── Routes ────────────────────────────────────────────────────────────────────

# ✅ FIXED: supports GET + HEAD (for UptimeRobot)
@app.api_route("/", methods=["GET", "HEAD"])
async def root():
    return {
        "status": "YPN AI running",
        "redis": "connected" if redis else "fallback",
        "supabase": "connected" if supabase else "disabled"
    }

@app.api_route("/health", methods=["GET", "HEAD"])
async def health():
    return {
        "status": "ok",
        "model": MODEL,
        "redis": "connected" if redis else "fallback",
        "supabase": "connected" if supabase else "disabled",
        "cache_size": len(cache)
    }

# ── Chat ──────────────────────────────────────────────────────────────────────
@app.post("/chat")
async def chat(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id or "default"
    email = req.email.strip().lower()

    if not message:
        raise HTTPException(400, "Message cannot be empty")

    history = _trim(_get_session(email, session_id))
    key = cache_key(email, session_id, message, history)

    if key in cache:
        return {"reply": cache[key], "cached": True}

    try:
        response = co.chat(
            model=MODEL,
            messages=[*history, {"role": "user", "content": message}],
            temperature=0.7,
            max_tokens=200,
        )

        reply = response.message.content[0].text.strip()

        history += [
            {"role": "user", "content": message},
            {"role": "assistant", "content": reply},
        ]

        _save_session(email, session_id, history[-20:])
        cache[key] = reply

        return {"reply": reply, "cached": False}

    except Exception as e:
        logger.error(f"Chat error: {e}")
        raise HTTPException(500, str(e))

# ── Streaming ─────────────────────────────────────────────────────────────────
@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id or "default"
    email = req.email.strip().lower()

    history = _trim(_get_session(email, session_id))

    async def generate():
        full = ""
        try:
            stream = co.chat_stream(
                model=MODEL,
                messages=[*history, {"role": "user", "content": message}],
            )

            for event in stream:
                if event.type == "content-delta":
                    chunk = event.delta.message.content.text
                    if chunk:
                        full += chunk
                        yield chunk
                        await asyncio.sleep(0.01)

            history.append({"role": "assistant", "content": full})
            _save_session(email, session_id, history[-20:])

        except Exception as e:
            yield f"Error: {e}"

    return StreamingResponse(generate(), media_type="text/plain")

# ── Clear Session ─────────────────────────────────────────────────────────────
@app.delete("/chat/{session_id}")
async def clear_session(session_id: str, email: str = ""):
    if redis:
        redis.delete(_redis_key(email, session_id))
    else:
        sessions.pop(_id(email, session_id), None)

    return {"cleared": True}

# ── Cache Cleaner ─────────────────────────────────────────────────────────────
async def cleanup():
    while True:
        await asyncio.sleep(600)
        cache.clear()

@app.on_event("startup")
async def startup():
    asyncio.create_task(cleanup())
    logger.info("Server started")

# ── Run ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)