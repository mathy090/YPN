# ypn-ai-service/main.py
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os
import cohere

load_dotenv()

COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY is not set")

co = cohere.ClientV2(api_key=COHERE_API_KEY)

# Current working model as of 2025
MODEL = "command-r-08-2024"

SYSTEM_PROMPT = (
    "You are YPN AI, a warm and helpful assistant for Team YPN — "
    "a youth empowerment network based in Zimbabwe. "
    "You help young people with questions about careers, education, "
    "mental health, general knowledge, and life advice. "
    "Always be kind, accurate, and encouraging. "
    "Answer questions directly and concisely. "
    "Do not use excessive markdown or bullet points unless asked."
)

# In-memory sessions: { session_id: [ {role, content} ] }
sessions: dict = {}

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"


@app.get("/")
async def root_get():
    return {"status": "YPN AI service alive"}


@app.head("/")
async def root_head():
    return Response(status_code=200)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL,
        "active_sessions": len(sessions),
    }


@app.post("/chat")
async def chat(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"

    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # Build message history for this session
    if session_id not in sessions:
        sessions[session_id] = []

    history = sessions[session_id]

    # Cohere v2 messages format
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(history)
    messages.append({"role": "user", "content": message})

    try:
        response = co.chat(
            model=MODEL,
            messages=messages,
            temperature=0.7,
            max_tokens=500,
        )

        reply = response.message.content[0].text.strip()

        # Save exchange, keep last 20 turns (40 messages) to avoid bloat
        history.append({"role": "user", "content": message})
        history.append({"role": "assistant", "content": reply})
        sessions[session_id] = history[-40:]

        return {"reply": reply, "session_id": session_id}

    except cohere.errors.UnauthorizedError:
        raise HTTPException(status_code=500, detail="Invalid Cohere API key")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    return {"cleared": session_id}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")
