from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel
from dotenv import load_dotenv
import os
from openai import OpenAI
import cohere  # Cohere Chat API

# =====================
# Load environment
# =====================
load_dotenv()

# =====================
# OpenAI clients
# =====================
client1 = OpenAI(api_key=os.getenv("OPENAI_API_KEY1"))
client2 = OpenAI(api_key=os.getenv("OPENAI_API_KEY2"))

# =====================
# Cohere client (fallback)
# =====================
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

    last_exception = None

    # --- Try OpenAI first ---
    for api_name, client in [("OpenAI Key 1", client1), ("OpenAI Key 2", client2)]:
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
            last_exception = e
            continue  # try next key if quota or other error

    # --- Fallback to Cohere Chat API ---
    try:
        response = co.chat(
            model="command-xlarge-nightly",
            messages=[
                {"role": "system", "content": "You are a helpful AI assistant for YPN Zimbabwe."},
                {"role": "user", "content": user_message}
            ],
            max_output_tokens=300
        )
        reply = response.output[0].content
        return {"reply": reply}

    except Exception as e:
        last_exception = e

    # --- If all APIs fail ---
    raise HTTPException(status_code=500, detail=f"All AI APIs failed. Last error: {last_exception}")

# =====================
# Run server (Render)
# =====================
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")

