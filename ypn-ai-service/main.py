# ypn-ai-service/main.py
#
# YPN AI service — text chat + continuous voice call.
#
# All existing HTTP endpoints are UNCHANGED.
# New: WebSocket /voice for continuous conversation.
#
# WebSocket protocol (JSON frames):
#
#   Client → Server
#   ─────────────────────────────────────────────────────
#   { "type": "audio_chunk", "data": "<base64 raw PCM 16kHz mono int16>" }
#   { "type": "barge_in" }     — user interrupted, stop AI audio immediately
#   { "type": "end_call" }     — clean shutdown
#
#   Server → Client
#   ─────────────────────────────────────────────────────
#   { "type": "partial",   "text": "..." }   — live transcript (VAD partial)
#   { "type": "transcript","text": "..." }   — committed utterance
#   { "type": "thinking" }                  — Cohere generating
#   { "type": "tts_start", "sample_rate": 22050 }
#   { "type": "tts_chunk", "data": "<base64 raw PCM>" }
#   { "type": "tts_end" }
#   { "type": "error",  "message": "..." }
#   { "type": "ready" }                     — session ready, start sending audio

import asyncio
import base64
import hashlib
import json
import logging
import os
import uuid

import cohere
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from audio.tts import PIPER_SAMPLE_RATE, synthesize_chunks
from voice_session import VoiceSession

load_dotenv()
logging.basicConfig(
    level  = logging.INFO,
    format = "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Cohere ─────────────────────────────────────────────────────────────────────
COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY is not set")

co    = cohere.ClientV2(api_key=COHERE_API_KEY)
MODEL = "command-r-plus-08-2024"

SYSTEM_PROMPT_TEXT = (
    "You are YPN AI, a warm and helpful assistant for Team YPN — "
    "a youth empowerment network based in Zimbabwe. "
    "Be concise, helpful, and natural like a good friend. "
    "Avoid long explanations unless asked."
)

# Voice prompt: no markdown, shorter answers because output goes to TTS
SYSTEM_PROMPT_VOICE = (
    "You are YPN AI, a warm and helpful voice assistant for Team YPN — "
    "a youth empowerment network in Zimbabwe. "
    "Keep responses to 2-3 short sentences unless the user asks for detail. "
    "Never use bullet points, markdown, symbols, or lists — speak in plain "
    "natural prose because your words will be read aloud."
)

# ── In-memory stores ───────────────────────────────────────────────────────────
# Both stores are process-local — cleared on restart, which is fine for a
# stateless cloud deployment. No PII persisted to disk.
sessions:       dict[str, list] = {}          # HTTP chat histories
cache:          dict[str, str]  = {}          # HTTP response cache
voice_sessions: dict[str, VoiceSession] = {}  # active WebSocket sessions

# ── App ────────────────────────────────────────────────────────────────────────
app = FastAPI(title="YPN AI Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ════════════════════════════════════════════════════════════════════════════════
# Shared helpers
# ════════════════════════════════════════════════════════════════════════════════

def _trim(history: list, limit: int = 6) -> list:
    return history[-limit:]


def _build_text_messages(history: list, message: str) -> list:
    return (
        [{"role": "system", "content": SYSTEM_PROMPT_TEXT}]
        + history
        + [{"role": "user", "content": message}]
    )


def _build_voice_messages(history: list) -> list:
    return [{"role": "system", "content": SYSTEM_PROMPT_VOICE}] + history


def _cache_key(session_id: str, message: str, history: list) -> str:
    raw = session_id + message + json.dumps(history)
    return hashlib.md5(raw.encode()).hexdigest()


async def _send(ws: WebSocket, payload: dict) -> None:
    """Send JSON control frame. Silently drops if connection is closing."""
    try:
        await ws.send_text(json.dumps(payload))
    except Exception:
        pass


# ════════════════════════════════════════════════════════════════════════════════
# HTTP endpoints — UNCHANGED from original
# ════════════════════════════════════════════════════════════════════════════════

class ChatRequest(BaseModel):
    message:    str
    session_id: str = "default"


@app.get("/")
async def root():
    return {"status": "⚡ YPN AI — Text + Continuous Voice"}


@app.get("/health")
async def health():
    return {
        "status":               "ok",
        "model":                MODEL,
        "active_sessions":      len(sessions),
        "active_voice_sessions": len(voice_sessions),
        "cache_size":           len(cache),
    }


@app.post("/chat")
async def chat(req: ChatRequest):
    from fastapi import HTTPException

    message    = req.message.strip()
    session_id = req.session_id.strip() or "default"
    if not message:
        raise HTTPException(400, "Message cannot be empty")

    if session_id not in sessions:
        sessions[session_id] = []

    history = _trim(sessions[session_id])
    key     = _cache_key(session_id, message, history)

    if key in cache:
        return {"reply": cache[key], "cached": True}

    try:
        response = co.chat(
            model    = MODEL,
            messages = _build_text_messages(history, message),
            temperature = 0.7,
            max_tokens  = 200,
        )
        reply = response.message.content[0].text.strip()

        sessions[session_id].append({"role": "user",      "content": message})
        sessions[session_id].append({"role": "assistant", "content": reply})
        sessions[session_id] = sessions[session_id][-20:]
        cache[key] = reply

        return {"reply": reply, "cached": False}

    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    from fastapi import HTTPException
    from fastapi.responses import StreamingResponse

    message    = req.message.strip()
    session_id = req.session_id.strip() or "default"
    if not message:
        raise HTTPException(400, "Message cannot be empty")

    if session_id not in sessions:
        sessions[session_id] = []

    history = _trim(sessions[session_id])

    async def generate():
        full_text = ""
        try:
            stream = co.chat_stream(
                model       = MODEL,
                messages    = _build_text_messages(history, message),
                temperature = 0.7,
                max_tokens  = 200,
            )
            for event in stream:
                if event.type == "content-delta":
                    chunk = event.delta.message.content.text
                    if chunk:
                        full_text += chunk
                        yield chunk
                        await asyncio.sleep(0.01)

            sessions[session_id].append({"role": "user",      "content": message})
            sessions[session_id].append({"role": "assistant", "content": full_text})
            sessions[session_id] = sessions[session_id][-20:]

        except Exception as e:
            yield f"⚠️ Error: {e}"

    return StreamingResponse(generate(), media_type="text/plain")


@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    voice_sessions.pop(session_id, None)
    return {"cleared": session_id}


# ════════════════════════════════════════════════════════════════════════════════
# Continuous voice WebSocket — /voice
# ════════════════════════════════════════════════════════════════════════════════

async def _cohere_reply(vs: VoiceSession, user_text: str) -> str:
    """
    Call Cohere synchronously (SDK is blocking) inside a thread pool
    so the event loop stays free for WebSocket I/O.
    """
    def _call() -> str:
        resp = co.chat(
            model       = MODEL,
            messages    = _build_voice_messages(vs.history),
            temperature = 0.7,
            max_tokens  = 120,  # shorter for voice — ~15-20 seconds of speech
        )
        return resp.message.content[0].text.strip()

    return await asyncio.to_thread(_call)


async def _stream_tts(ws: WebSocket, text: str, cancel: asyncio.Event) -> None:
    """
    Pipe Piper output to client in base64-encoded chunks.
    Stops immediately if cancel is set (barge-in).
    """
    await _send(ws, {"type": "tts_start", "sample_rate": PIPER_SAMPLE_RATE})

    async for chunk in synthesize_chunks(text, cancel):
        if cancel.is_set():
            break
        await _send(ws, {
            "type": "tts_chunk",
            "data": base64.b64encode(chunk).decode("ascii"),
        })

    await _send(ws, {"type": "tts_end"})


@app.websocket("/voice")
async def voice_endpoint(websocket: WebSocket):
    """
    Continuous conversation WebSocket.

    State machine per utterance:
      IDLE → (speech detected by VAD) → SPEAKING
           → (800ms silence)          → commit transcript
           → Cohere                   → THINKING
           → Piper stream             → REPLYING
           → (tts_end)                → IDLE  (ready for next utterance)

    Barge-in: client sends { "type": "barge_in" } while AI is REPLYING.
    The TTS cancel event fires, Piper subprocess dies, we reset to IDLE.
    """
    await websocket.accept()

    session_id = str(uuid.uuid4())
    vs         = VoiceSession(session_id=session_id)
    voice_sessions[session_id] = vs

    logger.info(f"[Voice] {session_id[:8]} connected")

    # Tell client the session is live and it can start streaming audio
    await _send(websocket, {"type": "ready"})

    # We run TTS in a background task so audio I/O doesn't block VAD processing
    tts_task: asyncio.Task | None = None

    try:
        while True:
            raw = await websocket.receive_text()

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await _send(websocket, {
                    "type":    "error",
                    "message": "Frames must be JSON",
                })
                continue

            msg_type = msg.get("type")

            # ── PCM audio chunk ───────────────────────────────────────────────
            if msg_type == "audio_chunk":
                b64 = msg.get("data", "")
                if not b64:
                    continue

                try:
                    pcm = base64.b64decode(b64)
                except Exception:
                    continue

                # Feed through VAD + STT
                partial, utterance_complete = vs.feed_pcm(pcm)

                # Send live partial transcript to UI
                if partial:
                    await _send(websocket, {"type": "partial", "text": partial})

                # VAD decided the utterance is finished
                if utterance_complete:
                    transcript = vs.finalize_transcript()
                    logger.info(f"[Voice] {session_id[:8]} → '{transcript}'")

                    if not transcript:
                        # Nothing intelligible — reset quietly
                        vs.reset_for_next_utterance()
                        continue

                    # Commit transcript to UI + history
                    await _send(websocket, {
                        "type": "transcript",
                        "text": transcript,
                    })
                    vs.add_user_turn(transcript)

                    # Tell UI we're thinking
                    await _send(websocket, {"type": "thinking"})

                    # Generate AI reply (blocking Cohere call in thread)
                    try:
                        ai_text = await _cohere_reply(vs, transcript)
                    except Exception as e:
                        logger.error(f"[Voice] Cohere error: {e}")
                        await _send(websocket, {
                            "type":    "error",
                            "message": "AI generation failed. Please try again.",
                        })
                        vs.reset_for_next_utterance()
                        continue

                    logger.info(
                        f"[Voice] {session_id[:8]} ← '{ai_text[:60]}…'"
                    )
                    vs.add_ai_turn(ai_text)

                    # Stream TTS in background so we can still receive barge-in
                    # frames while audio is going out
                    vs.tts_cancel.clear()
                    tts_task = asyncio.create_task(
                        _stream_tts(websocket, ai_text, vs.tts_cancel)
                    )

                    # Reset VAD/STT state so we're ready for next utterance
                    # as soon as the user speaks again
                    vs.reset_for_next_utterance()

            # ── Barge-in ──────────────────────────────────────────────────────
            elif msg_type == "barge_in":
                logger.debug(f"[Voice] {session_id[:8]} barge-in received")
                vs.cancel_tts()                    # kills Piper subprocess
                if tts_task and not tts_task.done():
                    tts_task.cancel()
                    try:
                        await tts_task
                    except asyncio.CancelledError:
                        pass
                tts_task = None
                await _send(websocket, {"type": "tts_end"})  # clean up client

            # ── Clean shutdown ────────────────────────────────────────────────
            elif msg_type == "end_call":
                logger.info(f"[Voice] {session_id[:8]} ended by client")
                break

    except WebSocketDisconnect:
        logger.info(f"[Voice] {session_id[:8]} disconnected")
    except Exception as e:
        logger.error(f"[Voice] {session_id[:8]} unexpected: {e}", exc_info=True)
        try:
            await _send(websocket, {
                "type":    "error",
                "message": "Session error. Please reconnect.",
            })
        except Exception:
            pass
    finally:
        # Cancel any running TTS
        if tts_task and not tts_task.done():
            tts_task.cancel()
            try:
                await tts_task
            except asyncio.CancelledError:
                pass
        # Remove session — no state survives disconnect
        voice_sessions.pop(session_id, None)
        logger.info(f"[Voice] {session_id[:8]} session cleaned up")


# ── Background cache cleanup ───────────────────────────────────────────────────

async def _cleanup_cache():
    while True:
        await asyncio.sleep(600)
        cache.clear()
        logger.info("🧹 HTTP cache cleared")


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(_cleanup_cache())
    logger.info("🚀 YPN AI service started")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10_000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")