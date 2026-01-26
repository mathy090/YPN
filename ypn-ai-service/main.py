from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
import os
from openai import OpenAI

# Load environment variables
load_dotenv()

# OpenAI client
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

app = FastAPI()

# =====================
# Models
# =====================
class ChatRequest(BaseModel):
    message: str

# =====================
# Root / health check
# =====================
@app.get("/")
async def root():
    return {"status": "YPN AI service alive"}

# =====================
# Chat endpoint
# =====================
@app.post("/chat")
async def chat(request: ChatRequest):
    user_message = request.message.strip()

    if not user_message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
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


# =====================
# Run server (Render)
# =====================
if __name__ == "__main__":
    port = int(os.getenv("PORT", 10000))
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")



