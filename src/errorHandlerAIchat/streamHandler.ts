// src/errorHandlerAIchat/streamHandler.ts
//
// Drives the typewriter animation for AI replies.
// Works even when the user has navigated away — React state
// updates are batched and the interval keeps running.

import { MutableRefObject } from "react";
import { Message } from "../types/chat";
import {
  clearPendingAIReply,
  savePendingAIReply,
} from "../utils/pendingAIReply";
import { incrementTeamYPNUnreadBadge } from "../utils/teamYPNBadge";

const CHARS_PER_TICK = 3; // characters revealed per tick — feel free to tune
const TICK_MS = 18; // ms between ticks  (~55 fps)

type SetMessages = React.Dispatch<React.SetStateAction<Message[]>>;
type ScrollToBottom = () => void;

/**
 * resumeOrStartAIStream
 *
 * 1. Saves full reply to AsyncStorage (crash-safe)
 * 2. Runs typewriter animation via setInterval
 * 3. Calls scrollToBottom on each tick so the list follows
 * 4. Clears saved reply once streaming finishes cleanly
 * 5. Increments unread badge if user left the screen while streaming
 */
export async function resumeOrStartAIStream(
  msgId: string,
  fullText: string,
  setMessages: SetMessages,
  isChatOpenRef: MutableRefObject<boolean>,
  scrollToBottom?: ScrollToBottom,
): Promise<void> {
  // Persist before we start so a crash mid-stream can be recovered
  await savePendingAIReply(msgId, fullText);

  let revealed = 0;
  const total = fullText.length;

  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      revealed = Math.min(revealed + CHARS_PER_TICK, total);
      const partial = fullText.slice(0, revealed);
      const finished = revealed >= total;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? { ...m, text: partial, status: finished ? "read" : "sent" }
            : m,
        ),
      );

      // Keep the list scrolled to the bottom while text grows
      scrollToBottom?.();

      if (finished) {
        clearInterval(tick);
        resolve();
      }
    }, TICK_MS);
  });

  // Clean up persistence record
  await clearPendingAIReply(msgId);

  // Badge: only if user navigated away before streaming finished
  if (!isChatOpenRef.current) {
    await incrementTeamYPNUnreadBadge();
  }
}
