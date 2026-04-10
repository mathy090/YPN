// src/utils/pendingAIReply.ts
//
// Persists an in-flight AI reply to AsyncStorage so the stream can be
// resumed if the user navigates away and comes back before the message
// has been fully "streamed" into the chat.
//
// Lifecycle:
//   1. savePendingAIReply(msgId, fullText) — called before streaming starts
//   2. clearPendingAIReply(msgId) — called once streaming finishes cleanly
//   3. getPendingAIReply(msgId) — called on mount to detect interrupted streams
//
// We key by msgId so multiple simultaneous (edge-case) replies don't clash.

import AsyncStorage from "@react-native-async-storage/async-storage";

const PREFIX = "ypn_pending_ai_v1_";

export async function savePendingAIReply(
  msgId: string,
  fullText: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(PREFIX + msgId, fullText);
  } catch (e) {
    console.warn("[PendingAIReply] save failed:", e);
  }
}

export async function getPendingAIReply(msgId: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PREFIX + msgId);
  } catch {
    return null;
  }
}

export async function clearPendingAIReply(msgId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(PREFIX + msgId);
  } catch (e) {
    console.warn("[PendingAIReply] clear failed:", e);
  }
}
