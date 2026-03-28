/**
 * MessageQueue.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Offline-first message queue.
 *   • Pending messages persisted in MMKV — survive app restart
 *   • Exponential backoff retry (1s → 2s → 4s → 8s → max 30s)
 *   • Network-aware: flushes automatically when connection restores
 *   • Each queued item has a stable localId for UI "pending" indicator
 * ─────────────────────────────────────────────────────────────────────────────
 */

import NetInfo from "@react-native-community/netinfo";

const mmkv = new MMKV({ id: "ypn-msg-queue-v1" });
const QUEUE_KEY = "pending_messages";
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueuedMessage = {
  localId: string; // stable local ID for UI
  conversationId: string;
  encryptedPayload: {
    ciphertext: string;
    iv: string;
  };
  messageType: "text" | "audio" | "image";
  mediaStoragePath?: string; // Firebase Storage path for media
  mediaIv?: string; // IV for media decryption
  mediaKeyJwk?: string; // AES key for media (embedded in encrypted payload)
  senderUid: string;
  timestamp: number;
  retryCount: number;
  lastAttemptAt: number;
};

type SendFn = (msg: QueuedMessage) => Promise<void>;
type StatusCallback = (localId: string, status: "sent" | "failed") => void;

// ─── Internal state ───────────────────────────────────────────────────────────

let _sendFn: SendFn | null = null;
let _onStatus: StatusCallback | null = null;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _flushing = false;

// ─── Queue persistence ────────────────────────────────────────────────────────

function readQueue(): QueuedMessage[] {
  try {
    const raw = mmkv.getString(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedMessage[]): void {
  mmkv.set(QUEUE_KEY, JSON.stringify(queue));
}

function removeFromQueue(localId: string): void {
  const queue = readQueue().filter((m) => m.localId !== localId);
  writeQueue(queue);
}

function updateRetryCount(localId: string, count: number): void {
  const queue = readQueue().map((m) =>
    m.localId === localId
      ? { ...m, retryCount: count, lastAttemptAt: Date.now() }
      : m,
  );
  writeQueue(queue);
}

// ─── Exported API ─────────────────────────────────────────────────────────────

export const MessageQueue = {
  /**
   * Initialise the queue with a send function and status callback.
   * Call once at app startup (in your chat provider or root component).
   */
  init(sendFn: SendFn, onStatus: StatusCallback): void {
    _sendFn = sendFn;
    _onStatus = onStatus;

    // Listen for network reconnection
    NetInfo.addEventListener((state) => {
      const online =
        (state.isConnected ?? false) && (state.isInternetReachable ?? true);
      if (online) this.flush();
    });

    // Flush any messages left over from previous session
    this.flush();
  },

  /**
   * Add a message to the queue and attempt immediate send.
   */
  enqueue(msg: Omit<QueuedMessage, "retryCount" | "lastAttemptAt">): void {
    const full: QueuedMessage = { ...msg, retryCount: 0, lastAttemptAt: 0 };
    const queue = readQueue();
    queue.push(full);
    writeQueue(queue);
    this.flush();
  },

  /**
   * Returns all pending messages for a given conversation (for UI indicators).
   */
  getPendingForConversation(conversationId: string): QueuedMessage[] {
    return readQueue().filter((m) => m.conversationId === conversationId);
  },

  /**
   * Total pending count (for badge indicators).
   */
  pendingCount(): number {
    return readQueue().length;
  },

  /**
   * Flush the queue — attempt to send all pending messages in order.
   * Skips messages that are in their backoff window.
   */
  async flush(): Promise<void> {
    if (_flushing || !_sendFn) return;
    _flushing = true;

    try {
      const queue = readQueue();
      if (queue.length === 0) return;

      const net = await NetInfo.fetch();
      const online =
        (net.isConnected ?? false) && (net.isInternetReachable ?? true);
      if (!online) return;

      for (const msg of queue) {
        // Backoff window check
        const delay = _backoffDelay(msg.retryCount);
        const nextAttempt = msg.lastAttemptAt + delay;
        if (Date.now() < nextAttempt) continue;

        try {
          await _sendFn(msg);
          removeFromQueue(msg.localId);
          _onStatus?.(msg.localId, "sent");
        } catch (err) {
          const newCount = msg.retryCount + 1;
          if (newCount >= MAX_RETRIES) {
            removeFromQueue(msg.localId);
            _onStatus?.(msg.localId, "failed");
            console.error(
              `[MessageQueue] Message ${msg.localId} permanently failed after ${MAX_RETRIES} retries`,
            );
          } else {
            updateRetryCount(msg.localId, newCount);
            _scheduleFlush(_backoffDelay(newCount));
          }
        }
      }
    } finally {
      _flushing = false;
    }
  },

  /**
   * Remove a message manually (e.g. user deletes unsent message).
   */
  cancel(localId: string): void {
    removeFromQueue(localId);
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _backoffDelay(retryCount: number): number {
  const exp = Math.min(retryCount, 5);
  return Math.min(BASE_DELAY_MS * Math.pow(2, exp), 30_000);
}

function _scheduleFlush(delayMs: number): void {
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => MessageQueue.flush(), delayMs);
}
