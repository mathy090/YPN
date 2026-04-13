#!/usr/bin/env python3
# ypn-ai-service/download_models.py
#
# Run once before starting the server on Render.
# Downloads Vosk small English model and Kokoro ONNX files if not present.
# Called from start.sh before uvicorn.

import os
import sys
import zipfile
import urllib.request
import json

# ── Vosk ──────────────────────────────────────────────────────────────────────
VOSK_MODEL_DIR = os.getenv("VOSK_MODEL_PATH", "vosk-model-small-en-us-0.15")
VOSK_ZIP_URL = (
    "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
)

# ── Kokoro ONNX ───────────────────────────────────────────────────────────────
KOKORO_MODEL_FILE = os.getenv("KOKORO_MODEL_PATH", "kokoro-v0_19.onnx")
KOKORO_VOICES_FILE = os.getenv("KOKORO_VOICES_PATH", "voices.json")

KOKORO_MODEL_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
    "model-files/kokoro-v0_19.onnx"
)
KOKORO_VOICES_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
    "model-files/voices.json"
)


def download(url: str, dest: str, label: str) -> None:
    print(f"[Models] Downloading {label}…", flush=True)

    def progress(block_num, block_size, total_size):
        if total_size > 0:
            pct = min(100, block_num * block_size * 100 // total_size)
            print(f"\r[Models] {label}: {pct}%", end="", flush=True)

    urllib.request.urlretrieve(url, dest, reporthook=progress)
    print(f"\n[Models] {label} saved to {dest}", flush=True)


def ensure_vosk():
    if os.path.isdir(VOSK_MODEL_DIR):
        print(f"[Models] Vosk model already present at '{VOSK_MODEL_DIR}'")
        return

    zip_path = VOSK_MODEL_DIR + ".zip"
    try:
        download(VOSK_ZIP_URL, zip_path, "Vosk model")
        print(f"[Models] Extracting {zip_path}…", flush=True)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(".")
        os.remove(zip_path)
        print(f"[Models] Vosk model ready at '{VOSK_MODEL_DIR}'", flush=True)
    except Exception as e:
        print(f"[Models] ERROR downloading Vosk: {e}", flush=True)
        sys.exit(1)


def ensure_kokoro():
    if not os.path.exists(KOKORO_MODEL_FILE):
        try:
            download(KOKORO_MODEL_URL, KOKORO_MODEL_FILE, "Kokoro ONNX model")
        except Exception as e:
            print(f"[Models] ERROR downloading Kokoro model: {e}", flush=True)
            sys.exit(1)
    else:
        print(f"[Models] Kokoro model already present at '{KOKORO_MODEL_FILE}'")

    if not os.path.exists(KOKORO_VOICES_FILE):
        try:
            download(KOKORO_VOICES_URL, KOKORO_VOICES_FILE, "Kokoro voices")
        except Exception as e:
            print(f"[Models] ERROR downloading Kokoro voices: {e}", flush=True)
            sys.exit(1)
    else:
        print(f"[Models] Kokoro voices already present at '{KOKORO_VOICES_FILE}'")


if __name__ == "__main__":
    print("[Models] Checking model files…", flush=True)
    ensure_vosk()
    ensure_kokoro()
    print("[Models] All models ready.", flush=True)