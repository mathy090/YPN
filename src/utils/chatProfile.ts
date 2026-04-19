// src/utils/chatProfile.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

const API_URL = process.env.EXPO_PUBLIC_API_URL || "";
const PROFILE_CACHE_PREFIX = "chat_profile_";
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// 🔑 SECURESTORE KEYS - MATCHES YOUR tokenManager.ts EXACTLY
const SECURESTORE_KEYS = {
  UID: "app.uid", // Stores just the UID string
  USER_DATA: "app.user_data", // Stores full user object: { uid, email, username, avatarUrl, hasProfile }
} as const;

export type ChatProfile = {
  uid: string;
  username: string;
  avatarUrl: string | null;
};

/**
 * Retrieves the current user's UID from SecureStore
 * Uses the 'app.uid' key that tokenManager.ts saves
 */
export const getStoredUid = async (): Promise<string | null> => {
  try {
    const uid = await SecureStore.getItemAsync(SECURESTORE_KEYS.UID);
    if (!uid || uid.trim() === "") return null;
    return uid.trim();
  } catch (error) {
    console.warn("[chatProfile] Failed to read UID from SecureStore:", error);
    return null;
  }
};

/**
 * Gets full user data from SecureStore (optional helper)
 * Returns { uid, email, username, avatarUrl, hasProfile } if available
 */
export const getStoredUserData =
  async (): Promise<Partial<ChatProfile> | null> => {
    try {
      const raw = await SecureStore.getItemAsync(SECURESTORE_KEYS.USER_DATA);
      if (!raw) return null;

      const userData = JSON.parse(raw);
      if (!userData || typeof userData !== "object") return null;

      return {
        uid: userData.uid || null,
        username: userData.username || null,
        avatarUrl: userData.avatarUrl || null,
      };
    } catch {
      return null;
    }
  };

/**
 * Fetches user profile from MongoDB via public backend endpoint
 * GET /api/discord/profile/:uid → { uid, username, avatarUrl }
 */
export const fetchProfileByUid = async (
  uid: string,
): Promise<ChatProfile | null> => {
  if (!uid || !API_URL) return null;

  try {
    const res = await fetch(
      `${API_URL}/api/discord/profile/${encodeURIComponent(uid)}`,
    );

    if (!res.ok) {
      console.warn(
        `[chatProfile] Backend fetch failed for ${uid}: HTTP ${res.status}`,
      );
      return null;
    }

    const data = await res.json();

    // Normalize response to match ChatProfile type
    return {
      uid: data.uid || uid,
      username: data.username || "Guest",
      avatarUrl: data.avatarUrl || null,
    };
  } catch (error) {
    console.warn("[chatProfile] Network error fetching profile:", error);
    return null;
  }
};

/**
 * Gets chat profile with smart cache strategy:
 * 1. Try SecureStore cache first (instant, no network)
 * 2. If stale or missing, fetch fresh from backend
 * 3. Fallback to SecureStore if network fails (offline mode)
 */
export const getChatProfile = async (
  uid: string,
  forceRefresh = false,
): Promise<ChatProfile | null> => {
  if (!uid) return null;

  const cacheKey = `${PROFILE_CACHE_PREFIX}${uid}`;

  // 1️⃣ Try AsyncStorage cache first (fast path)
  if (!forceRefresh) {
    try {
      const cached = await AsyncStorage.getItem(cacheKey);
      if (cached) {
        const { profile, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL) {
          return profile as ChatProfile;
        }
      }
    } catch (error) {
      console.warn("[chatProfile] AsyncStorage read error:", error);
    }
  }

  // 2️⃣ Fetch fresh from backend (ensures latest avatar/username)
  const fresh = await fetchProfileByUid(uid);
  if (fresh) {
    try {
      // Cache the fresh result
      await AsyncStorage.setItem(
        cacheKey,
        JSON.stringify({
          profile: fresh,
          timestamp: Date.now(),
        }),
      );
    } catch (error) {
      console.warn("[chatProfile] AsyncStorage write error:", error);
    }
    return fresh;
  }

  // 3️⃣ Fallback: Try SecureStore user_data if backend failed
  try {
    const stored = await getStoredUserData();
    if (stored?.username) {
      return {
        uid: stored.uid || uid,
        username: stored.username,
        avatarUrl: stored.avatarUrl || null,
      };
    }
  } catch (error) {
    console.warn("[chatProfile] SecureStore fallback error:", error);
  }

  // 4️⃣ Last resort: Expired AsyncStorage cache
  try {
    const cached = await AsyncStorage.getItem(cacheKey);
    if (cached) {
      const { profile } = JSON.parse(cached);
      return profile as ChatProfile;
    }
  } catch {
    // Ignore expired cache errors
  }

  return null;
};

/**
 * Clears cached profile for a specific user
 */
export const clearChatProfileCache = async (uid: string): Promise<void> => {
  try {
    await AsyncStorage.removeItem(`${PROFILE_CACHE_PREFIX}${uid}`);
  } catch (error) {
    console.warn("[chatProfile] Failed to clear cache for UID:", uid, error);
  }
};

/**
 * Clears all cached chat profiles (useful during sign out)
 */
export const clearAllProfileCaches = async (): Promise<void> => {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const profileKeys = keys.filter((key) =>
      key.startsWith(PROFILE_CACHE_PREFIX),
    );
    if (profileKeys.length > 0) {
      await AsyncStorage.multiRemove(profileKeys);
      console.log("[chatProfile] Cleared all profile caches");
    }
  } catch (error) {
    console.warn("[chatProfile] Failed to clear all profile caches:", error);
  }
};

/**
 * Helper: Check if we have a valid stored UID (for conditional rendering)
 */
export const hasStoredUid = async (): Promise<boolean> => {
  const uid = await getStoredUid();
  return !!uid;
};
