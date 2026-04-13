# ypn-ai-service/main.py
import os
import json
import asyncio
import hashlib
import io

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, Response
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
    "Be concise, helpful, and natural. "
    "Avoid long explanations unless asked. "
    "When in a voice call, keep replies short and conversational — "
    "two to three sentences maximum."
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

# ── Lazy-load heavy models ────────────────────────────────────────────────────
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
                "Run download_models.py or set VOSK_MODEL_PATH."
            )
        _vosk_model = Model(model_path)
        print(f"[Vosk] Model loaded from {model_path}", flush=True)
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
                "Run download_models.py or set KOKORO_MODEL_PATH."
            )
        _kokoro_pipeline = Kokoro(model_file, voices_file)
        print("[Kokoro] Pipeline loaded", flush=True)
    return _kokoro_pipeline


# ── Shared helpers ────────────────────────────────────────────────────────────

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
    response = co.chat(
        model=MODEL,
        messages=build_messages(history, user_text),
        temperature=0.7,
        max_tokens=150,
    )
    return response.message.content[0].text.strip()


def synthesize_audio(text: str) -> bytes:
    kokoro = get_kokoro()
    samples, sample_rate = kokoro.create(
        text, voice="af_sky", speed=1.0, lang="en-us"
    )
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()


# ── Health / root ─────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "ok", "service": "YPN AI"}


@app.head("/")
async def root_head():
    return Response(status_code=200)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL,
        "active_sessions": len(sessions),
        "cache_size": len(cache),
    }


# ── Text chat (HTTP) ──────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"


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
        reply = await asyncio.get_event_loop().run_in_executor(
            None, lambda: cohere_reply(message, history)
        )
        sessions[session_id].append({"role": "user", "content": message})
        sessions[session_id].append({"role": "assistant", "content": reply})
        sessions[session_id] = sessions[session_id][-20:]
        cache[key] = reply
        return {"reply": reply, "cached": False}

    except Exception as e:
        print(f"[Chat] Error: {e}", flush=True)
        raise HTTPException(500, "AI service error")


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
            print(f"[ChatStream] Error: {e}", flush=True)
            yield ""

    return StreamingResponse(generate(), media_type="text/plain")


@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    return {"cleared": session_id}


# ── WebSocket Voice Endpoint ──────────────────────────────────────────────────
#
# Client → Server:
#   bytes              : raw 16-bit PCM at 16000 Hz mono
#   "VAD_SILENCE"      : user stopped speaking → transcribe + respond
#   "INTERRUPT"        : barge-in → cancel AI speech
#   "HANGUP"           : end call
#
# Server → Client:
#   {"type":"transcript","text":"..."}  STT result
#   {"type":"reply","text":"..."}       AI text
#   {"type":"audio_start"}             WAV stream begins
#   bytes                              WAV chunks
#   {"type":"audio_end"}               WAV stream done
#
# ─────────────────────────────────────────────────────────────────────────────

SAMPLE_RATE = 16000
BARGE_IN_RMS = 800
AUDIO_CHUNK_BYTES = 4096


@app.websocket("/voice")
async def voice_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("[Voice] Client connected", flush=True)

    try:
        from vosk import KaldiRecognizer
        vosk_model = get_vosk_model()
        recognizer = KaldiRecognizer(vosk_model, SAMPLE_RATE)
        recognizer.SetWords(False)
        print("[Voice] Models ready", flush=True)
    except Exception as e:
        print(f"[Voice] Model load error: {e}", flush=True)
        await websocket.send_text(json.dumps({
            "type": "error",
            "message": "Voice service unavailable. Please try again later."
        }))
        await websocket.close()
        return

    audio_buffer = bytearray()
    is_ai_speaking = False
    ai_task: asyncio.Task | None = None

    async def cancel_ai():
        nonlocal is_ai_speaking, ai_task
        if ai_task and not ai_task.done():
            ai_task.cancel()
            try:
                await ai_task
            except asyncio.CancelledError:
                pass
        is_ai_speaking = False
        ai_task = None

    async def respond_to_user(user_text: str):
        nonlocal is_ai_speaking
        is_ai_speaking = True
        try:
            await websocket.send_text(json.dumps({
                "type": "transcript",
                "text": user_text
            }))

            reply_text = await asyncio.get_event_loop().run_in_executor(
                None, lambda: cohere_reply(user_text, [])
            )
            print(f"[Voice] Reply: {reply_text[:80]}", flush=True)

            await websocket.send_text(json.dumps({
                "type": "reply",
                "text": reply_text
            }))

            await websocket.send_text(json.dumps({"type": "audio_start"}))

            wav_bytes = await asyncio.get_event_loop().run_in_executor(
                None, lambda: synthesize_audio(reply_text)
            )

            for i in range(0, len(wav_bytes), AUDIO_CHUNK_BYTES):
                await websocket.send_bytes(wav_bytes[i:i + AUDIO_CHUNK_BYTES])
                await asyncio.sleep(0)

            await websocket.send_text(json.dumps({"type": "audio_end"}))

        except asyncio.CancelledError:
            await websocket.send_text(json.dumps({"type": "audio_end"}))
            raise
        except Exception as e:
            print(f"[Voice] respond_to_user error: {e}", flush=True)
            await websocket.send_text(json.dumps({
                "type": "error",
                "message": "Something went wrong. Please speak again."
            }))
        finally:
            is_ai_speaking = False

    try:
        while True:
            message = await websocket.receive()

            if "text" in message:
                ctrl = message["text"].strip()

                if ctrl == "VAD_SILENCE":
                    if len(audio_buffer) < 3200:
                        audio_buffer.clear()
                        recognizer.Reset()
                        continue

                    recognizer.AcceptWaveform(bytes(audio_buffer))
                    result = json.loads(recognizer.FinalResult())
                    user_text = result.get("text", "").strip()
                    audio_buffer.clear()
                    recognizer.Reset()

                    if not user_text:
                        continue

                    print(f"[Voice] Transcribed: '{user_text}'", flush=True)
                    await cancel_ai()
                    ai_task = asyncio.create_task(respond_to_user(user_text))

                elif ctrl == "INTERRUPT":
                    print("[Voice] Barge-in", flush=True)
                    await cancel_ai()
                    audio_buffer.clear()
                    recognizer.Reset()

                elif ctrl == "HANGUP":
                    print("[Voice] Hangup", flush=True)
                    await cancel_ai()
                    break

            elif "bytes" in message:
                raw = message["bytes"]
                if not raw:
                    continue

                if is_ai_speaking:
                    pcm = np.frombuffer(raw, dtype=np.int16)
                    rms = int(np.sqrt(np.mean(pcm.astype(np.float32) ** 2)))
                    if rms > BARGE_IN_RMS:
                        print("[Voice] Server barge-in detected", flush=True)
                        await cancel_ai()
                        audio_buffer.clear()
                        recognizer.Reset()

                audio_buffer.extend(raw)
                recognizer.AcceptWaveform(raw)

    except WebSocketDisconnect:
        print("[Voice] Client disconnected", flush=True)
    except Exception as e:
        print(f"[Voice] Unexpected error: {e}", flush=True)
    finally:
        await cancel_ai()
        print("[Voice] Connection closed", flush=True)


# ── Background cache cleanup ──────────────────────────────────────────────────

async def _cleanup_cache():
    while True:
        await asyncio.sleep(600)
        cache.clear()
        print("🧹 Cache cleared", flush=True)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(_cleanup_cache())


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")