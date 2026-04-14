import json
import redis
from datetime import datetime
from supabase import create_client, Client

SUPABASE_URL = "YOUR_SUPABASE_URL"
SUPABASE_KEY = "YOUR_SUPABASE_KEY"

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

redis_client = redis.Redis(host="localhost", port=6379, decode_responses=True)


def _redis_key(session_id: str):
    return f"session:{session_id}"


def load_memory(session_id: str):
    cached = redis_client.get(_redis_key(session_id))
    if cached:
        return json.loads(cached)

    res = supabase.table("memory").select("*").eq("session_id", session_id).execute()

    if res.data:
        memory = res.data[0]["data"]
        redis_client.set(_redis_key(session_id), json.dumps(memory), ex=3600)
        return memory

    return {
        "session_id": session_id,
        "messages": [],
        "emotion_state": "neutral",
        "updated_at": str(datetime.utcnow())
    }


def save_memory(session_id: str, memory: dict):
    memory["updated_at"] = str(datetime.utcnow())

    redis_client.set(_redis_key(session_id), json.dumps(memory), ex=3600)

    supabase.table("memory").upsert({
        "session_id": session_id,
        "data": memory
    }).execute()


def append_message(session_id: str, role: str, content: str):
    memory = load_memory(session_id)

    memory["messages"].append({
        "role": role,
        "content": content,
        "time": str(datetime.utcnow())
    })

    if len(memory["messages"]) > 50:
        memory["messages"] = memory["messages"][-50:]

    save_memory(session_id, memory)


def set_emotion(session_id: str, emotion: str):
    memory = load_memory(session_id)
    memory["emotion_state"] = emotion
    save_memory(session_id, memory)