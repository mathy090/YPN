from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel
from dotenv import load_dotenv
import os
import cohere  # Cohere Chat API

# =====================
# Load environment
# =====================
load_dotenv()

# Cohere client
co = cohere.Client(api_key=os.getenv("COHERE_API_KEY"))

# =====================
# FastAPI app
# =====================
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
async def root_get():
    return {"status": "YPN AI service alive"}

@app.head("/")
async def root_head():
    return Response(status_code=200)

# =====================
# Chat endpoint
# =====================
@app.post("/chat")
async def chat(request: ChatRequest):
    user_message = request.message.strip()
    if not user_message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    try:
        # Cohere chat expects message as a string
        prompt = f"You are a helpful AI assistant for YPN Zimbabwe.\nUser: {user_message}\nAI:"

        response = co.chat(
            model="command-xlarge-nightly",
            message=prompt,
            max_tokens=300,
            temperature=0.7
        )

        reply = response.output[0].content.strip()
        return {"reply": reply}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cohere API failed: {e}")

# =====================
# Run server (Render)
# =====================
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")



