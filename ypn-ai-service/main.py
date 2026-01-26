from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
import os
from openai import OpenAI

# Load environment variables from .env
load_dotenv()

# OpenAI client
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

app = FastAPI(title="YPN AI Backend", version="1.0")

# ----------------------
# Root / Health Endpoint
# ----------------------
@app.get("/")
def root():
    return {"status": "ok", "service": "YPN AI Backend"}

# ----------------------
# Chat Endpoint
# ----------------------
class ChatRequest(BaseModel):
    message: str

@app.post("/chat")
async def chat(request: ChatRequest):
    user_message = request.message.strip()

    if not user_message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",  # fast + cheap + strong
            messages=[
                {"role": "system", "content": "You are a helpful AI assistant for YPN Zimbabwe."},
                {"role": "user", "content": user_message}
            ],
            max_tokens=300,
            temperature=0.7
        )

        reply = response.choices[0].message.content
        return {"reply": reply}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ----------------------
# Optional: favicon to reduce 404 spam
# ----------------------
from fastapi.responses import FileResponse

@app.get("/favicon.ico")
def favicon():
    # Create an empty favicon file or place one in your assets folder
    return FileResponse(os.path.join("assets", "favicon.ico"))  # optional

