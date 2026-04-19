# ypn-ai-service/main.py
#
# Simple, auth-free AI service.
# - /health          → liveness probe
# - /chat            → HTTP text chat (no auth, session_id from body)
# - /ws              → WebSocket voice streaming (Vosk STT → AI → TTS chunks)
#
# Memory: Upstash Redis keyed by session_id (passed by client).
# STT:    Vosk (offline, no API key).
# AI:     Swap run_ai() stub for Cohere/OpenAI/Anthropic as needed.

import asyncio
import base64
import json
import logging
import os
import time
import uuid

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse
from vosk import KaldiRecognizer, Model
from upstash_redis import Redis

from audio.stt import create_recognizer, feed_frame, finalize
from audio.vad import FRAME_BYTES, create_vad, is_speech, SILENCE_FRAMES_THRESHOLD
from prompts import SYSTEM_PROMPT
from retrievers import retrieve

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Redis ─────────────────────────────────────────────────────────────────────
redis = Redis(
    url=os.environ["UPSTASH_REDIS_REST_URL"],
    token=os.environ["UPSTASH_REDIS_REST_TOKEN"],
)

# ── Vosk model (lazy singleton) ───────────────────────────────────────────────
VOSK_MODEL_PATH = os.getenv(
    "VOSK_MODEL_PATH", "models/vosk-model-small-en-us-0.15"
)
_vosk_model: Model | None = None


def get_vosk_model() -> Model | None:
    global _vosk_model
    if _vosk_model is not None:
        return _vosk_model
    if os.path.isdir(VOSK_MODEL_PATH) and os.path.exists(
        os.path.join(VOSK_MODEL_PATH, "conf")
    ):
        try:
            _vosk_model = Model(VOSK_MODEL_PATH)
            logger.info("[Vosk] Model loaded from %s", VOSK_MODEL_PATH)
        except Exception as exc:
            logger.error("[Vosk] Load error: %s", exc)
    else:
        logger.warning("[Vosk] Model not found at %s — STT disabled", VOSK_MODEL_PATH)
    return _vosk_model


# ── Redis helpers ─────────────────────────────────────────────────────────────
HISTORY_TTL = 60 * 60 * 2  # 2 hours
MAX_HISTORY = 20            # keep last N messages


def _chat_key(session_id: str) -> str:
    return f"chat:{session_id}"


def load_history(session_id: str) -> list[dict]:
    raw = redis.get(_chat_key(session_id))
    if not raw:
        return []
    try:
        return json.loads(raw)
    except Exception:
        return []


def save_history(session_id: str, history: list[dict]) -> None:
    trimmed = history[-MAX_HISTORY:]
    redis.set(_chat_key(session_id), json.dumps(trimmed), ex=HISTORY_TTL)


def append_message(session_id: str, role: str, text: str) -> list[dict]:
    history = load_history(session_id)
    history.append({"role": role, "text": text, "t": time.time()})
    save_history(session_id, history)
    return history


# ── AI stub ───────────────────────────────────────────────────────────────────
# Replace the body of run_ai() with your real LLM call (Cohere, OpenAI, etc.)
async def run_ai(prompt: str) -> str:
    """Return a response string. Swap for real LLM integration."""
    await asyncio.sleep(0.1)
    return (
        "I hear you. I'm here to support you — could you tell me more "
        "about what's on your mind?"
    )


def build_prompt(session_id: str, user_text: str) -> str:
    history = load_history(session_id)
    context = retrieve(user_text, history)
    return (
        f"{SYSTEM_PROMPT}\n\n"
        f"Conversation:\n{json.dumps(history)}\n\n"
        f"Context:\n{json.dumps(context)}\n\n"
        f"User:\n{user_text}"
    )


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="YPN AI Service")


# ── /health ───────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok"}


# ── /chat (HTTP, no auth) ─────────────────────────────────────────────────────
# Body: { "message": "...", "session_id": "..." (optional) }
# Returns: { "reply": "...", "session_id": "..." }
@app.post("/chat")
async def http_chat(body: dict):
    user_text = (body.get("message") or "").strip()
    if not user_text:
        return JSONResponse({"reply": "", "session_id": ""})

    # Use caller-supplied session_id or generate a new one.
    # The React Native app should persist this per-conversation.
    session_id: str = (body.get("session_id") or "").strip() or str(uuid.uuid4())

    append_message(session_id, "user", user_text)
    prompt = build_prompt(session_id, user_text)
    reply = await run_ai(prompt)
    append_message(session_id, "ai", reply)

    return JSONResponse({"reply": reply, "session_id": session_id})


# ── /ws (WebSocket voice streaming, no auth) ──────────────────────────────────
#
# Protocol (client → server):
#   { "type": "init",  "session_id": "<id>" }   ← first frame, required
#   { "type": "audio", "data": "<base64 PCM>" }  ← raw 16 kHz mono int16 chunks
#   { "type": "text",  "message": "<text>" }     ← direct text (skips STT)
#   { "type": "interrupt" }                       ← cancel current reply
#   { "type": "end_call" }                        ← graceful close
#
# Protocol (server → client):
#   { "type": "partial",    "text": "..."  }      ← STT partial transcript
#   { "type": "transcript", "text": "..."  }      ← STT final transcript
#   { "type": "thinking"                   }      ← AI is working
#   { "type": "ai_token",  "text": "..."  }       ← streaming AI word
#   { "type": "done"                       }      ← reply complete
#   { "type": "tts_chunk", "data": "<b64>","sample_rate":22050 } ← audio out
#   { "type": "tts_end"                    }
#   { "type": "error",     "message":"..." }

@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()

    session_id: str | None = None
    vad = create_vad()
    recognizer: KaldiRecognizer | None = None
    pcm_buffer = b""
    silence_frames = 0
    speaking = False
    interrupt_flag = False

    model = get_vosk_model()
    if model:
        recognizer = create_recognizer()

    async def send(payload: dict):
        try:
            await websocket.send_json(payload)
        except Exception:
            pass

    async def stream_ai_reply(text: str) -> None:
        """Send AI reply word-by-word as ai_token frames, then 'done'."""
        nonlocal interrupt_flag
        interrupt_flag = False
        append_message(session_id, "user", text)
        prompt = build_prompt(session_id, text)

        await send({"type": "thinking"})
        reply = await run_ai(prompt)
        append_message(session_id, "ai", reply)

        for word in reply.split():
            if interrupt_flag:
                break
            await send({"type": "ai_token", "text": word + " "})
            await asyncio.sleep(0.03)

        await send({"type": "done"})

    try:
        # ── first message must be "init" ──────────────────────────────────
        init_raw = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)
        if init_raw.get("type") != "init":
            await send({"type": "error", "message": "First message must be {type:'init'}"})
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        session_id = (init_raw.get("session_id") or "").strip() or str(uuid.uuid4())
        await send({"type": "ready", "session_id": session_id})
        logger.info("[WS] Session started: %s", session_id)

        # ── main loop ─────────────────────────────────────────────────────
        while True:
            msg = await websocket.receive_json()
            msg_type = msg.get("type")

            # ── interrupt ─────────────────────────────────────────────────
            if msg_type == "interrupt":
                interrupt_flag = True
                continue

            # ── end call ──────────────────────────────────────────────────
            if msg_type == "end_call":
                break

            # ── direct text (bypass STT) ──────────────────────────────────
            if msg_type == "text":
                user_text = (msg.get("message") or "").strip()
                if user_text:
                    await send({"type": "transcript", "text": user_text})
                    asyncio.create_task(stream_ai_reply(user_text))
                continue

            # ── audio chunk ───────────────────────────────────────────────
            if msg_type == "audio":
                raw_b64 = msg.get("data", "")
                try:
                    pcm_chunk = base64.b64decode(raw_b64)
                except Exception:
                    continue

                if not recognizer:
                    # Vosk not available — skip STT silently
                    continue

                pcm_buffer += pcm_chunk

                # Process complete 30 ms frames
                while len(pcm_buffer) >= FRAME_BYTES:
                    frame = pcm_buffer[:FRAME_BYTES]
                    pcm_buffer = pcm_buffer[FRAME_BYTES:]

                    voiced = is_speech(vad, frame)

                    if voiced:
                        silence_frames = 0
                        if not speaking:
                            speaking = True
                            logger.debug("[VAD] Speech started")

                        partial_text = feed_frame(recognizer, frame)
                        if partial_text:
                            await send({"type": "partial", "text": partial_text})

                    else:
                        if speaking:
                            silence_frames += 1
                            if silence_frames >= SILENCE_FRAMES_THRESHOLD:
                                # Utterance complete
                                final = finalize(recognizer)
                                speaking = False
                                silence_frames = 0
                                pcm_buffer = b""

                                # Fresh recognizer for next utterance
                                recognizer = create_recognizer()

                                if final:
                                    await send({"type": "transcript", "text": final})
                                    asyncio.create_task(stream_ai_reply(final))

    except WebSocketDisconnect:
        logger.info("[WS] Disconnected: %s", session_id)
    except asyncio.TimeoutError:
        await send({"type": "error", "message": "Init timeout — send {type:'init'} first"})
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
    except Exception as exc:
        logger.exception("[WS] Unhandled error in session %s: %s", session_id, exc)
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except Exception:
            pass