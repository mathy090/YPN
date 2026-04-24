import { cacheDiscordMessages, getCachedDiscordMessages } from "./cache";

// ─────────────────────────────────────────────────────────────
// Discord Cache Write Queue (Fixes SQLite Transaction Collisions)
// ─────────────────────────────────────────────────────────────

type CachedMessage = {
  id: string;
  channel_id?: string;
  created_at?: string;
  [key: string]: any;
};

// ── In-memory buffer per channel ─────────────────────────────
const queue: Map<string, CachedMessage[]> = new Map();

// ── Flush lock (prevents overlapping DB writes) ─────────────
let isFlushing = false;

// ── Debounce timers per channel ─────────────────────────────
const timers: Map<string, NodeJS.Timeout> = new Map();

// ─────────────────────────────────────────────────────────────
// Queue messages instead of writing directly to SQLite
// ─────────────────────────────────────────────────────────────
export const queueCacheDiscordMessages = (
  channelId: string,
  messages: CachedMessage[],
) => {
  if (!channelId || !messages?.length) return;

  const existing = queue.get(channelId) ?? [];

  // ── Merge + deduplicate by message ID ──
  const map = new Map<string, CachedMessage>();

  for (const msg of existing) {
    map.set(msg.id, msg);
  }

  for (const msg of messages) {
    map.set(msg.id, msg);
  }

  const merged = Array.from(map.values());

  queue.set(channelId, merged);

  // ── Debounce flush (avoid spam writes) ──
  if (timers.has(channelId)) {
    clearTimeout(timers.get(channelId)!);
  }

  timers.set(
    channelId,
    setTimeout(() => {
      flushQueue(channelId);
    }, 800), // small delay batches writes
  );
};

// ─────────────────────────────────────────────────────────────
// Flush queue safely (ONE SQLite transaction at a time)
// ─────────────────────────────────────────────────────────────
export const flushQueue = async (channelId?: string) => {
  if (isFlushing) return;

  try {
    isFlushing = true;

    // ── Flush single channel ──
    if (channelId) {
      const data = queue.get(channelId);
      if (!data?.length) return;

      await cacheDiscordMessages(channelId, data);
      queue.delete(channelId);
      return;
    }

    // ── Flush all channels ──
    for (const [id, messages] of queue.entries()) {
      if (!messages.length) continue;

      await cacheDiscordMessages(id, messages);
      queue.delete(id);
    }
  } catch (e) {
    console.warn("[CacheQueue] Flush failed:", e);
  } finally {
    isFlushing = false;
  }
};

// ─────────────────────────────────────────────────────────────
// Force flush (use on app background / logout)
// ─────────────────────────────────────────────────────────────
export const forceFlushCacheQueue = async () => {
  await flushQueue();
};

// ─────────────────────────────────────────────────────────────
// Optional: preload existing DB cache into queue (anti-dup safety)
// ─────────────────────────────────────────────────────────────
export const hydrateQueueFromCache = async (channelId: string) => {
  try {
    const existing = await getCachedDiscordMessages(channelId);
    if (!existing?.length) return;

    queue.set(channelId, existing);
  } catch (e) {
    console.warn("[CacheQueue] hydrate failed:", e);
  }
};
