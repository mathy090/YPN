// src/utils/tokenManager.ts
import * as SecureStore from "expo-secure-store";

const KEYS = {
  BACKEND_JWT: "app.backend_jwt",
  REFRESH_TOKEN: "app.refresh_token",
  USER_DATA: "app.user_data",
  EXPIRY: "app.token_expiry",
  UID: "app.uid",
} as const;

// 🔐 Explicit 7-day expiry in seconds
export const TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 604800

export class OfflineError extends Error {
  constructor() {
    super("OFFLINE");
    this.name = "OfflineError";
  }
}

export class UIDMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`UID mismatch: expected ${expected}, got ${actual}`);
    this.name = "UIDMismatchError";
  }
}

export interface UserData {
  uid: string;
  email: string;
  hasProfile: boolean;
  [key: string]: any;
}

export interface TokenResponse {
  backend_jwt: string;
  refresh_token?: string;
  expires_in?: number;
  exp?: number;
  user: UserData;
}

// ✅ Parse expiry: prioritize explicit 'exp' claim, fallback to expires_in, then default
export const parseExpiryTimestamp = (data: TokenResponse): number => {
  if (data.exp && typeof data.exp === "number") {
    return data.exp * 1000;
  }
  if (data.expires_in && typeof data.expires_in === "number") {
    return Date.now() + data.expires_in * 1000;
  }
  return Date.now() + TOKEN_EXPIRY_SECONDS * 1000;
};

export const bindSessionToUID = async (uid: string): Promise<void> => {
  await SecureStore.setItemAsync(KEYS.UID, uid);
};

export const validateUIDBinding = async (
  currentUID: string,
): Promise<boolean> => {
  const storedUID = await SecureStore.getItemAsync(KEYS.UID);
  if (!storedUID) {
    await bindSessionToUID(currentUID);
    return true;
  }
  if (storedUID !== currentUID) {
    console.warn("[TokenMgr] UID mismatch!", { storedUID, currentUID });
    return false;
  }
  return true;
};

export const getStoredUID = async (): Promise<string | null> => {
  return await SecureStore.getItemAsync(KEYS.UID);
};

export const saveTokens = async (data: TokenResponse): Promise<void> => {
  const uid = data.user?.uid;

  if (uid) {
    const storedUID = await SecureStore.getItemAsync(KEYS.UID);
    if (storedUID && storedUID !== uid) {
      console.warn("[TokenMgr] Refusing to save tokens for mismatched UID");
      throw new UIDMismatchError(storedUID, uid);
    }
  }

  const expiryTimestamp = parseExpiryTimestamp(data);

  await Promise.all([
    SecureStore.setItemAsync(KEYS.BACKEND_JWT, String(data.backend_jwt).trim()),
    SecureStore.setItemAsync(KEYS.EXPIRY, expiryTimestamp.toString()),
    SecureStore.setItemAsync(KEYS.USER_DATA, JSON.stringify(data.user)),
    uid ? SecureStore.setItemAsync(KEYS.UID, uid) : Promise.resolve(),
    data.refresh_token
      ? SecureStore.setItemAsync(
          KEYS.REFRESH_TOKEN,
          String(data.refresh_token).trim(),
        )
      : Promise.resolve(),
  ]);
};

export const clearAllTokens = async (): Promise<void> => {
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.BACKEND_JWT),
    SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN),
    SecureStore.deleteItemAsync(KEYS.USER_DATA),
    SecureStore.deleteItemAsync(KEYS.EXPIRY),
    SecureStore.deleteItemAsync(KEYS.UID),
  ]).catch((err) => {
    console.warn("[TokenMgr] Non-fatal error during clear:", err);
  });
};

export const getBackendToken = async (): Promise<string | null> => {
  try {
    const token = await SecureStore.getItemAsync(KEYS.BACKEND_JWT);
    const expiryStr = await SecureStore.getItemAsync(KEYS.EXPIRY);

    if (!token || !expiryStr) {
      return null;
    }

    const storedExpiry = parseInt(expiryStr, 10);
    const now = Date.now();
    const buffer = 5 * 60 * 1000;

    if (storedExpiry - now > buffer) {
      return token;
    }

    return null;
  } catch (error) {
    console.error("[TokenMgr] Error reading token:", error);
    return null;
  }
};

export const getUserData = async (): Promise<UserData | null> => {
  try {
    const data = await SecureStore.getItemAsync(KEYS.USER_DATA);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

export const getTokenExpiry = async (): Promise<number> => {
  try {
    const exp = await SecureStore.getItemAsync(KEYS.EXPIRY);
    return exp ? parseInt(exp, 10) : 0;
  } catch {
    return 0;
  }
};

export const refreshTokens = async (
  firebaseIdToken?: string,
): Promise<TokenResponse> => {
  const API_URL = process.env.EXPO_PUBLIC_API_URL;
  if (!API_URL) throw new Error("API_URL_MISSING");

  let response: Response;
  try {
    const body: Record<string, string> = {};

    if (firebaseIdToken) {
      body.firebase_id_token = firebaseIdToken;
    } else {
      const refreshToken = await SecureStore.getItemAsync(KEYS.REFRESH_TOKEN);
      if (!refreshToken) {
        throw new Error("NO_REFRESH_TOKEN");
      }
      body.refresh_token = refreshToken;
    }

    response = await fetch(`${API_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    console.warn("[TokenMgr] Network error during refresh");
    throw new OfflineError();
  }

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    console.error("[TokenMgr] Refresh failed:", response.status, errData);

    if (response.status === 401 || response.status === 403) {
      throw new Error(`AUTH_FAILED_${response.status}`);
    }
    throw new Error(`SERVER_ERROR_${response.status}`);
  }

  const data = await response.json();
  return data as TokenResponse;
};

export const isNetworkError = (error: any): boolean => {
  if (error instanceof OfflineError) return true;
  if (error?.message?.includes("Network request failed")) return true;
  if (error?.message?.includes("Failed to fetch")) return true;
  if (error?.message?.includes("timeout")) return true;
  if (error?.type === "NetworkError") return true;
  return false;
};

export const isAuthError = (error: any): boolean => {
  if (error instanceof UIDMismatchError) return true;
  if (error?.message?.startsWith("AUTH_FAILED_")) return true;
  if (error?.message === "NO_REFRESH_TOKEN") return true;
  if (error?.message === "NO_VALID_TOKEN") return true;
  return false;
};

let retryInterval: NodeJS.Timeout | null = null;
export const startBackgroundRetry = (
  attemptFn: () => Promise<void>,
  onComplete: (success: boolean) => void,
) => {
  if (retryInterval) clearInterval(retryInterval);
  attemptFn()
    .then(() => onComplete(true))
    .catch(() => {
      retryInterval = setInterval(async () => {
        try {
          await attemptFn();
          if (retryInterval) clearInterval(retryInterval);
          onComplete(true);
        } catch (e) {
          /* retry silently */
        }
      }, 5000);
    });
};

export const stopBackgroundRetry = () => {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
};
