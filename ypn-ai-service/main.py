# ypn-ai-service/main.py
import os
import json
import wave
import asyncio
import hashlib
import tempfile
import io

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import cohere

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
    "When responding in a voice call, keep replies short and conversational."
)

# ── In-memory text chat sessions (HTTP) ──────────────────────────────────────
sessions: dict = {}
cache: dict = {}

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Lazy-load heavy models (only when first voice call connects) ──────────────
_vosk_model = None
_kokoro_pipeline = None


def get_vosk_model():
    global _vosk_model
    if _vosk_model is None:
        from vosk import Model
        model_path = os.getenv("VOSK_MODEL_PATH", "vosk-model-small-en-us-0.15")
        if not os.path.exists(model_path):
            raise RuntimeError(
                f"Vosk model not found at '{model_path}'. "
                "Download from https://alphacephei.com/vosk/models "
                "and set VOSK_MODEL_PATH env var."
            )
        _vosk_model = Model(model_path)
        print(f"[Vosk] Model loaded from {model_path}")
    return _vosk_model


def get_kokoro():
    global _kokoro_pipeline
    if _kokoro_pipeline is None:
        from kokoro_onnx import Kokoro
        model_file = os.getenv("KOKORO_MODEL_PATH", "kokoro-v0_19.onnx")
        voices_file = os.getenv("KOKORO_VOICES_PATH", "voices.json")
        if not os.path.exists(model_file):
            raise RuntimeError(
                f"Kokoro model not found at '{model_file}'. "
                "Download from https://github.com/thewh1teagle/kokoro-onnx/releases"
            )
        _kokoro_pipeline = Kokoro(model_file, voices_file)
        print("[Kokoro] Pipeline loaded")
    return _kokoro_pipeline


# ── Helpers ───────────────────────────────────────────────────────────────────

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


def cohere_reply(user_text: str, history: list) -> str:
    """Single Cohere call, returns reply string. Used by both HTTP and WS."""
    response = co.chat(
        model=MODEL,
        messages=build_messages(history, user_text),
        temperature=0.7,
        max_tokens=150,
    )
    return response.message.content[0].text.strip()


def synthesize_audio(text: str) -> bytes:
    """
    Convert text to WAV bytes using Kokoro ONNX (af_sky voice).
    Returns raw WAV bytes suitable for streaming over WebSocket.
    """
    kokoro = get_kokoro()
    # af_sky = female voice, speed 1.0
    samples, sample_rate = kokoro.create(text, voice="af_sky", speed=1.0, lang="en-us")

    # Write to in-memory WAV
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()


# ── Existing HTTP endpoints (unchanged) ──────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"


@app.get("/")
async def root():
    return {"status": "⚡ YPN AI"}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL,
        "active_sessions": len(sessions),
        "cache_size": len(cache),
    }


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
        reply = cohere_reply(message, history)

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


# ── WebSocket Voice Endpoint ──────────────────────────────────────────────────
#
# Protocol (client → server):
#   Binary frames  : raw 16-bit PCM audio at 16000 Hz mono (chunks)
#   Text frame "VAD_SILENCE" : user stopped speaking, process buffer
#   Text frame "INTERRUPT"   : user started speaking, cancel AI playback
#   Text frame "HANGUP"      : end call, close connection
#
# Protocol (server → client):
#   Text  {"type":"transcript","text":"..."}  : what user said
#   Text  {"type":"reply","text":"..."}       : AI text reply
#   Text  {"type":"audio_start"}              : about to stream audio
#   Binary frames                             : WAV audio chunks
#   Text  {"type":"audio_end"}               : audio stream finished
#   Text  {"type":"error","message":"..."}   : error occurred
#
# ─────────────────────────────────────────────────────────────────────────────

SAMPLE_RATE = 16000          # Vosk requires 16kHz
SILENCE_RMS_THRESHOLD = 500  # RMS below this = silence (for server-side guard)
AUDIO_CHUNK_SIZE = 4096      # bytes per WebSocket audio send chunk


@app.websocket("/voice")
async def voice_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("[Voice] Client connected")

    # Load models (lazy, only on first connection)
    try:
        from vosk import KaldiRecognizer
        vosk_model = get_vosk_model()
        recognizer = KaldiRecognizer(vosk_model, SAMPLE_RATE)
        recognizer.SetWords(True)
    except Exception as e:
        await websocket.send_text(json.dumps({
            "type": "error",
            "message": f"Model load failed: {str(e)}"
        }))
        await websocket.close()
        return

    # Per-call state (no persistent memory — inline streaming only)
    audio_buffer = bytearray()
    is_ai_speaking = False
    ai_speak_task: asyncio.Task | None = None

    async def stop_ai_speaking():
        """Cancel ongoing AI audio stream immediately (barge-in)."""
        nonlocal is_ai_speaking, ai_speak_task
        if ai_speak_task and not ai_speak_task.done():
            ai_speak_task.cancel()
            try:
                await ai_speak_task
            except asyncio.CancelledError:
                pass
        is_ai_speaking = False
        ai_speak_task = None

    async def stream_ai_response(user_text: str):
        """
        Transcribe → Cohere → Kokoro → stream audio back.
        Runs as a cancellable task so barge-in can stop it.
        """
        nonlocal is_ai_speaking
        is_ai_speaking = True

        try:
            # 1. Send transcript back so client can display it
            await websocket.send_text(json.dumps({
                "type": "transcript",
                "text": user_text
            }))

            # 2. Get Cohere reply (no history — inline only)
            reply_text = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: cohere_reply(user_text, [])
            )

            # 3. Send text reply so client displays it
            await websocket.send_text(json.dumps({
                "type": "reply",
                "text": reply_text
            }))

            # 4. Synthesize speech
            await websocket.send_text(json.dumps({"type": "audio_start"}))

            audio_bytes = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: synthesize_audio(reply_text)
            )

            # 5. Stream audio in chunks
            for i in range(0, len(audio_bytes), AUDIO_CHUNK_SIZE):
                chunk = audio_bytes[i:i + AUDIO_CHUNK_SIZE]
                await websocket.send_bytes(chunk)
                # Small yield so cancellation can happen between chunks
                await asyncio.sleep(0)

            await websocket.send_text(json.dumps({"type": "audio_end"}))

        except asyncio.CancelledError:
            # Barge-in — client interrupted, just stop cleanly
            await websocket.send_text(json.dumps({"type": "audio_end"}))
            raise
        except Exception as e:
            print(f"[Voice] stream_ai_response error: {e}")
            await websocket.send_text(json.dumps({
                "type": "error",
                "message": str(e)
            }))
        finally:
            is_ai_speaking = False

    try:
        while True:
            message = await websocket.receive()

            # ── Text control frames ───────────────────────────────────────
            if "text" in message:
                control = message["text"].strip()

                if control == "VAD_SILENCE":
                    # User finished speaking — process buffered audio
                    if len(audio_buffer) < 3200:
                        # Too short (< 0.1s at 16kHz 16-bit) — ignore
                        audio_buffer.clear()
                        recognizer.Reset()
                        continue

                    # Run Vosk recognition on buffer
                    recognizer.AcceptWaveform(bytes(audio_buffer))
                    result = json.loads(recognizer.FinalResult())
                    user_text = result.get("text", "").strip()
                    audio_buffer.clear()
                    recognizer.Reset()

                    if not user_text:
                        # Nothing recognised — don't send empty to Cohere
                        continue

                    # Stop any ongoing AI speech before responding
                    await stop_ai_speaking()

                    # Start AI response as cancellable task
                    ai_speak_task = asyncio.create_task(
                        stream_ai_response(user_text)
                    )

                elif control == "INTERRUPT":
                    # User started speaking — stop AI immediately
                    await stop_ai_speaking()
                    audio_buffer.clear()
                    recognizer.Reset()

                elif control == "HANGUP":
                    await stop_ai_speaking()
                    break

            # ── Binary audio frames ───────────────────────────────────────
            elif "bytes" in message:
                raw = message["bytes"]
                if raw:
                    # If AI is speaking and user sends audio → barge-in check
                    # Client handles VAD and sends INTERRUPT — but as a guard,
                    # check RMS here too
                    if is_ai_speaking:
                        pcm = np.frombuffer(raw, dtype=np.int16)
                        rms = int(np.sqrt(np.mean(pcm.astype(np.float32) ** 2)))
                        if rms > SILENCE_RMS_THRESHOLD * 2:
                            await stop_ai_speaking()
                            audio_buffer.clear()
                            recognizer.Reset()

                    audio_buffer.extend(raw)
                    # Feed to Vosk incrementally for partial results
                    if recognizer.AcceptWaveform(raw):
                        pass  # partial results ignored — we use FinalResult on VAD_SILENCE

    except WebSocketDisconnect:
        print("[Voice] Client disconnected")
    except Exception as e:
        print(f"[Voice] Unexpected error: {e}")
    finally:
        await stop_ai_speaking()
        print("[Voice] Connection closed")


# ── Background cache cleanup ──────────────────────────────────────────────────

async def cleanup_cache():
    while True:
        await asyncio.sleep(600)
        cache.clear()
        print("🧹 Cache cleared")


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_cache())


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")