from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import os
import cohere
import memory
from prompts import SYSTEM_PROMPT
import asyncio
import time
from collections import defaultdict, deque
import json

load_dotenv()

COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY is not set")

co = cohere.ClientV2(api_key=COHERE_API_KEY)

app = FastAPI(title="YPN AI Chat Backend")

# ------------------ CORS ------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------ RATE LIMITING ------------------
# OpenAI-style: burst + sustained
RATE_LIMIT = 10         # max requests
RATE_WINDOW = 10        # per seconds

rate_store = defaultdict(lambda: deque())

def check_rate_limit(key: str):
    now = time.time()
    queue = rate_store[key]

    # Remove old requests
    while queue and queue[0] < now - RATE_WINDOW:
        queue.popleft()

    if len(queue) >= RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Slow down."
        )

    queue.append(now)

# ------------------ MODELS ------------------
class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"

# ------------------ BASIC ROUTES ------------------
@app.get("/")
async def root():
    return {"status": "YPN AI service alive"}

@app.head("/")
async def root_head():
    return Response(status_code=200)

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "ai": "online",
        "model": "command-r"
    }

# ------------------ STREAM CHAT (REAL DOUBLE TICK) ------------------
@app.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request):
    user_message = req.message.strip()
    session_id = req.session_id.strip() or "default"

    if not user_message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # Rate limit (IP + session)
    client_ip = request.client.host
    rate_key = f"{client_ip}:{session_id}"
    check_rate_limit(rate_key)

    # Prepare history
    raw_history = memory.get_history(session_id)
    chat_history = [
        {"role": h["role"], "message": h["message"]}
        for h in raw_history
        if h["role"] in ("USER", "CHATBOT")
    ]

    async def event_generator():
        try:
            # ------------------ TICK 1 ------------------
            # Message received & stored
            memory.append(session_id, "USER", user_message)

            yield f"data: {json.dumps({'type': 'status', 'status': 'received'})}\n\n"

            await asyncio.sleep(0.1)

            # ------------------ AI RESPONSE ------------------
            response = co.chat(
                model="command-r",
                preamble=SYSTEM_PROMPT,
                chat_history=chat_history,
                message=user_message,
                temperature=0.7,
                max_tokens=200,
            )

            reply = response.message.content[0].text.strip()

            # Simulate streaming tokens (since Cohere full streaming may vary)
            words = reply.split()

            built = ""
            for word in words:
                built += word + " "
                yield f"data: {json.dumps({'type': 'chunk', 'content': built.strip()})}\n\n"
                await asyncio.sleep(0.03)  # typing effect

            # Save final response
            memory.append(session_id, "CHATBOT", reply)

            # ------------------ TICK 2 ------------------
            yield f"data: {json.dumps({'type': 'status', 'status': 'delivered'})}\n\n"

            # Final message
            yield f"data: {json.dumps({'type': 'done', 'reply': reply})}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# ------------------ FALLBACK NORMAL CHAT ------------------
@app.post("/chat")
async def chat(req: ChatRequest, request: Request):
    user_message = req.message.strip()
    session_id = req.session_id.strip() or "default"

    if not user_message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    client_ip = request.client.host
    rate_key = f"{client_ip}:{session_id}"
    check_rate_limit(rate_key)

    raw_history = memory.get_history(session_id)
    chat_history = [
        {"role": h["role"], "message": h["message"]}
        for h in raw_history
        if h["role"] in ("USER", "CHATBOT")
    ]

    try:
        memory.append(session_id, "USER", user_message)

        response = co.chat(
            model="command-r",
            preamble=SYSTEM_PROMPT,
            chat_history=chat_history,
            message=user_message,
            temperature=0.7,
            max_tokens=200,
        )

        reply = response.message.content[0].text.strip()

        memory.append(session_id, "CHATBOT", reply)

        return {
            "reply": reply,
            "status": "delivered"
        }

    except cohere.errors.UnauthorizedError:
        raise HTTPException(status_code=500, detail="Invalid Cohere API key")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ------------------ CLEAR SESSION ------------------
@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    memory.clear(session_id)
    return {"cleared": session_id}

# ------------------ RUN ------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")