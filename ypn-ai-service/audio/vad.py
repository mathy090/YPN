# ypn-ai-service/audio/vad.py
#
# WebRTC VAD wrapper.
# webrtcvad only accepts 10ms, 20ms, or 30ms frames at 16kHz.
# We use 30ms frames = 480 samples = 960 bytes (int16).
#
# SECURITY: no user data stored — all processing is in-memory per frame.

import webrtcvad

SAMPLE_RATE       = 16_000          # Hz — must match frontend
FRAME_DURATION_MS = 30              # ms per frame fed to VAD
FRAME_SAMPLES     = SAMPLE_RATE * FRAME_DURATION_MS // 1000   # 480
FRAME_BYTES       = FRAME_SAMPLES * 2                          # 960 (int16)

# VAD aggressiveness: 0 (least aggressive) → 3 (most aggressive)
# 2 = good balance for noisy environments (typical mobile mic)
VAD_AGGRESSIVENESS = 2

# How many consecutive silent frames before we consider the utterance done
# 800 ms / 30 ms = ~27 frames
SILENCE_FRAMES_THRESHOLD = 27


def create_vad() -> webrtcvad.Vad:
    vad = webrtcvad.Vad()
    vad.set_mode(VAD_AGGRESSIVENESS)
    return vad


def is_speech(vad: webrtcvad.Vad, frame: bytes) -> bool:
    """
    frame must be exactly FRAME_BYTES of 16kHz mono int16 PCM.
    Returns True if VAD thinks this frame contains speech.
    """
    if len(frame) != FRAME_BYTES:
        return False
    try:
        return vad.is_speech(frame, SAMPLE_RATE)
    except Exception:
        return False