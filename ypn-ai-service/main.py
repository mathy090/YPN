# ypn-ai-service/main.py
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os
import cohere
import asyncio
import hashlib
import json
import base64
import io
import uuid
import numpy as np

load_dotenv()

COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY is not set")

co = cohere.ClientV2(api_key=COHERE_API_KEY)
MODEL = "command-r-plus-08-2024"

SYSTEM_PROMPT = (
    "You are YPN AI, a warm and helpful assistant for Team YPN — "
    "a youth empowerment network based in Zimbabwe. "
    "Be concise, helpful, and natural like ChatGPT. "
    "Avoid long explanations unless asked."
)

VOICE_SYSTEM_PROMPT = (
    "You are YPN AI, a warm voice assistant for Team YPN in Zimbabwe. "
    "IMPORTANT: Keep every response to 1-3 short sentences max — this is voice chat. "
    "Speak naturally, no bullet points, no lists. "
    "Be warm, supportive, and conversational."
)

# ── In-memory stores ───────────────────────────────────────────────────────────
sessions: dict = {}
cache: dict = {}

# ── Whisper model (lazy, loaded once, stays in memory) ────────────────────────
_whisper_model = None

def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        print("[Voice] Loading faster-whisper tiny model (first load)...")
        _whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")
        print("[Voice] Whisper model ready")
    return _whisper_model

# ── Audio helpers ──────────────────────────────────────────────────────────────

# Maps file extension → pyav format string
_FORMAT_MAP = {
    "m4a": "mp4", "mp4": "mp4", "caf": "caf",
    "wav": "wav", "mp3": "mp3", "webm": "webm",
    "3gp": "3gp", "aac": "aac",
}

def decode_audio(audio_bytes: bytes, file_ext: str = "m4a") -> np.ndarray:
    """
    Decode any audio format to 16 kHz mono float32 numpy array using PyAV.
    PyAV bundles its own ffmpeg — no system ffmpeg required.
    """
    import av

    ext = file_ext.lower().lstrip(".")
    fmt = _FORMAT_MAP.get(ext, "mp4")
    buf = io.BytesIO(audio_bytes)

    try:
        container = av.open(buf, format=fmt)
    except Exception:
        buf.seek(0)
        container = av.open(buf)  # fallback: let pyav auto-detect

    resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
    frames = []

    try:
        for frame in container.decode(audio=0):
            for rf in resampler.resample(frame):
                frames.append(rf.to_ndarray().flatten())
        for rf in resampler.resample(None):   # flush resampler
            frames.append(rf.to_ndarray().flatten())
    finally:
        container.close()

    if not frames:
        return np.zeros(1600, dtype=np.float32)   # 0.1 s of silence

    return np.concatenate(frames).astype(np.float32)


async def transcribe_audio(audio_bytes: bytes, file_ext: str) -> str:
    """Run faster-whisper STT in a thread executor (non-blocking)."""
    loop = asyncio.get_event_loop()

    def _run():
        audio_array = decode_audio(audio_bytes, file_ext)
        model = get_whisper_model()
        segments, _ = model.transcribe(
            audio_array,
            language="en",
            beam_size=1,          # fastest setting
        )
        return " ".join(seg.text.strip() for seg in segments).strip()

    return await loop.run_in_executor(None, _run)


async def synthesise_speech(text: str) -> str:
    """Convert text to MP3, return as base64 string (runs in thread)."""
    from gtts import gTTS
    loop = asyncio.get_event_loop()

    def _run():
        tts = gTTS(text=text, lang="en", slow=False)
        buf = io.BytesIO()
        tts.write_to_fp(buf)
        buf.seek(0)
        return base64.b64encode(buf.read()).decode("utf-8")

    return await loop.run_in_executor(None, _run)

# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Pydantic models ────────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"

# ── Helpers ────────────────────────────────────────────────────────────────────
def trim_history(history, limit=6):
    return history[-limit:]

def build_messages(history, message):
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    msgs.extend(history)
    msgs.append({"role": "user", "content": message})
    return msgs

def cache_key(session_id, message, history):
    raw = session_id + message + json.dumps(history)
    return hashlib.md5(raw.encode()).hexdigest()

# ── Health ─────────────────────────────────────────────────────────────────────
@app.get("/")
async def root():
    return {"status": "⚡ YPN AI — text + voice"}

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL,
        "whisper_loaded": _whisper_model is not None,
        "active_sessions": len(sessions),
        "cache_size": len(cache),
    }

# ── Text chat ──────────────────────────────────────────────────────────────────
@app.post("/chat")
async def chat(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"
    if not message:
        raise HTTPException(400, "Message cannot be empty")

    if session_id not in sessions:
        sessions[session_id] = []

    history = trim_history(sessions[session_id])
    key = cache_key(session_id, message, history)

    if key in cache:
        return {"reply": cache[key], "cached": True}

    try:
        response = co.chat(
            model=MODEL,
            messages=build_messages(history, message),
            temperature=0.7,
            max_tokens=200,
        )
        reply = response.message.content[0].text.strip()
        sessions[session_id].append({"role": "user", "content": message})
        sessions[session_id].append({"role": "assistant", "content": reply})
        sessions[session_id] = sessions[session_id][-20:]
        cache[key] = reply
        return {"reply": reply, "cached": False}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"
    if not message:
        raise HTTPException(400, "Message cannot be empty")

    if session_id not in sessions:
        sessions[session_id] = []

    history = trim_history(sessions[session_id])

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

            sessions[session_id].append({"role": "user", "content": message})
            sessions[session_id].append({"role": "assistant", "content": full_text})
            sessions[session_id] = sessions[session_id][-20:]
        except Exception as e:
            yield "⚠️ Error: " + str(e)

    return StreamingResponse(generate(), media_type="text/plain")


@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    return {"cleared": session_id}

# ── Voice WebSocket ────────────────────────────────────────────────────────────
# Protocol (all text frames, JSON):
#
# Client → Server:
#   {"type": "audio_chunk", "data": "<base64-audio>"}
#   {"type": "end_of_speech", "format": "m4a"}
#   {"type": "end_call"}
#   {"type": "ping"}
#
# Server → Client:
#   {"type": "session_started"}
#   {"type": "status", "status": "transcribing"|"thinking"|"speaking"|"ready"}
#   {"type": "transcript", "text": "..."}
#   {"type": "ai_response", "text": "..."}
#   {"type": "audio", "data": "<base64-mp3>"}
#   {"type": "error", "message": "..."}
#   {"type": "call_ended"}
#   {"type": "pong"}

@app.websocket("/voice")
async def voice_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = str(uuid.uuid4())
    history: list = []
    audio_chunks: list[bytes] = []

    print(f"[Voice] Call started: {session_id}")

    await websocket.send_text(json.dumps({
        "type": "session_started",
        "session_id": session_id,
    }))

    try:
        while True:
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=90.0,   # 90-second idle timeout per message
                )
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"type": "call_ended"}))
                break
            except WebSocketDisconnect:
                break

            data = json.loads(raw)
            msg_type = data.get("type", "")

            # ── Ping keepalive ────────────────────────────────────────────────
            if msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
                continue

            # ── Accumulate audio chunk ────────────────────────────────────────
            if msg_type == "audio_chunk":
                chunk_b64 = data.get("data", "")
                if chunk_b64:
                    audio_chunks.append(base64.b64decode(chunk_b64))
                continue

            # ── Process speech ────────────────────────────────────────────────
            if msg_type == "end_of_speech":
                if not audio_chunks:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "No audio received",
                    }))
                    continue

                audio_data = b"".join(audio_chunks)
                audio_chunks.clear()
                file_ext = data.get("format", "m4a")

                # 1. Transcribe
                await websocket.send_text(json.dumps({
                    "type": "status", "status": "transcribing"
                }))
                try:
                    transcript = await transcribe_audio(audio_data, file_ext)
                except Exception as e:
                    print(f"[Voice] STT error: {e}")
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "Could not understand audio — please try again",
                    }))
                    continue

                if not transcript:
                    await websocket.send_text(json.dumps({
                        "type": "status", "status": "ready"
                    }))
                    continue

                await websocket.send_text(json.dumps({
                    "type": "transcript", "text": transcript
                }))

                # 2. AI response
                await websocket.send_text(json.dumps({
                    "type": "status", "status": "thinking"
                }))
                history.append({"role": "user", "content": transcript})
                try:
                    response = co.chat(
                        model=MODEL,
                        messages=[{"role": "system", "content": VOICE_SYSTEM_PROMPT}]
                        + history[-8:],
                        temperature=0.7,
                        max_tokens=120,
                    )
                    reply = response.message.content[0].text.strip()
                except Exception as e:
                    print(f"[Voice] Cohere error: {e}")
                    await websocket.send_text(json.dumps({
                        "type": "error", "message": "AI response failed"
                    }))
                    continue

                history.append({"role": "assistant", "content": reply})
                history = history[-16:]   # keep last 8 turns

                await websocket.send_text(json.dumps({
                    "type": "ai_response", "text": reply
                }))

                # 3. TTS
                await websocket.send_text(json.dumps({
                    "type": "status", "status": "speaking"
                }))
                try:
                    audio_b64 = await synthesise_speech(reply)
                    await websocket.send_text(json.dumps({
                        "type": "audio", "data": audio_b64
                    }))
                except Exception as e:
                    print(f"[Voice] TTS error: {e}")
                    # Fall back gracefully — client already has text
                    await websocket.send_text(json.dumps({
                        "type": "status", "status": "ready"
                    }))
                continue

            # ── End call ──────────────────────────────────────────────────────
            if msg_type == "end_call":
                await websocket.send_text(json.dumps({"type": "call_ended"}))
                break

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[Voice] Unexpected error {session_id}: {e}")
    finally:
        print(f"[Voice] Call ended: {session_id}")


# ── Background tasks ───────────────────────────────────────────────────────────
async def _cleanup_cache():
    while True:
        await asyncio.sleep(600)
        cache.clear()
        print("🧹 Cache cleared")

async def _preload_whisper():
    """Load Whisper model in background after server starts — avoids cold-start delay."""
    await asyncio.sleep(3)
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, get_whisper_model)
    except Exception as e:
        print(f"[Voice] Whisper preload failed: {e}")

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(_cleanup_cache())
    asyncio.create_task(_preload_whisper())

# ── Entry ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")