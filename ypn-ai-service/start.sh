#!/usr/bin/env bash
# ypn-ai-service/start.sh
# Render start command: bash start.sh
set -e

echo "[Start] Downloading models if needed…"
python download_models.py

echo "[Start] Starting YPN AI server…"
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-10000}"