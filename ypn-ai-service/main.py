# ypn-ai-service/main.py
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os
import cohere
import asyncio
import hashlib
import json
import tempfile
import wave
import struct
import numpy as np
import soundfile as sf

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
    "Avoid long explanations unless asked. "
    "When responding to voice messages, keep replies short and conversational — "
    "2 to 3 sentences max unless more detail is needed."
)

# In-memory session store and cache
sessions: dict = {}
cache: dict = {}

# ── Vosk model (lazy-loaded once) ─────────────────────────────────────────────
_vosk_model = None

def get_vosk_model():
    global _vosk_model
    if _vosk_model is not None:
        return _vosk_model
    try:
        from vosk import Model
        model_path = os.getenv("VOSK_MODEL_PATH", "vosk-model-small-en-us-0.15")
        if not os.path.exists(model_path):
            print(f"[Vosk] Model not found at {model_path}. Download from https://alphacephei.com/vosk/models")
            return None
        _vosk_model = Model(model_path)
        print(f"[Vosk] Model loaded from {model_path}")
        return _vosk_model
    except Exception as e:
        print(f"[Vosk] Failed to load model: {e}")
        return None


# ── Kokoro TTS (lazy-loaded once) ─────────────────────────────────────────────
_kokoro = None

def get_kokoro():
    global _kokoro
    if _kokoro is not None:
        return _kokoro
    try:
        from kokoro_onnx import Kokoro
        kokoro_model = os.getenv("KOKORO_MODEL_PATH", "kokoro-v0_19.onnx")
        kokoro_voices = os.getenv("KOKORO_VOICES_PATH", "voices.json")
        if not os.path.exists(kokoro_model):
            print(f"[Kokoro] Model not found at {kokoro_model}")
            return None
        _kokoro = Kokoro(kokoro_model, kokoro_voices)
        print("[Kokoro] TTS model loaded")
        return _kokoro
    except Exception as e:
        print(f"[Kokoro] Failed to load: {e}")
        return None


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request model ──────────────────────────────────────────────────────────────
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


def make_cache_key(session_id, message, history):
    raw = session_id + message + json.dumps(history)
    return hashlib.md5(raw.encode()).hexdigest()


def cohere_reply(session_id: str, message: str, max_tokens: int = 200) -> str:
    """
    Get a reply from Cohere, update session history, cache result.
    Shared by both /chat and /voice endpoints.
    """
    if session_id not in sessions:
        sessions[session_id] = []

    history = trim_history(sessions[session_id])
    key = make_cache_key(session_id, message, history)

    if key in cache:
        return cache[key]

    response = co.chat(
        model=MODEL,
        messages=build_messages(history, message),
        temperature=0.7,
        max_tokens=max_tokens,
    )
    reply = response.message.content[0].text.strip()

    sessions[session_id].append({"role": "user", "content": message})
    sessions[session_id].append({"role": "assistant", "content": reply})
    sessions[session_id] = sessions[session_id][-20:]
    cache[key] = reply

    return reply


def convert_to_wav_16k_mono(input_path: str, output_path: str) -> bool:
    """
    Convert any audio file (m4a, webm, mp4, wav) to 16kHz mono WAV
    that Vosk can process. Uses soundfile + numpy for conversion.
    Falls back gracefully if conversion fails.
    """
    try:
        data, samplerate = sf.read(input_path)

        # Convert stereo to mono
        if len(data.shape) > 1:
            data = data.mean(axis=1)

        # Resample to 16000 Hz if needed
        if samplerate != 16000:
            # Simple linear interpolation resample
            target_length = int(len(data) * 16000 / samplerate)
            indices = np.linspace(0, len(data) - 1, target_length)
            data = np.interp(indices, np.arange(len(data)), data)

        # Write as 16-bit PCM WAV
        sf.write(output_path, data.astype(np.float32), 16000, subtype="PCM_16")
        return True
    except Exception as e:
        print(f"[Audio] Conversion failed: {e}")
        return False


def transcribe_with_vosk(wav_path: str) -> str:
    """
    Transcribe a 16kHz mono WAV file using Vosk offline STT.
    Returns transcript string or empty string on failure.
    """
    model = get_vosk_model()
    if model is None:
        return ""

    try:
        from vosk import KaldiRecognizer
        rec = KaldiRecognizer(model, 16000)
        rec.SetWords(True)

        transcript_parts = []

        with wave.open(wav_path, "rb") as wf:
            # Validate format
            if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getframerate() != 16000:
                print("[Vosk] WAV format mismatch — skipping")
                return ""

            while True:
                data = wf.readframes(4000)
                if len(data) == 0:
                    break
                if rec.AcceptWaveform(data):
                    result = json.loads(rec.Result())
                    text = result.get("text", "").strip()
                    if text:
                        transcript_parts.append(text)

        # Final partial
        final = json.loads(rec.FinalResult())
        text = final.get("text", "").strip()
        if text:
            transcript_parts.append(text)

        return " ".join(transcript_parts).strip()

    except Exception as e:
        print(f"[Vosk] Transcription error: {e}")
        return ""


def synthesize_with_kokoro(text: str, output_path: str, voice: str = "af") -> bool:
    """
    Synthesize text to speech using Kokoro ONNX.
    Saves WAV to output_path. Returns True on success.
    """
    kokoro = get_kokoro()
    if kokoro is None:
        return False

    try:
        samples, sample_rate = kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
        sf.write(output_path, samples, sample_rate)
        return True
    except Exception as e:
        print(f"[Kokoro] TTS error: {e}")
        return False


# ── Health ─────────────────────────────────────────────────────────────────────
@app.get("/")
async def root():
    return {"status": "⚡ YPN AI FAST MODE"}


@app.get("/health")
async def health():
    vosk_ready = get_vosk_model() is not None
    kokoro_ready = get_kokoro() is not None
    return {
        "status": "ok",
        "model": MODEL,
        "active_sessions": len(sessions),
        "cache_size": len(cache),
        "vosk_ready": vosk_ready,
        "kokoro_ready": kokoro_ready,
    }


# ── Text chat (JSON) ───────────────────────────────────────────────────────────
@app.post("/chat")
async def chat(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"

    if not message:
        raise HTTPException(400, "Message cannot be empty")

    try:
        reply = cohere_reply(session_id, message, max_tokens=200)
        cached = make_cache_key(session_id, message, []) in cache
        return {"reply": reply, "cached": cached}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Streaming text chat ────────────────────────────────────────────────────────
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


# ── Voice endpoint ─────────────────────────────────────────────────────────────
# POST /voice
# Accepts: multipart/form-data with field "audio" (m4a/wav/webm) + "session_id"
# Returns JSON: { transcript: str, reply: str }
# Also generates TTS audio and saves it — client can then GET /voice/tts/{filename}
#
# Flow:
#   1. Save raw audio to temp file
#   2. Convert to 16kHz mono WAV (Vosk requirement)
#   3. Transcribe with Vosk (offline)
#   4. Get AI reply from Cohere
#   5. Synthesize reply with Kokoro (offline) → save TTS wav
#   6. Return { transcript, reply, tts_url }

@app.post("/voice")
async def voice_chat(
    audio: UploadFile = File(...),
    session_id: str = Form(default="default"),
):
    session_id = (session_id or "default").strip()

    # 1. Read raw bytes
    try:
        audio_bytes = await audio.read()
    except Exception as e:
        raise HTTPException(400, f"Could not read audio: {e}")

    if not audio_bytes or len(audio_bytes) < 100:
        raise HTTPException(400, "Audio file is empty or too short")

    # Determine file extension from upload filename
    fname = audio.filename or "audio.m4a"
    ext = ".m4a"
    for candidate in [".wav", ".webm", ".mp4", ".ogg", ".flac", ".m4a"]:
        if fname.lower().endswith(candidate):
            ext = candidate
            break

    # 2. Write raw audio to temp file
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as raw_tmp:
        raw_tmp.write(audio_bytes)
        raw_path = raw_tmp.name

    # 3. Convert to 16kHz mono WAV for Vosk
    wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    wav_path = wav_tmp.name
    wav_tmp.close()

    converted = await asyncio.get_event_loop().run_in_executor(
        None, convert_to_wav_16k_mono, raw_path, wav_path
    )

    # Clean up raw file
    try:
        os.unlink(raw_path)
    except Exception:
        pass

    if not converted:
        try:
            os.unlink(wav_path)
        except Exception:
            pass
        raise HTTPException(
            422,
            "Could not convert audio to required format. "
            "Please ensure the recording completed successfully."
        )

    # 4. Transcribe with Vosk (run in thread — CPU-bound)
    transcript = await asyncio.get_event_loop().run_in_executor(
        None, transcribe_with_vosk, wav_path
    )

    # Clean up converted WAV
    try:
        os.unlink(wav_path)
    except Exception:
        pass

    if not transcript:
        raise HTTPException(
            422,
            "Could not understand the audio. "
            "Please speak clearly and try again."
        )

    # 5. Get Cohere reply
    try:
        reply = await asyncio.get_event_loop().run_in_executor(
            None, cohere_reply, session_id, transcript, 150
        )
    except Exception as e:
        raise HTTPException(500, f"AI reply failed: {e}")

    # 6. Synthesize TTS with Kokoro (run in thread — CPU-bound)
    tts_url = None
    tts_tmp = tempfile.NamedTemporaryFile(
        suffix=".wav",
        delete=False,
        dir=tempfile.gettempdir(),
        prefix="ypn_tts_"
    )
    tts_path = tts_tmp.name
    tts_tmp.close()

    tts_ok = await asyncio.get_event_loop().run_in_executor(
        None, synthesize_with_kokoro, reply, tts_path, "af"
    )

    if tts_ok:
        # Store path in memory keyed by a short id so client can fetch it
        tts_file_id = os.path.basename(tts_path)
        _tts_files[tts_file_id] = tts_path
        tts_url = f"/voice/tts/{tts_file_id}"
    else:
        # TTS failed — client falls back to expo-speech
        try:
            os.unlink(tts_path)
        except Exception:
            pass

    return {
        "transcript": transcript,
        "reply": reply,
        "tts_url": tts_url,   # None if Kokoro unavailable — client uses expo-speech
    }


# ── TTS audio file serve ───────────────────────────────────────────────────────
# In-memory map: filename → absolute path on disk
_tts_files: dict = {}

@app.get("/voice/tts/{file_id}")
async def get_tts_audio(file_id: str):
    path = _tts_files.get(file_id)
    if not path or not os.path.exists(path):
        raise HTTPException(404, "TTS file not found or already played")

    # One-shot: delete after serving so temp files don't accumulate
    async def cleanup():
        await asyncio.sleep(30)
        try:
            os.unlink(path)
        except Exception:
            pass
        _tts_files.pop(file_id, None)

    asyncio.create_task(cleanup())

    return FileResponse(
        path,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


# ── Clear session ──────────────────────────────────────────────────────────────
@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    return {"cleared": session_id}


# ── Background cache cleanup ───────────────────────────────────────────────────
async def cleanup_cache():
    while True:
        await asyncio.sleep(600)
        cache.clear()
        print("🧹 Cache cleared")


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_cache())
    # Warm up models in background so first request isn't slow
    asyncio.get_event_loop().run_in_executor(None, get_vosk_model)
    asyncio.get_event_loop().run_in_executor(None, get_kokoro)


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")