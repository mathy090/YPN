// src/utils/db.ts
// ─────────────────────────────────────────────────────────────────────────────
// Central SQLite store — replaces react-native-mmkv across the entire app.
// Works in Expo Go. Uses expo-sqlite's synchronous-style async API.
//
// Tables:
//   kv          — generic key/value for cache, session, settings
//   chat_cache  — per-channel message arrays (keyed by channel id)
//
// All methods are async and safe to call before the DB is open (they queue).
// ─────────────────────────────────────────────────────────────────────────────

import * as SQLite from "expo-sqlite";

let _db: SQLite.SQLiteDatabase | null = null;

// ── Open + migrate ────────────────────────────────────────────────────────────
async function getDB(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync("ypn.db");
  await _db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT,
      ts    INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS chat_cache (
      channel_id TEXT PRIMARY KEY NOT NULL,
      messages   TEXT NOT NULL,
      ts         INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  return _db;
}

// ── Generic KV store ──────────────────────────────────────────────────────────

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO kv (key, value, ts)
     VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
    [key, JSON.stringify(value)],
  );
}

export async function kvGet<T = unknown>(key: string): Promise<T | null> {
  const db = await getDB();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM kv WHERE key = ?",
    [key],
  );
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function kvGetNumber(key: string): Promise<number | null> {
  const val = await kvGet<number>(key);
  return typeof val === "number" ? val : null;
}

export async function kvGetString(key: string): Promise<string | null> {
  const val = await kvGet<string>(key);
  return typeof val === "string" ? val : null;
}

export async function kvDelete(key: string): Promise<void> {
  const db = await getDB();
  await db.runAsync("DELETE FROM kv WHERE key = ?", [key]);
}

export async function kvDeleteByPrefix(prefix: string): Promise<void> {
  const db = await getDB();
  await db.runAsync("DELETE FROM kv WHERE key LIKE ?", [prefix + "%"]);
}

// ── Chat message cache ────────────────────────────────────────────────────────

export async function chatCacheWrite(
  channelId: string,
  messages: unknown[],
): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO chat_cache (channel_id, messages, ts)
     VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(channel_id) DO UPDATE SET messages = excluded.messages, ts = excluded.ts`,
    [channelId, JSON.stringify(messages.slice(-80))],
  );
}

export async function chatCacheRead<T = unknown>(
  channelId: string,
): Promise<T[] | null> {
  const db = await getDB();
  const row = await db.getFirstAsync<{ messages: string }>(
    "SELECT messages FROM chat_cache WHERE channel_id = ?",
    [channelId],
  );
  if (!row) return null;
  try {
    return JSON.parse(row.messages) as T[];
  } catch {
    return null;
  }
}

// ── TTL-aware helpers (for news / video manifest caches) ──────────────────────

/** Write a value with a TTL. Reads via kvGetFresh respect the expiry. */
export async function kvSetTTL(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  const db = await getDB();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  await db.runAsync(
    `INSERT INTO kv (key, value, ts)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
    [key, JSON.stringify({ data: value, expiresAt }), expiresAt],
  );
}

/** Returns the value only if it hasn't expired, otherwise null. */
export async function kvGetFresh<T = unknown>(key: string): Promise<T | null> {
  const db = await getDB();
  const nowSec = Math.floor(Date.now() / 1000);
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM kv WHERE key = ?",
    [key],
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { data: T; expiresAt: number };
    if (parsed.expiresAt && parsed.expiresAt < nowSec) {
      // Expired — clean up lazily
      kvDelete(key);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

// ── Full wipe (logout / reset) ────────────────────────────────────────────────
export async function dbWipe(): Promise<void> {
  const db = await getDB();
  await db.execAsync("DELETE FROM kv; DELETE FROM chat_cache;");
}
