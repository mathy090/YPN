# ypn-ai-service/main.py
import os
import json
import asyncio
import hashlib
import tempfile
import wave
from typing import Dict, List

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
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
    "Be concise, helpful, and natural. "
    "When responding to voice messages, keep replies short and conversational — "
    "2 to 3 sentences max."
)

# ── In-memory Stores ──────────────────────────────────────────────────────────
sessions: Dict[str, List[dict]] = {}
cache: Dict[str, str] = {}

# ── Lazy Model Loading (Vosk Only) ────────────────────────────────────────────
_vosk_model = None

def get_vosk_model():
    global _vosk_model
    if _vosk_model is not None:
        return _vosk_model
    
    try:
        from vosk import Model
        # Ensure this matches the folder name from download_models.py
        model_path = os.getenv("VOSK_MODEL_PATH", "vosk-model-small-en-us-0.15")
        
        if not os.path.exists(model_path):
            print(f"[ERROR] Vosk model not found at {model_path}")
            print("[ERROR] Please run download_models.py first.")
            return None
            
        print(f"[Vosk] Loading model from {model_path}...")
        _vosk_model = Model(model_path)
        print("[Vosk] Model loaded successfully (Low Memory Mode)")
        return _vosk_model
    except Exception as e:
        print(f"[Vosk] Critical load error: {e}")
        return None

# ── App Setup ─────────────────────────────────────────────────────────────────
app = FastAPI(title="YPN AI Lite")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"

# ── Helpers ───────────────────────────────────────────────────────────────────
def trim_history(history: List[dict], limit: int = 6) -> List[dict]:
    return history[-limit:]

def build_messages(history: List[dict], message: str) -> List[dict]:
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    msgs.extend(history)
    msgs.append({"role": "user", "content": message})
    return msgs

def make_cache_key(session_id: str, message: str, history: List[dict]) -> str:
    raw = session_id + message + json.dumps(history, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()

def get_reply_from_cohere(session_id: str, user_text: str) -> str:
    if session_id not in sessions:
        sessions[session_id] = []

    history = trim_history(sessions[session_id])
    key = make_cache_key(session_id, user_text, history)

    if key in cache:
        return cache[key]

    response = co.chat(
        model=MODEL,
        messages=build_messages(history, user_text),
        temperature=0.7,
        max_tokens=150, # Keep it short for voice
    )
    
    reply = response.message.content[0].text.strip()
    
    # Update History
    sessions[session_id].append({"role": "user", "content": user_text})
    sessions[session_id].append({"role": "assistant", "content": reply})
    sessions[session_id] = sessions[session_id][-20:]
    
    cache[key] = reply
    return reply

def transcribe_audio_bytes(audio_bytes: bytes) -> str:
    """Transcribes raw audio bytes using Vosk (16kHz mono expected)."""
    model = get_vosk_model()
    if not model:
        raise HTTPException(503, "Speech engine unavailable (Model not loaded)")

    try:
        from vosk import KaldiRecognizer
        
        # Vosk needs a WAV header to know format, or we assume 16k mono raw.
        # Since Expo sends M4A/WAV, we must write to temp file to let Vosk/Kaldi handle it safely.
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            # Note: If Expo sends M4A, we ideally need conversion. 
            # To keep it LIGHT, we assume Expo sends WAV or we try direct stream.
            # For maximum compatibility with minimal libs, we write and let Vosk try.
            # IF Expo sends M4A, Vosk might fail without ffmpeg. 
            # BEST PRACTICE FOR LIGHT SETUP: Expo should record as WAV 16k mono.
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        rec = KaldiRecognizer(model, 16000)
        rec.SetWords(False)
        
        transcript_parts = []
        
        with wave.open(tmp_path, "rb") as wf:
            # Simple validation
            if wf.getframerate() != 16000:
                print(f"[Warn] Sample rate mismatch: {wf.getframerate()}")
                # Vosk might still work, but quality drops.
            
            while True:
                data = wf.readframes(4000)
                if len(data) == 0:
                    break
                if rec.AcceptWaveform(data):
                    res = json.loads(rec.Result())
                    if res.get('text'):
                        transcript_parts.append(res['text'])
        
        # Final
        final = json.loads(rec.FinalResult())
        if final.get('text'):
            transcript_parts.append(final['text'])
            
        os.unlink(tmp_path)
        
        result = " ".join(transcript_parts).strip()
        return result if result else ""

    except Exception as e:
        print(f"[Vosk] Transcription failed: {e}")
        if 'tmp_path' in locals():
            try: os.unlink(tmp_path)
            except: pass
        return ""

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "⚡ YPN AI LITE", "mode": "Text + Client-Side TTS"}

@app.get("/health")
async def health():
    model_loaded = get_vosk_model() is not None
    return {
        "status": "ok",
        "ram_optimized": True,
        "vosk_ready": model_loaded,
        "active_sessions": len(sessions)
    }

@app.post("/chat")
async def chat(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"
    
    if not message:
        raise HTTPException(400, "Message empty")
        
    try:
        reply = get_reply_from_cohere(session_id, message)
        return {"reply": reply, "cached": False}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"
    
    if not message:
        raise HTTPException(400, "Message empty")

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
                max_tokens=150,
            )
            for event in stream:
                if event.type == "content-delta":
                    chunk = event.delta.message.content.text
                    if chunk:
                        full_text += chunk
                        yield chunk
            
            sessions[session_id].append({"role": "user", "content": message})
            sessions[session_id].append({"role": "assistant", "content": full_text})
            sessions[session_id] = sessions[session_id][-20:]
        except Exception as e:
            yield f"\nError: {str(e)}"

    return StreamingResponse(generate(), media_type="text/plain")

@app.post("/voice")
async def voice_chat(
    audio: UploadFile = File(...),
    session_id: str = Form(default="default")
):
    session_id = (session_id or "default").strip()
    
    # 1. Read Audio
    try:
        audio_bytes = await audio.read()
    except Exception as e:
        raise HTTPException(400, "Failed to read audio")
    
    if len(audio_bytes) < 100:
        raise HTTPException(400, "Audio too short")

    # 2. Transcribe (Vosk)
    # NOTE: Ensure Expo records in WAV 16kHz Mono for best results without ffmpeg
    transcript = transcribe_audio_bytes(audio_bytes)
    
    if not transcript:
        raise HTTPException(422, "Could not understand speech. Please speak clearly.")

    # 3. Get AI Reply (Cohere)
    try:
        reply = get_reply_from_cohere(session_id, transcript)
    except Exception as e:
        raise HTTPException(500, f"AI Error: {str(e)}")

    # 4. Return Text Only (Expo handles TTS)
    return {
        "transcript": transcript,
        "reply": reply,
        "tts_url": None  # Signal to frontend to use expo-speech
    }

@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    cache.clear()
    return {"cleared": session_id}

# ── Startup ───────────────────────────────────────────────────────────────────
async def cleanup_cache_task():
    while True:
        await asyncio.sleep(600)
        cache.clear()

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_cache_task())
    # Pre-load Vosk to avoid cold start latency on first request
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, get_vosk_model)
    print("[Startup] YPN AI Lite Ready (Low RAM)")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")