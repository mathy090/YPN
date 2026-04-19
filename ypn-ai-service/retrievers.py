# retrievers.py
import logging
import json
from typing import Union, List, Dict, Any

# Configure logger
logger = logging.getLogger(__name__)


def get_recent_context(
    memory: Union[Dict[str, Any], List[Dict[str, Any]]], 
    max_messages: int = 10
) -> List[Dict[str, str]]:
    """
    Extract recent messages from chat history.
    
    Args:
        memory: Either a list of message dicts OR a dict with "messages" key
        max_messages: Maximum number of recent messages to return
    
    Returns:
        List of simplified message dicts with 'role' and 'content' keys
    """
    logger.debug(f"[retrieve] get_recent_context called with memory type: {type(memory).__name__}")
    
    try:
        # Handle dict input (legacy support)
        if isinstance(memory, dict):
            logger.debug(f"[retrieve] memory is dict, keys: {list(memory.keys())}")
            messages = memory.get("messages", [])
            logger.debug(f"[retrieve] extracted {len(messages)} messages from dict")
            
        # Handle list input (current format from Redis)
        elif isinstance(memory, list):
            logger.debug(f"[retrieve] memory is list with {len(memory)} items")
            messages = memory
            
        # Handle None or unexpected types
        else:
            logger.warning(f"[retrieve] Unexpected memory type: {type(memory)}, value: {memory}")
            messages = []
        
        # Validate messages are dicts with expected keys
        valid_messages = []
        for i, m in enumerate(messages):
            if isinstance(m, dict) and "role" in m and "text" in m:
                valid_messages.append(m)
            else:
                logger.warning(f"[retrieve] Skipping invalid message at index {i}: {type(m)} - {m}")
        
        logger.debug(f"[retrieve] {len(valid_messages)}/{len(messages)} messages are valid")
        
        # Get recent messages (last N)
        recent = valid_messages[-max_messages:] if len(valid_messages) > max_messages else valid_messages
        logger.debug(f"[retrieve] Returning {len(recent)} recent messages")
        
        # Format for prompt: simplify to role + content
        formatted = []
        for msg in recent:
            try:
                formatted.append({
                    "role": msg.get("role", "unknown"),
                    "content": msg.get("text", "").strip()
                })
            except Exception as e:
                logger.error(f"[retrieve] Error formatting message: {e}, msg: {msg}")
                continue
                
        logger.debug(f"[retrieve] Final formatted context: {json.dumps(formatted, ensure_ascii=False)[:200]}...")
        return formatted
        
    except Exception as e:
        logger.error(f"[retrieve] CRITICAL ERROR in get_recent_context: {type(e).__name__}: {e}", exc_info=True)
        return []


def retrieve(
    query: str, 
    chat_history: Union[Dict[str, Any], List[Dict[str, Any]]], 
    max_results: int = 3
) -> Dict[str, Any]:
    """
    Context retriever for chat - prepares context for AI prompt.
    
    Args:
        query: Current user message text
        chat_history: Chat history from Redis (list) or legacy dict wrapper
        max_results: Max historical messages to include in context
    
    Returns:
        dict with "memory" and "query" keys for prompt building
    """
    logger.info(f"[retrieve] retrieve() called - query: '{query[:50]}...', history type: {type(chat_history).__name__}")
    
    try:
        # Get recent context (handles both list and dict)
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
        logger.error(f"[retrieve] CRITICAL ERROR in retrieve(): {type(e).__name__}: {e}", exc_info=True)
        # Return safe fallback so AI can still respond
        return {
            "memory": [],
            "query": query.strip() if query else "",
            "meta": {"error": str(e), "history_count": 0, "context_count": 0}
        }


def format_context_for_prompt(context: Dict[str, Any]) -> str:
    """
    Format retrieved context into a readable string for the AI prompt.
    
    Args:
        context: Output from retrieve() function
    
    Returns:
        Formatted string for inclusion in system prompt
    """
    logger.debug(f"[retrieve] format_context_for_prompt called with context keys: {list(context.keys())}")
    
    try:
        memory = context.get("memory", [])
        query = context.get("query", "")
        
        if not memory:
            logger.debug("[retrieve] No memory context to format")
            return f"Recent conversation: (none)\n\nCurrent query: {query}"
        
        # Format each message
        lines = []
        for msg in memory:
            role = msg.get("role", "unknown").upper()
            content = msg.get("content", "").strip()
            if content:
                lines.append(f"{role}: {content}")
        
        formatted = "\n".join(lines)
        logger.debug(f"[retrieve] Formatted context ({len(lines)} lines): {formatted[:300]}...")
        
        return f"Recent conversation:\n{formatted}\n\nCurrent query: {query}"
        
    except Exception as e:
        logger.error(f"[retrieve] Error formatting context: {e}", exc_info=True)
        return f"Current query: {query}"  # Fallback to just the query