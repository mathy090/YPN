from knowledge_store import search as keyword_search


def get_recent_context(memory: dict, limit: int = 10):
    messages = memory.get("messages", [])
    return messages[-limit:] if messages else []


def semantic_search(query: str):
    # placeholder for later embeddings upgrade
    return []


def retrieve(query: str, session_memory: dict):
    return {
        "memory": get_recent_context(session_memory),
        "keyword": keyword_search(query),
        "semantic": semantic_search(query)
    }