# ypn-ai-service/audio/tts.py
#
# Piper streaming TTS.
# Piper runs as a subprocess so a crash never kills the main server.
# Yields raw PCM chunks (no WAV header) — client reassembles them.
#
# Voice download (run setup_models.sh):
#   en_US-lessac-medium  ~63 MB — fast, natural, good on Render free tier

import asyncio
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

PIPER_BINARY = os.getenv(
    "PIPER_BINARY",
    str(Path(__file__).parent.parent / "bin" / "piper"),
)
PIPER_VOICE = os.getenv(
    "PIPER_VOICE",
    str(
        Path(__file__).parent.parent
        / "models"
        / "en_US-lessac-medium.onnx"
    ),
)

# PCM output config (must match voice model)
PIPER_SAMPLE_RATE = 22_050

# 20ms chunks at 22050Hz = 441 samples = 882 bytes
# Small chunks keep latency low over WebSocket
CHUNK_BYTES = 882

# Cancellation sentinel — checked between chunks
_CANCELLED = object()


async def synthesize_chunks(text: str, cancel_event: asyncio.Event):
    """
    Async generator yielding raw PCM bytes from Piper.
    Stops early if cancel_event is set (barge-in support).
    Yields None when done (clean end sentinel).
    """
    if not text.strip():
        return

    cmd = [
        PIPER_BINARY,
        "--model",            PIPER_VOICE,
        "--output-raw",       # raw PCM to stdout, no WAV header
        "--sentence-silence", "0.15",
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin  = asyncio.subprocess.PIPE,
            stdout = asyncio.subprocess.PIPE,
            stderr = asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        logger.error(f"[TTS] Piper binary not found at {PIPER_BINARY}")
        return

    proc.stdin.write(text.encode("utf-8"))
    await proc.stdin.drain()
    proc.stdin.close()

    try:
        while True:
            if cancel_event.is_set():
                proc.kill()
                logger.debug("[TTS] Synthesis cancelled (barge-in)")
                return

            chunk = await proc.stdout.read(CHUNK_BYTES)
            if not chunk:
                break
            yield chunk
    finally:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        await proc.wait()