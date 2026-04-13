# ypn-ai-service/audio/stt.py
#
# Vosk streaming STT.
# One KaldiRecognizer per utterance — created fresh so state never
# bleeds across turns. The recognizer is discarded after finalize().
#
# Model download (run setup_models.sh):
#   vosk-model-small-en-us-0.15  ~40 MB — fast, good accuracy on mobile mic

import json
import logging
import os
from pathlib import Path

from vosk import KaldiRecognizer, Model

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
MODEL_PATH  = os.getenv(
    "VOSK_MODEL_PATH",
    str(Path(__file__).parent.parent / "models" / "vosk-model-small-en-us-0.15"),
)

# Singleton model — loaded once at first use, reused across all sessions
_model: Model | None = None


def _get_model() -> Model:
    global _model
    if _model is None:
        if not Path(MODEL_PATH).exists():
            raise RuntimeError(
                f"[STT] Vosk model not found at {MODEL_PATH}.\n"
                "Run: bash setup_models.sh"
            )
        logger.info(f"[STT] Loading Vosk model from {MODEL_PATH} …")
        _model = Model(MODEL_PATH)
        logger.info("[STT] Model loaded ✓")
    return _model


def create_recognizer() -> KaldiRecognizer:
    """Fresh recognizer per utterance — never reuse across turns."""
    return KaldiRecognizer(_get_model(), float(SAMPLE_RATE))


def feed_frame(recognizer: KaldiRecognizer, pcm_frame: bytes) -> str | None:
    """
    Feed one 30ms PCM frame.
    Returns a partial transcript string on word boundary, else None.
    """
    if recognizer.AcceptWaveform(pcm_frame):
        result = json.loads(recognizer.Result())
        text   = result.get("text", "").strip()
        return text if text else None
    return None


def finalize(recognizer: KaldiRecognizer) -> str:
    """Flush remaining audio and return the final transcript."""
    result = json.loads(recognizer.FinalResult())
    return result.get("text", "").strip()