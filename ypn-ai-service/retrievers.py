# retrievers.py
import logging

logger = logging.getLogger(__name__)


def retrieve(query: str, chat_history: list, max_results: int = 5):
    """
    Simple context retriever - just returns recent messages.
    No complex logic, just pass-through.
    """
    try:
        logger.debug(f"[retrieve] Called with query='{query[:30]}...', history_len={len(chat_history) if chat_history else 0}")
        
        # Just return the last few messages as context
        if not chat_history:
            return {
                "memory": [],
                "query": query,
                "meta": {"history_count": 0, "context_count": 0}
            }
        
        # Get last N messages
        recent = chat_history[-max_results:] if len(chat_history) > max_results else chat_history
        
        # Format simply
        formatted = []
        for msg in recent:
            if isinstance(msg, dict):
                formatted.append({
                    "role": msg.get("role", "unknown"),
                    "content": msg.get("text", "").strip()
                })
        
        logger.debug(f"[retrieve] Returning {len(formatted)} context messages")
        
        return {
            "memory": formatted,
            "query": query,
            "meta": {
                "history_count": len(chat_history),
                "context_count": len(formatted)
            }
        }
        
    except Exception as e:
        logger.error(f"[retrieve] ERROR: {type(e).__name__}: {e}", exc_info=True)
        # Safe fallback - never crash the chat
        return {
            "memory": [],
            "query": query,
            "meta": {"error": str(e), "history_count": 0, "context_count": 0}
        }