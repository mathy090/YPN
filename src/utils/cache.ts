import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";

// ── Configuration ─────────────────────────────────────────────────────────────
const CACHE_PREFIX = "YPN_SECURE_CACHE:";
const DEVICE_ID_KEY = "YPN_DEVICE_ID";
const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ── Cache Keys ────────────────────────────────────────────────────────────────
export const CACHE_KEYS = {
  TEAM_YPN_MESSAGES: "team_ypn_messages",
  FORYOU_MANIFEST: "foryou_manifest",
  USER_PROFILE: "user_profile",
  discordChannelMessages: (channelId: string) => `discord_msgs_${channelId}`,
  discordChannels: "discord_channels",
};

// ── Types ─────────────────────────────────────────────────────────────────────
type CacheItem = {
  data: any;
  timestamp: number;
  ttl: number;
  deviceId: string;
};

export type TeamYPNMessage = {
  id: string;
  text: string;
  sender: "user" | "ai";
  timestamp: number;
  status: "sending" | "sent" | "read" | "failed";
};

export type ForYouVideo = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number | null;
  thumbnail: string | null;
  id?: string; // Optional ID for mapping
};

export type CachedMessage = {
  id: string;
  text: string;
  uid: string;
  displayName: string;
  createdAt: number;
};

export type UserProfileCache = {
  uid: string;
  email?: string;
  username?: string;
  name?: string;
  avatarUrl?: string | null;
  hasProfile?: boolean | number;
};

// ── SQLite Database ───────────────────────────────────────────────────────────
let db: SQLiteDatabase | null = null;
let deviceId: string | null = null;
let initPromise: Promise<void> | null = null;

const getDB = (): SQLiteDatabase => {
  if (!db) {
    db = openDatabaseSync("ypn_cache.db");
  }
  return db;
};

// ── Device ID ─────────────────────────────────────────────────────────────────
const generateDeviceId = async (): Promise<string> => {
  try {
    return await Crypto.randomUUID();
  } catch {
    return `fallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
};

const ensureDeviceId = async (): Promise<void> => {
  if (deviceId) return;
  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored) {
      deviceId = stored;
      return;
    }
    deviceId = await generateDeviceId();
    await AsyncStorage.setItem(DEVICE_ID_KEY, deviceId);
  } catch (e) {
    console.warn("[Cache] Device ID error:", e);
    deviceId = `fallback_${Date.now()}`;
  }
};

// ── Initialization ────────────────────────────────────────────────────────────
const initializeDB = async (): Promise<void> => {
  const database = getDB();
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS cache_items (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      ttl INTEGER NOT NULL,
      device_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_device_id ON cache_items(device_id);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON cache_items(timestamp);
  `);
};

export const initializeSecureCache = async (): Promise<void> => {
  if (initPromise) {
    await initPromise;
    return;
  }
  initPromise = (async () => {
    try {
      await ensureDeviceId();
      await initializeDB();
    } catch (e) {
      console.warn("[Cache] Init error:", e);
    }
  })();
  await initPromise;
};

const ensureInitialized = async (): Promise<void> => {
  await initializeSecureCache();
};

// ── Key Helper ────────────────────────────────────────────────────────────────
const makeKey = (key: string): string => `${CACHE_PREFIX}${key}`;

// ── Core Cache Operations ─────────────────────────────────────────────────────

export const setSecureCache = async (
  key: string,
  data: any,
  ttl: number = DEFAULT_TTL,
): Promise<void> => {
  try {
    await ensureInitialized();
    if (!deviceId) return;
    const fullKey = makeKey(key);
    const item: CacheItem = { data, timestamp: Date.now(), ttl, deviceId };
    const value = JSON.stringify(item);
    const database = getDB();
    await database.runAsync(
      "INSERT OR REPLACE INTO cache_items (key, value, timestamp, ttl, device_id) VALUES (?, ?, ?, ?, ?)",
      [fullKey, value, item.timestamp, item.ttl, item.deviceId],
    );
  } catch (e) {
    console.warn(`[Cache] setSecureCache error for ${key}:`, e);
  }
};

export const getSecureCache = async (key: string): Promise<any | null> => {
  try {
    await ensureInitialized();
    if (!deviceId) return null;
    const fullKey = makeKey(key);
    const database = getDB();
    const result = await database.getFirstAsync<{ value: string }>(
      "SELECT value FROM cache_items WHERE key = ? AND device_id = ?",
      [fullKey, deviceId],
    );
    if (!result?.value) return null;
    const item = JSON.parse(result.value) as CacheItem;

    // Check TTL
    if (item.ttl > 0 && Date.now() - item.timestamp > item.ttl) {
      await database.runAsync("DELETE FROM cache_items WHERE key = ?", [
        fullKey,
      ]);
      return null;
    }
    return item.data;
  } catch (e) {
    console.warn(`[Cache] getSecureCache error for ${key}:`, e);
    return null;
  }
};

export const removeSecureCache = async (key: string): Promise<void> => {
  try {
    await ensureInitialized();
    const fullKey = makeKey(key);
    const database = getDB();
    await database.runAsync("DELETE FROM cache_items WHERE key = ?", [fullKey]);
  } catch (e) {
    console.warn(`[Cache] removeSecureCache error for ${key}:`, e);
  }
};

export const clearSecureCache = async (): Promise<void> => {
  try {
    await ensureInitialized();
    if (!deviceId) return;
    const database = getDB();
    await database.runAsync("DELETE FROM cache_items WHERE device_id = ?", [
      deviceId,
    ]);
    await AsyncStorage.removeItem(DEVICE_ID_KEY);
    deviceId = null;
  } catch (e) {
    console.warn("[Cache] clearSecureCache error:", e);
  }
};

// ── MESSAGE WRITE BUFFER (FIX RACE CONDITIONS) ───────────────────────────────
let messageBuffer: Record<string, CachedMessage[]> = {};
let flushTimer: any = null;

const flushMessageBuffer = async () => {
  const entries = Object.entries(messageBuffer);
  messageBuffer = {};

  if (entries.length === 0) return;

  for (const [channelId, messages] of entries) {
    try {
      await setSecureCache(
        CACHE_KEYS.discordChannelMessages(channelId),
        messages,
        DEFAULT_TTL,
      );
    } catch (e) {
      console.warn("[Cache] batch flush failed:", e);
    }
  }
};

export const queueCacheDiscordMessages = async (
  channelId: string,
  messages: CachedMessage[],
): Promise<void> => {
  if (!messageBuffer[channelId]) {
    messageBuffer[channelId] = [];
  }

  // merge + deduplicate
  const existing = messageBuffer[channelId];

  const map = new Map(existing.map((m) => [m.id, m]));
  for (const m of messages) {
    map.set(m.id, m);
  }

  messageBuffer[channelId] = Array.from(map.values());

  // debounce flush
  if (flushTimer) clearTimeout(flushTimer);

  flushTimer = setTimeout(() => {
    flushMessageBuffer();
  }, 800); // 0.8s batch window
};

// Alias old function name to new buffered one for compatibility
export const cacheDiscordMessages = queueCacheDiscordMessages;

// ── Specialized Helpers ───────────────────────────────────────────────────────

/** Save User Profile (30 Days TTL) */
export const saveProfileToCache = async (
  profile: UserProfileCache,
): Promise<void> => {
  await setSecureCache(
    CACHE_KEYS.USER_PROFILE,
    profile,
    30 * 24 * 60 * 60 * 1000,
  );
};

export const getCachedProfile = async (): Promise<UserProfileCache | null> => {
  return await getSecureCache(CACHE_KEYS.USER_PROFILE);
};

export const updateAvatarInCache = async (
  avatarUrl: string | null,
): Promise<void> => {
  const current = await getCachedProfile();
  if (current) {
    await saveProfileToCache({ ...current, avatarUrl });
  }
};

/** Save Video Manifest (2 Hours TTL - Optimized for Pre-loading) */
export const cacheForYouManifest = async (
  videos: ForYouVideo[],
): Promise<void> => {
  // 2 Hours TTL
  await setSecureCache(CACHE_KEYS.FORYOU_MANIFEST, videos, 2 * 60 * 60 * 1000);
};

export const getCachedForYouManifest = async (): Promise<
  ForYouVideo[] | null
> => {
  const data = await getSecureCache(CACHE_KEYS.FORYOU_MANIFEST);
  return Array.isArray(data) ? data : null;
};

/** Save TeamYPN Messages (30 Days) */
export const cacheTeamYPNMessages = async (
  messages: TeamYPNMessage[],
): Promise<void> => {
  await setSecureCache(
    CACHE_KEYS.TEAM_YPN_MESSAGES,
    messages,
    30 * 24 * 60 * 60 * 1000,
  );
};

export const getCachedTeamYPNMessages = async (): Promise<
  TeamYPNMessage[] | null
> => {
  const data = await getSecureCache(CACHE_KEYS.TEAM_YPN_MESSAGES);
  return Array.isArray(data) ? data : null;
};

/** Save Discord Channels (7 Days) */
export const cacheDiscordChannels = async (channels: any[]): Promise<void> => {
  await setSecureCache(
    CACHE_KEYS.discordChannels,
    channels,
    7 * 24 * 60 * 60 * 1000,
  );
};

export const getCachedDiscordChannels = async (): Promise<any[] | null> => {
  return await getSecureCache(CACHE_KEYS.discordChannels);
};
