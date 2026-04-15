#!/usr/bin/env bash
set -e

echo "[Start] Starting YPN AI server..."

exec python -m uvicorn main:app --host 0.0.0.0 --port $PORT