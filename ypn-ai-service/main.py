# ypn-ai-service/main.py
import os
import json
import asyncio
import hashlib
import tempfile
import wave
import struct
from typing import Dict, Any

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import cohere

load_dotenv()

# ── Configuration ──────────────────────────────────────────────────────────────
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

# ── In-memory stores (Defined globally before routes) ─────────────────────────
sessions: Dict[str, list] = {}
cache: Dict[str, str] = {}
_tts_files: Dict[str, str] = {}  # Maps filename_id -> absolute path on disk

# ── Lazy-loaded Models ────────────────────────────────────────────────────────
_vosk_model = None
_kokoro_pipeline = None

def get_vosk_model():
    global _vosk_model
    if _vosk_model is not None:
        return _vosk_model
    try:
        from vosk import Model
        model_path = os.getenv("VOSK_MODEL_PATH", "vosk-model-small-en-us-0.15")
        if not os.path.exists(model_path):
            print(f"[Vosk] Model not found at {model_path}. Please run download_models.py")
            return None
        _vosk_model = Model(model_path)
        print(f"[Vosk] Model loaded from {model_path}")
        return _vosk_model
    except Exception as e:
        print(f"[Vosk] Failed to load model: {e}")
        return None

def get_kokoro():
    global _kokoro_pipeline
    if _kokoro_pipeline is not None:
        return _kokoro_pipeline
    try:
        from kokoro_onnx import Kokoro
        model_file = os.getenv("KOKORO_MODEL_PATH", "kokoro-v0_19.onnx")
        voices_file = os.getenv("KOKORO_VOICES_PATH", "voices.json")
        if not os.path.exists(model_file):
            print(f"[Kokoro] Model not found at {model_file}")
            return None
        _kokoro_pipeline = Kokoro(model_file, voices_file)
        print("[Kokoro] TTS pipeline loaded")
        return _kokoro_pipeline
    except Exception as e:
        print(f"[Kokoro] Failed to load pipeline: {e}")
        return None

# ── FastAPI App Setup ─────────────────────────────────────────────────────────
app = FastAPI(title="YPN AI Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Pydantic Models ───────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"

# ── Helper Functions ──────────────────────────────────────────────────────────
def trim_history(history: list, limit: int = 6) -> list:
    return history[-limit:]

def build_messages(history: list, message: str) -> list:
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    msgs.extend(history)
    msgs.append({"role": "user", "content": message})
    return msgs

def make_cache_key(session_id: str, message: str, history: list) -> str:
    raw = session_id + message + json.dumps(history)
    return hashlib.md5(raw.encode()).hexdigest()

def cohere_reply(session_id: str, message: str, max_tokens: int = 150) -> str:
    """Get reply from Cohere, update history, and cache."""
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

    # Update history
    sessions[session_id].append({"role": "user", "content": message})
    sessions[session_id].append({"role": "assistant", "content": reply})
    sessions[session_id] = sessions[session_id][-20:] # Keep last 20 messages
    
    cache[key] = reply
    return reply

def convert_to_wav_16k_mono(input_path: str, output_path: str) -> bool:
    """Convert audio file to 16kHz mono WAV for Vosk."""
    try:
        data, samplerate = sf.read(input_path)
        
        # Stereo to Mono
        if len(data.shape) > 1:
            data = data.mean(axis=1)
        
        # Resample to 16kHz if needed
        if samplerate != 16000:
            target_length = int(len(data) * 16000 / samplerate)
            indices = np.linspace(0, len(data) - 1, target_length)
            data = np.interp(indices, np.arange(len(data)), data)
        
        # Write 16-bit PCM WAV
        sf.write(output_path, data.astype(np.float32), 16000, subtype="PCM_16")
        return True
    except Exception as e:
        print(f"[Audio] Conversion failed: {e}")
        return False

def transcribe_with_vosk(wav_path: str) -> str:
    """Transcribe WAV using Vosk."""
    model = get_vosk_model()
    if model is None:
        return ""
    
    try:
        from vosk import KaldiRecognizer
        rec = KaldiRecognizer(model, 16000)
        rec.SetWords(False)
        
        transcript_parts = []
        
        with wave.open(wav_path, "rb") as wf:
            if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getframerate() != 16000:
                print("[Vosk] WAV format mismatch")
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
        
        # Final result
        final = json.loads(rec.FinalResult())
        text = final.get("text", "").strip()
        if text:
            transcript_parts.append(text)
            
        return " ".join(transcript_parts).strip()
    except Exception as e:
        print(f"[Vosk] Transcription error: {e}")
        return ""

def synthesize_with_kokoro(text: str, output_path: str, voice: str = "af_sky") -> bool:
    """Synthesize text to speech using Kokoro."""
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

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "⚡ YPN AI FAST MODE", "service": "Voice & Text"}

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL,
        "active_sessions": len(sessions),
        "cache_size": len(cache),
        "vosk_ready": get_vosk_model() is not None,
        "kokoro_ready": get_kokoro() is not None,
    }

@app.post("/chat")
async def chat(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"
    
    if not message:
        raise HTTPException(400, "Message cannot be empty")
    
    try:
        reply = cohere_reply(session_id, message, max_tokens=200)
        # Simple cache check
        history = trim_history(sessions.get(session_id, []))
        cached = make_cache_key(session_id, message, history) in cache
        return {"reply": reply, "cached": cached}
    except Exception as e:
        raise HTTPException(500, f"AI service error: {str(e)}")

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
            yield f"\n⚠️ Error: {str(e)}"
    
    return StreamingResponse(generate(), media_type="text/plain")

@app.post("/voice")
async def voice_chat(
    audio: UploadFile = File(...),
    session_id: str = Form(default="default"),
):
    session_id = (session_id or "default").strip()
    
    # 1. Read Audio
    try:
        audio_bytes = await audio.read()
    except Exception as e:
        raise HTTPException(400, f"Could not read audio: {e}")
    
    if not audio_bytes or len(audio_bytes) < 100:
        raise HTTPException(400, "Audio file is empty or too short")
    
    # Determine extension
    fname = audio.filename or "audio.m4a"
    ext = ".m4a"
    for candidate in [".wav", ".webm", ".mp4", ".ogg", ".flac", ".m4a"]:
        if fname.lower().endswith(candidate):
            ext = candidate
            break
    
    # 2. Save Raw Temp File
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as raw_tmp:
        raw_tmp.write(audio_bytes)
        raw_path = raw_tmp.name
    
    # 3. Convert to 16kHz Mono WAV
    wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    wav_path = wav_tmp.name
    wav_tmp.close()
    
    converted = await asyncio.get_event_loop().run_in_executor(
        None, convert_to_wav_16k_mono, raw_path, wav_path
    )
    
    # Cleanup raw
    try: os.unlink(raw_path)
    except: pass
    
    if not converted:
        try: os.unlink(wav_path)
        except: pass
        raise HTTPException(422, "Failed to convert audio format.")
    
    # 4. Transcribe
    transcript = await asyncio.get_event_loop().run_in_executor(
        None, transcribe_with_vosk, wav_path
    )
    
    # Cleanup wav
    try: os.unlink(wav_path)
    except: pass
    
    if not transcript:
        raise HTTPException(422, "Could not understand audio. Please speak clearly.")
    
    # 5. Get AI Reply
    try:
        reply = await asyncio.get_event_loop().run_in_executor(
            None, cohere_reply, session_id, transcript, 150
        )
    except Exception as e:
        raise HTTPException(500, f"AI reply failed: {e}")
    
    # 6. Synthesize TTS
    tts_url = None
    tts_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False, prefix="ypn_tts_")
    tts_path = tts_tmp.name
    tts_tmp.close()
    
    tts_ok = await asyncio.get_event_loop().run_in_executor(
        None, synthesize_with_kokoro, reply, tts_path, "af_sky"
    )
    
    if tts_ok:
        file_id = os.path.basename(tts_path)
        _tts_files[file_id] = tts_path
        tts_url = f"/voice/tts/{file_id}"
    else:
        try: os.unlink(tts_path)
        except: pass
    
    return {
        "transcript": transcript,
        "reply": reply,
        "tts_url": tts_url
    }

@app.get("/voice/tts/{file_id}")
async def get_tts_audio(file_id: str):
    path = _tts_files.get(file_id)
    if not path or not os.path.exists(path):
        raise HTTPException(404, "TTS file not found or expired")
    
    # Schedule cleanup after serving
    async def cleanup():
        await asyncio.sleep(30) # Give client time to buffer
        try:
            os.unlink(path)
            _tts_files.pop(file_id, None)
        except Exception:
            pass
    
    asyncio.create_task(cleanup())
    
    return FileResponse(
        path,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"}
    )

@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    return {"cleared": session_id}

# ── Startup Events ────────────────────────────────────────────────────────────
async def cleanup_cache_task():
    while True:
        await asyncio.sleep(600)
        cache.clear()
        print("🧹 Cache cleared")

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_cache_task())
    # Warm up models
    print("[Startup] Warming up models...")
    asyncio.get_event_loop().run_in_executor(None, get_vosk_model)
    asyncio.get_event_loop().run_in_executor(None, get_kokoro)
    print("[Startup] Ready.")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")