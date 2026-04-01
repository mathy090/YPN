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

SYSTEM_PROMPT = """You are YPN AI, a warm, helpful assistant for Team YPN — 
a youth empowerment network in Zimbabwe. You help young people with questions 
about careers, mental health, education, and general knowledge. 
Always be kind, accurate, and encouraging. If you don't know something, say so honestly."""

# Simple in-memory session store: { session_id: [messages] }
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


class ChatResponse(BaseModel):
    reply: str
    session_id: str


@app.get("/")
async def root_get():
    return {"status": "YPN AI service alive"}


@app.head("/")
async def root_head():
    return Response(status_code=200)


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    message = req.message.strip()
    session_id = req.session_id.strip() or "default"

    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # Get or create session history
    if session_id not in sessions:
        sessions[session_id] = []

    history = sessions[session_id]

    # Build messages list for Cohere
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    for h in history:
        messages.append({"role": h["role"], "content": h["content"]})

    messages.append({"role": "user", "content": message})

    try:
        response = co.chat(
            model="command-r-plus",
            messages=messages,
            temperature=0.7,
            max_tokens=300,
        )

        reply = response.message.content[0].text.strip()

        # Save to session history (keep last 20 exchanges to avoid token bloat)
        history.append({"role": "user", "content": message})
        history.append({"role": "assistant", "content": reply})
        sessions[session_id] = history[-40:]  # 20 exchanges

        return {"reply": reply, "session_id": session_id}

    except cohere.errors.UnauthorizedError:
        raise HTTPException(status_code=500, detail="Invalid Cohere API key")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    return {"cleared": session_id}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "active_sessions": len(sessions),
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")