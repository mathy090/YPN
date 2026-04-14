#!/usr/bin/env python3
# ypn-ai-service/download_models.py

import os
import sys
import zipfile
import urllib.request

# ── Paths ─────────────────────────────────────────────
VOSK_MODEL_DIR = os.getenv(
    "VOSK_MODEL_PATH",
    "models/vosk-model-small-en-us-0.15"
)

VOSK_ZIP_URL = (
    "https://alphacephei.com/vosk/models/"
    "vosk-model-small-en-us-0.15.zip"
)

KOKORO_MODEL_FILE = os.getenv(
    "KOKORO_MODEL_PATH",
    "models/kokoro-v0_19.onnx"
)

KOKORO_VOICES_FILE = os.getenv(
    "KOKORO_VOICES_PATH",
    "models/voices.json"
)

KOKORO_MODEL_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
    "model-files/kokoro-v0_19.onnx"
)

KOKORO_VOICES_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
    "model-files/voices.json"
)


# ── Helpers ───────────────────────────────────────────
def download(url: str, dest: str, label: str):
    os.makedirs(os.path.dirname(dest), exist_ok=True)

    print(f"[Models] Downloading {label}...")

    def progress(block_num, block_size, total_size):
        if total_size > 0:
            pct = min(100, block_num * block_size * 100 // total_size)
            print(f"\r[Models] {label}: {pct}%", end="", flush=True)

    urllib.request.urlretrieve(url, dest, reporthook=progress)
    print(f"\n[Models] Saved {label} -> {dest}")


def ensure_vosk():
    if os.path.isdir(VOSK_MODEL_DIR):
        print("[Models] Vosk already exists, skipping.")
        return

    zip_path = VOSK_MODEL_DIR + ".zip"

    download(VOSK_ZIP_URL, zip_path, "Vosk Model")

    print("[Models] Extracting Vosk model...")
    with zipfile.ZipFile(zip_path, "r") as z:
        z.extractall("models")

    os.remove(zip_path)
    print("[Models] Vosk ready.")


def ensure_kokoro():
    if not os.path.exists(KOKORO_MODEL_FILE):
        download(KOKORO_MODEL_URL, KOKORO_MODEL_FILE, "Kokoro Model")
    else:
        print("[Models] Kokoro model exists, skipping.")

    if not os.path.exists(KOKORO_VOICES_FILE):
        download(KOKORO_VOICES_URL, KOKORO_VOICES_FILE, "Kokoro Voices")
    else:
        print("[Models] Kokoro voices exist, skipping.")


# ── Main ──────────────────────────────────────────────
if __name__ == "__main__":
    print("[Models] Checking required AI models...")

    try:
        ensure_vosk()
        ensure_kokoro()
    except Exception as e:
        print(f"[Models] ERROR: {e}")
        sys.exit(1)

    print("[Models] All models ready.")