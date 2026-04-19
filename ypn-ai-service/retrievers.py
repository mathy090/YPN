# retrievers.py
import logging
import json
from typing import Union, List, Dict, Any

logger = logging.getLogger(__name__)


def get_recent_context(
    memory: Union[Dict[str, Any], List[Dict[str, Any]]], 
    max_messages: int = 10
) -> List[Dict[str, str]]:
    """
    Extract recent messages from chat history.
    Handles both list and dict input formats.
    """
    logger.debug(f"[retrieve] get_recent_context called with memory type: {type(memory).__name__}")
    
    try:
        # Handle dict input (legacy support)
        if isinstance(memory, dict):
            logger.debug(f"[retrieve] memory is dict, keys: {list(memory.keys())}")
            messages = memory.get("messages", [])
            
        # Handle list input (current format from Redis)
        elif isinstance(memory, list):
            logger.debug(f"[retrieve] memory is list with {len(memory)} items")
            messages = memory
            
        else:
            logger.warning(f"[retrieve] Unexpected memory type: {type(memory)}")
            messages = []
        
        # Validate and filter messages
        valid_messages = []
        for i, m in enumerate(messages):
            if isinstance(m, dict) and "role" in m and "text" in m:
                valid_messages.append(m)
            else:
                logger.warning(f"[retrieve] Skipping invalid message at index {i}")
        
        # Get recent messages (last N)
        recent = valid_messages[-max_messages:] if len(valid_messages) > max_messages else valid_messages
        
        # Format for prompt
        formatted = []
        for msg in recent:
            try:
                formatted.append({
                    "role": msg.get("role", "unknown"),
                    "content": msg.get("text", "").strip()
                })
            except Exception as e:
                logger.error(f"[retrieve] Error formatting message: {e}")
                continue
                
        logger.debug(f"[retrieve] Returning {len(formatted)} context messages")
        return formatted
        
    except Exception as e:
        logger.error(f"[retrieve] ERROR in get_recent_context: {e}", exc_info=True)
        return []


def retrieve(
    query: str, 
    chat_history: Union[Dict[str, Any], List[Dict[str, Any]]], 
    max_results: int = 3
) -> Dict[str, Any]:
    """
    Context retriever for chat - prepares context for AI prompt.
    """
    logger.info(f"[retrieve] retrieve() called - query: '{query[:50]}...'")
    
    try:
        memory_context = get_recent_context(chat_history, max_messages=max_results)
        
        result = {
            "memory": memory_context,
            "query": query.strip() if query else "",
            "meta": {
                "history_count": len(chat_history) if isinstance(chat_history, (list, dict)) else 0,
                "context_count": len(memory_context),
                "query_length": len(query) if query else 0
            }
        }
        
        logger.debug(f"[retrieve] retrieve() result meta: {result['meta']}")
        return result
        
    except Exception as e:
        logger.error(f"[retrieve] ERROR in retrieve(): {e}", exc_info=True)
        return {
            "memory": [],
            "query": query.strip() if query else "",
            "meta": {"error": str(e)}
        }