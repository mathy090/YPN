# ypn-ai-service/main.py
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os
import cohere
import asyncio
import hashlib
import json

# Load environment variables
load_dotenv()

COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY is not set")

# Initialize Cohere V2 client
co = cohere.ClientV2(api_key=COHERE_API_KEY)

# Use latest supported model
MODEL = "command-r-plus-08-2024"

# System prompt for AI
SYSTEM_PROMPT = (
    "You are YPN AI, a warm and helpful assistant for Team YPN — "
    "a youth empowerment network based in Zimbabwe. "
    "Be concise, helpful, and natural like ChatGPT. "
    "Avoid long explanations unless asked."
)

# In-memory sessions: { session_id: [ {role, content} ] }
sessions: dict = {}

# Simple in-memory cache for repeated questions
cache: dict = {}

# FastAPI app
app = FastAPI()

# Allow all CORS (for frontend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request model
class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"


# Helper: trim history to last n turns
def trim_history(history, limit=6):
    return history[-limit:]


# Helper: build messages for Cohere
def build_messages(history, message):
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    msgs.extend(history)
    msgs.append({"role": "user", "content": message})
    return msgs


# Helper: cache key generator
def cache_key(session_id, message, history):
    raw = session_id + message + json.dumps(history)
    return hashlib.md5(raw.encode()).hexdigest()


# ------------------- Endpoints -------------------

@app.get("/")
async def root():
    return {"status": "⚡ YPN AI FAST MODE"}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL,
        "active_sessions": len(sessions),
        "cache_size": len(cache),
    }


# Normal chat endpoint (JSON)
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

    # Return cached reply if available
    if key in cache:
        return {"reply": cache[key], "cached": True}

    try:
        response = co.chat(
            model=MODEL,
            messages=build_messages(history, message),
            temperature=0.7,
            max_tokens=200,  # limit for faster responses
        )

        reply = response.message.content[0].text.strip()

        # Save session
        sessions[session_id].append({"role": "user", "content": message})
        sessions[session_id].append({"role": "assistant", "content": reply})
        sessions[session_id] = sessions[session_id][-20:]  # keep last 20 turns

        # Cache result
        cache[key] = reply

        return {"reply": reply, "cached": False}

    except Exception as e:
        raise HTTPException(500, str(e))


# Streaming chat endpoint (ChatGPT-like)
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
                # Cohere V2 streaming event
                if event.type == "content-delta":
                    chunk = event.delta.message.content.text
                    if chunk:
                        full_text += chunk
                        yield chunk
                        await asyncio.sleep(0.01)  # smooth typing effect

            # Save session after streaming ends
            sessions[session_id].append({"role": "user", "content": message})
            sessions[session_id].append({"role": "assistant", "content": full_text})
            sessions[session_id] = sessions[session_id][-20:]

        except Exception as e:
            yield "⚠️ Error: " + str(e)

    return StreamingResponse(generate(), media_type="text/plain")


# Clear session
@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    return {"cleared": session_id}


# ------------------- Background Tasks -------------------

# Periodic cache cleanup
async def cleanup_cache():
    while True:
        await asyncio.sleep(600)  # every 10 minutes
        cache.clear()
        print("🧹 Cache cleared")


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_cache())


# ------------------- Run -------------------

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")s