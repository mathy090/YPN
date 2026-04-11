// src/utils/cache.ts
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
  USER_PROFILE: "user_profile", // NEW: Key for settings page
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
};

export type CachedMessage = {
  id: string;
  text: string;
  uid: string;
  displayName: string;
  createdAt: number;
};

// NEW: Type for User Profile
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
    // Uses synchronous-style API available in newer expo-sqlite
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

    // Check TTL (unless TTL is extremely large, effectively permanent)
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
    // Also clear device ID to force regeneration on next login
    await AsyncStorage.removeItem(DEVICE_ID_KEY);
    deviceId = null;
  } catch (e) {
    console.warn("[Cache] clearSecureCache error:", e);
  }
};

// ── NEW: User Profile Helpers (Settings Page) ────────────────────────────────

/** Save user profile to cache (TTL set to 30 days, effectively persistent until logout) */
export const saveProfileToCache = async (
  profile: UserProfileCache,
): Promise<void> => {
  // 30 Days TTL
  await setSecureCache(
    CACHE_KEYS.USER_PROFILE,
    profile,
    30 * 24 * 60 * 60 * 1000,
  );
};

/** Get cached user profile */
export const getCachedProfile = async (): Promise<UserProfileCache | null> => {
  return await getSecureCache(CACHE_KEYS.USER_PROFILE);
};

/** Optimistically update just the avatar in cache */
export const updateAvatarInCache = async (
  avatarUrl: string | null,
): Promise<void> => {
  const current = await getCachedProfile();
  if (current) {
    await saveProfileToCache({ ...current, avatarUrl });
  }
};

// ── Existing Helpers (TeamYPN, ForYou, Discord) ──────────────────────────────

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

export const cacheForYouManifest = async (
  videos: ForYouVideo[],
): Promise<void> => {
  await setSecureCache(
    CACHE_KEYS.FORYOU_MANIFEST,
    videos,
    7 * 24 * 60 * 60 * 1000,
  );
};

export const getCachedForYouManifest = async (): Promise<
  ForYouVideo[] | null
> => {
  const data = await getSecureCache(CACHE_KEYS.FORYOU_MANIFEST);
  return Array.isArray(data) ? data : null;
};

export const cacheDiscordMessages = async (
  channelId: string,
  messages: CachedMessage[],
): Promise<void> => {
  await setSecureCache(
    CACHE_KEYS.discordChannelMessages(channelId),
    messages,
    DEFAULT_TTL,
  );
};

export const getCachedDiscordMessages = async (
  channelId: string,
): Promise<CachedMessage[] | null> => {
  return await getSecureCache(CACHE_KEYS.discordChannelMessages(channelId));
};

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
