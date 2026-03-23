from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os
import cohere
import memory
from prompts import SYSTEM_PROMPT

load_dotenv()

COHERE_API_KEY = os.getenv("COHERE_API_KEY")
if not COHERE_API_KEY:
    raise RuntimeError("COHERE_API_KEY is not set")

co = cohere.ClientV2(api_key=COHERE_API_KEY)

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

@app.post("/chat")
async def chat(req: ChatRequest):
    user_message = req.message.strip()
    session_id = req.session_id.strip() or "default"

    if not user_message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    raw_history = memory.get_history(session_id)
    chat_history = [
        {"role": h["role"], "message": h["message"]}
        for h in raw_history
        if h["role"] in ("USER", "CHATBOT")
    ]

    try:
        response = co.chat(
            model="command-r",
            preamble=SYSTEM_PROMPT,
            chat_history=chat_history,
            message=user_message,
            temperature=0.7,
            max_tokens=200,
        )

        reply = response.message.content[0].text.strip()

        memory.append(session_id, "USER", user_message)
        memory.append(session_id, "CHATBOT", reply)

        return {"reply": reply}

    except cohere.errors.UnauthorizedError:
        raise HTTPException(status_code=500, detail="Invalid Cohere API key")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/chat/{session_id}")
async def clear_session(session_id: str):
    memory.clear(session_id)
    return {"cleared": session_id}

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")