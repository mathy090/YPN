// src/utils/chatCache.ts
import * as SQLite from "expo-sqlite";

const DB_NAME = "ypn_chat.db";
let db: SQLite.SQLiteDatabase | null = null;

export type CachedMessage = {
  id: string;
  channel_id: string;
  sender_id: string;
  content: string | null;
  media_type: "image" | "video" | "audio" | null;
  media_url: string | null;
  username: string;
  avatar_url: string | null;
  created_at: string;
  is_optimistic: number; // 1 = pending send, 0 = confirmed
  is_deleted_local: number; // 1 = hidden locally, 0 = visible
};

export async function initChatDB(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;

  db = await SQLite.openDatabaseAsync(DB_NAME);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT,
      media_type TEXT,
      media_url TEXT,
      username TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      is_optimistic INTEGER DEFAULT 0,
      is_deleted_local INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_sender ON messages(sender_id);
  `);

  return db;
}

export async function cacheMessages(
  channelId: string,
  messages: CachedMessage[],
): Promise<void> {
  if (!db) return;

  await db.runAsync("BEGIN TRANSACTION");
  try {
    const stmt = await db.prepareAsync(`
      INSERT INTO messages (
        id, channel_id, sender_id, content, media_type, media_url, 
        username, avatar_url, created_at, is_optimistic, is_deleted_local
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        media_type = excluded.media_type,
        media_url = excluded.media_url,
        username = excluded.username,
        avatar_url = excluded.avatar_url,
        is_optimistic = excluded.is_optimistic,
        is_deleted_local = excluded.is_deleted_local
    `);

    for (const msg of messages) {
      await stmt.executeAsync([
        msg.id,
        msg.channel_id,
        msg.sender_id,
        msg.content,
        msg.media_type,
        msg.media_url,
        msg.username || "",
        msg.avatar_url || null,
        msg.created_at,
        msg.is_optimistic ?? 0,
        msg.is_deleted_local ?? 0,
      ]);
    }

    await stmt.finalizeAsync();
    await db.runAsync("COMMIT");
  } catch (e) {
    await db.runAsync("ROLLBACK");
    console.warn("[ChatCache] Failed to cache messages:", e);
  }
}

export async function getCachedMessages(
  channelId: string,
): Promise<CachedMessage[]> {
  if (!db) return [];

  const result = await db.getAllAsync<CachedMessage>(
    `SELECT * FROM messages 
     WHERE channel_id = ? AND is_deleted_local = 0 
     ORDER BY created_at ASC`,
    [channelId],
  );

  return result || [];
}

export async function addOptimisticMessage(msg: CachedMessage): Promise<void> {
  if (!db) return;

  await db.runAsync(
    `
    INSERT INTO messages (
      id, channel_id, sender_id, content, media_type, media_url,
      username, avatar_url, created_at, is_optimistic, is_deleted_local
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
  `,
    [
      msg.id,
      msg.channel_id,
      msg.sender_id,
      msg.content,
      msg.media_type,
      msg.media_url,
      msg.username || "",
      msg.avatar_url || null,
      msg.created_at,
    ],
  );
}

export async function confirmMessage(
  serverId: string,
  localId: string,
): Promise<void> {
  if (!db) return;

  // Update optimistic message with confirmed server ID
  await db.runAsync(
    "UPDATE messages SET is_optimistic = 0, id = ? WHERE id = ?",
    [serverId, localId],
  );
}

export async function deleteMessageLocally(messageId: string): Promise<void> {
  if (!db) return;

  // Mark as deleted locally (soft delete)
  await db.runAsync("UPDATE messages SET is_deleted_local = 1 WHERE id = ?", [
    messageId,
  ]);
}

export async function removeFailedOptimistic(localId: string): Promise<void> {
  if (!db) return;

  // Remove optimistic message that failed to send
  await db.runAsync("DELETE FROM messages WHERE id = ? AND is_optimistic = 1", [
    localId,
  ]);
}

export async function clearChannelCache(channelId: string): Promise<void> {
  if (!db) return;
  await db.runAsync("DELETE FROM messages WHERE channel_id = ?", [channelId]);
}

export async function clearAllChatCache(): Promise<void> {
  if (!db) return;
  await db.runAsync("DELETE FROM messages");
}
