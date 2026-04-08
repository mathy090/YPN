// src/errorHandlerAIchat/deleteHandler.ts
// Local-only message deletion — removes from state + AsyncStorage cache.
// Never touches the AI service or any remote store.

import { cacheTeamYPNMessages, TeamYPNMessage } from "../utils/teamypncache";
import { logChatError } from "./errorLogger";

/**
 * Removes one message by id, persists the new array to cache,
 * and returns the updated array for React state.
 *
 * Usage:
 *   setMessages(prev =>
 *     deleteMessage(prev as TeamYPNMessage[], id) as Message[]
 *   );
 */
export function deleteMessage(
  messages: TeamYPNMessage[],
  targetId: string,
): TeamYPNMessage[] {
  const next = messages.filter((m) => m.id !== targetId);
  cacheTeamYPNMessages(next.slice(-100)).catch((err) =>
    logChatError("deleteHandler.persist", err, { messageId: targetId }),
  );
  return next;
}

/**
 * Batch delete — removes every id in the provided Set.
 * Useful for "clear conversation".
 */
export function deleteMessages(
  messages: TeamYPNMessage[],
  ids: Set<string>,
): TeamYPNMessage[] {
  const next = messages.filter((m) => !ids.has(m.id));
  cacheTeamYPNMessages(next.slice(-100)).catch((err) =>
    logChatError("deleteHandler.batchPersist", err),
  );
  return next;
}
