# ypn-ai-service/main.py
# YPN AI Service v2.0 — FastAPI + Cohere + Whisper STT + gTTS
#
# Voice pipeline:
#   POST /voice  multipart audio file
#     → Whisper STT  (transcript)
#     → Cohere AI    (text reply)
#     → gTTS         (mp3 bytes)
#     ← audio/mpeg   (played directly by mobile)
#
# Fixes from logs:
#   • HEAD / → 200  (Render health check was getting 405)
#   • /voice → 404 gone
#   • uvicorn[standard] → no more WebSocket warnings
#   • Structured logging for Render log drain

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os, io, time, hashlib, json, logging, asyncio, tempfile, subprocess
import cohere
import whisper
from gtts import gTTS

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("ypn-ai")

# ── Env ───────────────────────────────────────────────────────────────────────
load_dotenv()
COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY is not set in environment")

# ── Clients ───────────────────────────────────────────────────────────────────
co = cohere.ClientV2(api_key=COHERE_API_KEY)
MODEL = "command-r-plus-08-2024"

# Whisper loaded once at startup — base model balances speed vs accuracy
# on Render free tier (512 MB RAM).  Use "tiny" if you hit OOM.
log.info("Loading Whisper base model…")
_whisper = whisper.load_model("base")
log.info("Whisper ready")

# ── System prompt ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = (
    "You are YPN AI, a warm and helpful voice assistant for Team YPN — "
    "a youth empowerment network based in Zimbabwe. "
    "Keep replies SHORT (2-3 sentences max) because they will be read aloud. "
    "Be conversational, kind and direct. "
    "Never give medical or legal advice. "
    "Use only verified public information about YPN Zimbabwe."
)

# ── In-memory session store ───────────────────────────────────────────────────
# { session_id: [ {"role": "user"|"assistant", "content": str} ] }
sessions: dict[str, list] = {}

# ── L1 reply cache ────────────────────────────────────────────────────────────
# Keyed on hash(session_id + message + last 4 history messages)
# Stores the TEXT reply — audio is re-synthesised each time (cheap with gTTS)
_l1: dict[str, dict] = {}
L1_TTL   = 10 * 60   # 10 minutes
L1_MAX   = 400        # max entries before LRU eviction

# ── FastAPI ───────────────────────────────────────────────────────────────────
app = FastAPI(title="YPN AI", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _trim(history: list, keep: int = 10) -> list:
    """Keep last `keep` turns (each turn = user + assistant message)."""
    return history[-(keep * 2):]


def _build_messages(history: list, user_msg: str) -> list:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        *history,
        {"role": "user", "content": user_msg},
    ]


def _cache_key(session_id: str, message: str, history: list) -> str:
    payload = session_id + "|" + message + "|" + json.dumps(history[-4:])
    return hashlib.md5(payload.encode()).hexdigest()


def _l1_get(key: str) -> str | None:
    entry = _l1.get(key)
    if not entry:
        return None
    if time.time() - entry["ts"] > L1_TTL:
        _l1.pop(key, None)
        return None
    return entry["reply"]


def _l1_set(key: str, reply: str) -> None:
    if len(_l1) >= L1_MAX:
        # evict LRU
        oldest = min(_l1, key=lambda k: _l1[k]["ts"])
        _l1.pop(oldest, None)
    _l1[key] = {"reply": reply, "ts": time.time()}


def _append_session(sid: str, user_msg: str, ai_reply: str) -> None:
    if sid not in sessions:
        sessions[sid] = []
    sessions[sid].append({"role": "user",      "content": user_msg})
    sessions[sid].append({"role": "assistant",  "content": ai_reply})
    sessions[sid] = sessions[sid][-40:]   # hard cap: 40 messages


def _text_to_mp3(text: str) -> bytes:
    """Convert text to mp3 bytes using gTTS (free, no API key)."""
    buf = io.BytesIO()
    tts = gTTS(text=text, lang="en", slow=False)
    tts.write_to_fp(buf)
    buf.seek(0)
    return buf.read()


async def _cohere_reply(session_id: str, user_msg: str) -> tuple[str, bool]:
    """
    Returns (reply_text, was_cached).
    Checks L1 cache first, then calls Cohere.
    """
    history  = _trim(sessions.get(session_id, []))
    cache_k  = _cache_key(session_id, user_msg, history)
    cached   = _l1_get(cache_k)

    if cached:
        log.info(f"[cohere] L1 hit session={session_id}")
        return cached, True

    t0 = time.time()
    response = co.chat(
        model=MODEL,
        messages=_build_messages(history, user_msg),
        temperature=0.7,
        max_tokens=200,   # short — replies are spoken aloud
    )
    reply   = response.message.content[0].text.strip()
    elapsed = round(time.time() - t0, 2)
    log.info(f"[cohere] session={session_id} time={elapsed}s words={len(reply.split())}")

    _append_session(session_id, user_msg, reply)
    _l1_set(cache_k, reply)
    return reply, False


# ─────────────────────────────────────────────────────────────────────────────
# Health / root
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/")
@app.head("/")           # ← fixes Render HEAD health check → was 405
async def root():
    return {"status": "ok", "service": "YPN AI", "version": "2.0.0"}


@app.get("/health")
@app.head("/health")
async def health():
    return {
        "status": "ok",
        "model":   MODEL,
        "whisper": "base",
        "sessions": len(sessions),
        "l1_cache": len(_l1),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Chat (text, JSON response)
# ─────────────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message:    str
    session_id: str = "default"


@app.post("/chat")
async def chat(req: ChatRequest):
    msg = req.message.strip()
    sid = (req.session_id or "default").strip()
    if not msg:
        raise HTTPException(400, "message cannot be empty")

    try:
        reply, cached = await asyncio.get_event_loop().run_in_executor(
            None, lambda: asyncio.run(_cohere_reply_sync(sid, msg))
        )
    except Exception as e:
        log.error(f"[chat] {e}")
        raise HTTPException(500, str(e))

    return {"reply": reply, "cached": cached}


# asyncio.run inside executor requires a sync wrapper
def _cohere_reply_sync(sid: str, msg: str) -> tuple[str, bool]:
    """Synchronous version of _cohere_reply for run_in_executor."""
    history = _trim(sessions.get(sid, []))
    cache_k = _cache_key(sid, msg, history)
    cached  = _l1_get(cache_k)
    if cached:
        return cached, True

    t0 = time.time()
    response = co.chat(
        model=MODEL,
        messages=_build_messages(history, msg),
        temperature=0.7,
        max_tokens=200,
    )
    reply   = response.message.content[0].text.strip()
    elapsed = round(time.time() - t0, 2)
    log.info(f"[chat] session={sid} time={elapsed}s")

    _append_session(sid, msg, reply)
    _l1_set(cache_k, reply)
    return reply, False


# ─────────────────────────────────────────────────────────────────────────────
# Chat stream (SSE / text stream)
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    msg = req.message.strip()
    sid = (req.session_id or "default").strip()
    if not msg:
        raise HTTPException(400, "message cannot be empty")

    history = _trim(sessions.get(sid, []))

    async def generate():
        full = ""
        try:
            stream = co.chat_stream(
                model=MODEL,
                messages=_build_messages(history, msg),
                temperature=0.7,
                max_tokens=300,
            )
            for event in stream:
                if event.type == "content-delta":
                    chunk = event.delta.message.content.text
                    if chunk:
                        full += chunk
                        yield chunk
                        await asyncio.sleep(0.01)
            _append_session(sid, msg, full)
            _l1_set(_cache_key(sid, msg, history), full)
        except Exception as e:
            log.error(f"[stream] {e}")
            yield f"⚠️ {str(e)}"

    return StreamingResponse(generate(), media_type="text/plain")


# ─────────────────────────────────────────────────────────────────────────────
# Voice  —  full pipeline: audio → STT → Cohere → TTS → mp3
# ─────────────────────────────────────────────────────────────────────────────
# Mobile sends:
#   POST /voice
#   Content-Type: multipart/form-data
#   Fields:
#     file       — audio file (m4a / mp3 / wav / webm / ogg)
#     session_id — optional string (default: "default")
#
# Returns:
#   Content-Type: audio/mpeg
#   Body:         mp3 bytes (AI voice reply, ready to play)
#   Headers:
#     X-Transcript — what the user said (for display in UI)
#     X-Reply-Text — AI text reply    (for display in UI)
#     X-Cached     — "true" | "false"
#
# Error responses are JSON so the mobile can show them in the UI.

ALLOWED_AUDIO_EXTS   = {".mp3", ".m4a", ".wav", ".ogg", ".webm", ".mp4", ".aac"}
ALLOWED_AUDIO_TYPES  = {
    "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a", "audio/aac",
    "audio/wav", "audio/wave", "audio/ogg", "audio/webm",
    "audio/x-m4a", "audio/x-wav", "application/octet-stream",
}
MAX_AUDIO_BYTES = 25 * 1024 * 1024   # 25 MB


@app.post("/voice")
async def voice_pipeline(
    file:       UploadFile = File(...),
    session_id: str        = Form(default="default"),
):
    sid = (session_id or "default").strip()

    # ── Validate file type ────────────────────────────────────────────────────
    fname   = (file.filename or "audio.mp3").lower()
    ext     = os.path.splitext(fname)[1]
    ctype   = (file.content_type or "").lower().split(";")[0].strip()

    if ext not in ALLOWED_AUDIO_EXTS and ctype not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(
            415,
            detail={
                "error": "unsupported_audio",
                "message": f"Send mp3, m4a, wav, ogg, or webm. Got: {ctype or ext}",
            },
        )

    # ── Read bytes ────────────────────────────────────────────────────────────
    audio_bytes = await file.read()
    if len(audio_bytes) < 500:
        raise HTTPException(400, detail={"error": "empty_audio", "message": "Audio too short or empty"})
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(413, detail={"error": "too_large", "message": "Audio file exceeds 25 MB"})

    log.info(f"[voice] session={sid} size={len(audio_bytes)//1024}KB ext={ext}")

    # ── Step 1: Whisper STT ───────────────────────────────────────────────────
    # Write to a temp file — Whisper needs a real file path or numpy array.
    # We use a named temp file so ffmpeg (inside whisper) can read the format.
    try:
        loop = asyncio.get_event_loop()
        transcript = await loop.run_in_executor(None, _transcribe, audio_bytes, ext)
    except Exception as e:
        log.error(f"[voice] STT error: {e}")
        raise HTTPException(
            500,
            detail={"error": "stt_failed", "message": "Could not transcribe audio. Please try again."},
        )

    if not transcript:
        # Return a friendly audio response instead of an error
        sorry_text = "Sorry, I couldn't hear that clearly. Please try speaking again."
        mp3_bytes  = await loop.run_in_executor(None, _text_to_mp3, sorry_text)
        return Response(
            content=mp3_bytes,
            media_type="audio/mpeg",
            headers={
                "X-Transcript":  "",
                "X-Reply-Text":  sorry_text,
                "X-Cached":      "false",
            },
        )

    log.info(f"[voice] transcript='{transcript[:80]}'")

    # ── Step 2: Cohere AI reply ───────────────────────────────────────────────
    try:
        reply_text, was_cached = _cohere_reply_sync(sid, transcript)
    except Exception as e:
        log.error(f"[voice] AI error: {e}")
        raise HTTPException(
            500,
            detail={"error": "ai_failed", "message": "AI service error. Please try again."},
        )

    log.info(f"[voice] reply='{reply_text[:80]}' cached={was_cached}")

    # ── Step 3: gTTS → mp3 ───────────────────────────────────────────────────
    try:
        loop       = asyncio.get_event_loop()
        mp3_bytes  = await loop.run_in_executor(None, _text_to_mp3, reply_text)
    except Exception as e:
        log.error(f"[voice] TTS error: {e}")
        raise HTTPException(
            500,
            detail={"error": "tts_failed", "message": "Could not generate voice reply."},
        )

    # ── Return mp3 audio ──────────────────────────────────────────────────────
    return Response(
        content=mp3_bytes,
        media_type="audio/mpeg",
        headers={
            "X-Transcript":  transcript,
            "X-Reply-Text":  reply_text,
            "X-Cached":      "true" if was_cached else "false",
            # Allow mobile to read these custom headers via CORS
            "Access-Control-Expose-Headers": "X-Transcript, X-Reply-Text, X-Cached",
        },
    )


def _transcribe(audio_bytes: bytes, ext: str) -> str:
    """
    Run Whisper transcription synchronously.
    Called via run_in_executor so it doesn't block the event loop.
    """
    suffix = ext if ext else ".mp3"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    try:
        result = _whisper.transcribe(tmp_path, fp16=False, language="en")
        return (result.get("text") or "").strip()
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Session management
# ─────────────────────────────────────────────────────────────────────────────

@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    dropped = [k for k in list(_l1) if session_id in k]
    for k in dropped:
        _l1.pop(k, None)
    return {"cleared": session_id, "cache_dropped": len(dropped)}


@app.get("/sessions")
async def list_sessions():
    """Debug: active sessions and message counts."""
    return {sid: len(msgs) for sid, msgs in sessions.items()}


# ─────────────────────────────────────────────────────────────────────────────
# Background cache cleanup
# ─────────────────────────────────────────────────────────────────────────────

async def _cleanup_loop():
    while True:
        await asyncio.sleep(10 * 60)
        now     = time.time()
        expired = [k for k, v in list(_l1.items()) if now - v["ts"] > L1_TTL]
        for k in expired:
            _l1.pop(k, None)
        if expired:
            log.info(f"[cache] evicted {len(expired)} stale L1 entries")


@app.on_event("startup")
async def on_startup():
    asyncio.create_task(_cleanup_loop())
    log.info(f"YPN AI ready | model={MODEL} | whisper=base")


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
        # Single worker — keeps Whisper model in one process
    )