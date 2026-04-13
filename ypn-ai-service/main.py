# ypn-ai-service/main.py
import os
import json
import asyncio
import cohere
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

# ── Configuration ──────────────────────────────────────────────────────────────
COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY missing")

co = cohere.ClientV2(api_key=COHERE_API_KEY)
MODEL = "command-r-plus-08-2024"

SYSTEM_PROMPT = (
    "You are YPN AI, a warm assistant for Team YPN (Zimbabwe). "
    "Be concise, helpful, and natural. Keep replies short (2-3 sentences). "
    "Treat every user input as a standalone question; do not reference past conversations."
)

app = FastAPI(title="YPN AI Stateless WS")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Lazy Load Vosk (Only loaded once per worker) ─────────────────────────────
_vosk_model = None
def get_vosk():
    global _vosk_model
    if _vosk_model is None:
        from vosk import Model
        path = os.getenv("VOSK_MODEL_PATH", "vosk-model-small-en-us-0.15")
        print(f"[Vosk] Loading model from {path}...")
        _vosk_model = Model(path)
        print("[Vosk] Model loaded.")
    return _vosk_model

# ── Helper: Get Reply (STATELESS - No History) ───────────────────────────────
def get_reply(text: str) -> str:
    # Only System Prompt + Current User Message. No history list.
    msgs = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": text}
    ]
    
    try:
        resp = co.chat(model=MODEL, messages=msgs, max_tokens=150, temperature=0.7)
        return resp.message.content[0].text.strip()
    except Exception as e:
        print(f"Cohere Error: {e}")
        return "I'm having trouble thinking right now."

# ── Health Check ──────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status": "ok", 
        "vosk_ready": get_vosk() is not None, 
        "mode": "Stateless WebSocket (No History)"
    }

# ── Unified WebSocket Endpoint ───────────────────────────────────────────────
@app.websocket("/voice")
async def hybrid_ws(websocket: WebSocket):
    await websocket.accept()
    print("[WS] Client connected (Stateless Mode).")
    
    # Initialize Vosk for this connection
    model = get_vosk()
    from vosk import KaldiRecognizer
    rec = KaldiRecognizer(model, 16000) 
    
    is_processing = False
    
    try:
        while True:
            message = await websocket.receive()
            
            # ── CASE 1: BINARY AUDIO (Voice) ─────────────────────────────────
            if "bytes" in message:
                audio_data = message["bytes"]
                
                if rec.AcceptWaveform(audio_data):
                    result = json.loads(rec.Result())
                    current_transcript = result.get("text", "")
                    
                    if current_transcript and not is_processing:
                        is_processing = True
                        print(f"[Voice] Heard: {current_transcript}")
                        
                        # Send Transcript to Client
                        await websocket.send_json({
                            "type": "transcript_final",
                            "text": current_transcript
                        })
                        
                        # Get AI Reply (Stateless)
                        loop = asyncio.get_event_loop()
                        reply = await loop.run_in_executor(None, get_reply, current_transcript)
                        
                        print(f"[AI] Reply: {reply}")
                        
                        # Send Reply
                        await websocket.send_json({
                            "type": "reply",
                            "text": reply
                        })
                        await websocket.send_json({"type": "done"})
                        
                        is_processing = False
                        rec.Reset() # Reset for next sentence
                
                else:
                    # Partial Result (Live Typing)
                    partial = json.loads(rec.PartialResult())
                    p_text = partial.get("partial", "")
                    if p_text:
                        await websocket.send_json({
                            "type": "transcript_partial",
                            "text": p_text
                        })

            # ── CASE 2: TEXT MESSAGE (Chat) ──────────────────────────────────
            elif "text" in message:
                try:
                    data = json.loads(message["text"])
                    
                    if data.get("type") == "interrupt":
                        is_processing = False
                        rec.Reset()
                        continue
                    
                    if data.get("type") == "chat":
                        user_text = data.get("text", "").strip()
                        if not user_text:
                            continue
                            
                        print(f"[Text] Received: {user_text}")
                        
                        # Get AI Reply (Stateless)
                        loop = asyncio.get_event_loop()
                        reply = await loop.run_in_executor(None, get_reply, user_text)
                        
                        print(f"[AI] Reply: {reply}")
                        
                        await websocket.send_json({
                            "type": "reply",
                            "text": reply
                        })
                        await websocket.send_json({"type": "done"})
                        
                except json.JSONDecodeError:
                    pass

    except WebSocketDisconnect:
        print("[WS] Client disconnected.")
    except Exception as e:
        print(f"[WS] Error: {e}")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")