import * as SecureStore from "expo-secure-store";

const KEYS = {
  BACKEND_JWT: "app.backend_jwt",
  REFRESH_TOKEN: "app.refresh_token",
  USER_DATA: "app.user_data",
  EXPIRY: "app.token_expiry", // ✅ Store as MILLISECONDS timestamp
} as const;

export class OfflineError extends Error {
  constructor() {
    super("OFFLINE");
    this.name = "OfflineError";
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
  expires_in?: number; // Duration in SECONDS from backend
  exp?: number; // Absolute expiry timestamp (alternative)
  user: UserData;
}

// ✅ Helper: Parse expiry from backend response (handles both formats)
const parseExpiryTimestamp = (data: TokenResponse): number => {
  // If backend sends absolute timestamp 'exp' (Unix seconds)
  if (data.exp && typeof data.exp === "number") {
    console.log("[TokenMgr] Using 'exp' timestamp:", data.exp);
    return data.exp * 1000; // Convert Unix seconds → milliseconds
  }

  // If backend sends duration 'expires_in' (seconds from now)
  if (data.expires_in && typeof data.expires_in === "number") {
    const expiryMs = Date.now() + data.expires_in * 1000;
    console.log("[TokenMgr] Calculated expiry from 'expires_in':", {
      expiresIn: data.expires_in,
      calculatedExpiry: new Date(expiryMs).toISOString(),
    });
    return expiryMs;
  }

  // Fallback: 7 days if no expiry info (for debugging)
  console.warn("[TokenMgr] No expiry info, defaulting to 7 days");
  return Date.now() + 7 * 24 * 60 * 60 * 1000;
};

export const saveTokens = async (data: TokenResponse) => {
  // ✅ Parse expiry correctly (handles seconds vs milliseconds)
  const expiryTimestamp = parseExpiryTimestamp(data);

  console.log("[TokenMgr] Saving tokens with expiry:", {
    jwtLength: data.backend_jwt?.length,
    expiryTimestamp,
    expiryISO: new Date(expiryTimestamp).toISOString(),
    expiresInDays: (expiryTimestamp - Date.now()) / (1000 * 60 * 60 * 24),
  });

  await Promise.all([
    SecureStore.setItemAsync(KEYS.BACKEND_JWT, String(data.backend_jwt).trim()),
    SecureStore.setItemAsync(KEYS.EXPIRY, expiryTimestamp.toString()), // ✅ Store as MILLISECONDS string
    SecureStore.setItemAsync(KEYS.USER_DATA, JSON.stringify(data.user)),
    data.refresh_token
      ? SecureStore.setItemAsync(
          KEYS.REFRESH_TOKEN,
          String(data.refresh_token).trim(),
        )
      : Promise.resolve(),
  ]);

  console.log("[TokenMgr] ✅ Tokens saved successfully");
};

export const clearAllTokens = async () => {
  console.log("[TokenMgr] 🔐 Clearing all tokens");
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.BACKEND_JWT),
    SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN),
    SecureStore.deleteItemAsync(KEYS.USER_DATA),
    SecureStore.deleteItemAsync(KEYS.EXPIRY),
  ]).catch((err) => {
    console.warn("[TokenMgr] Non-fatal error during clear:", err);
  });
};

export const getBackendToken = async (): Promise<string | null> => {
  try {
    const token = await SecureStore.getItemAsync(KEYS.BACKEND_JWT);
    const expiryStr = await SecureStore.getItemAsync(KEYS.EXPIRY);

    if (!token || !expiryStr) {
      console.log("[TokenMgr] No token or expiry found");
      return null;
    }

    const storedExpiry = parseInt(expiryStr, 10); // ✅ Parse as milliseconds
    const now = Date.now();
    const buffer = 5 * 60 * 1000; // 5-minute buffer
    const timeLeft = storedExpiry - now;
    const daysLeft = timeLeft / (1000 * 60 * 60 * 24);

    console.log("[TokenMgr] Token check:", {
      storedExpiry: new Date(storedExpiry).toISOString(),
      now: new Date(now).toISOString(),
      timeLeftMs: timeLeft,
      daysLeft: daysLeft.toFixed(2),
      isValid: timeLeft > buffer,
    });

    // ✅ Check if token is still valid (with buffer)
    if (timeLeft > buffer) {
      console.log(
        "[TokenMgr] ✅ Token valid, ~" +
          daysLeft.toFixed(1) +
          " days remaining",
      );
      return token;
    }

    console.log("[TokenMgr] ⚠️ Token expired or expiring soon");
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
    return exp ? parseInt(exp, 10) : 0; // ✅ Return milliseconds timestamp
  } catch {
    return 0;
  }
};

export const refreshTokens = async (): Promise<TokenResponse> => {
  const refreshToken = await SecureStore.getItemAsync(KEYS.REFRESH_TOKEN);

  if (!refreshToken) {
    console.log("[TokenMgr] No refresh token found");
    throw new Error("NO_REFRESH_TOKEN");
  }

  const API_URL = process.env.EXPO_PUBLIC_API_URL;
  if (!API_URL) throw new Error("API_URL_MISSING");

  let response: Response;
  try {
    console.log(
      "[TokenMgr] Refreshing token via:",
      `${API_URL}/api/auth/refresh`,
    );

    response = await fetch(`${API_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (networkError) {
    console.warn("[TokenMgr] Network error during refresh");
    throw new OfflineError();
  }

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    console.error("[TokenMgr] Refresh failed:", response.status, errData);

    // Distinguish between auth failure vs server error
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AUTH_FAILED_${response.status}`);
    }
    throw new Error(`SERVER_ERROR_${response.status}`);
  }

  const data = await response.json();
  console.log("[TokenMgr] Refresh response received:", {
    hasBackendJwt: !!data.backend_jwt,
    expiresIn: data.expires_in,
    exp: data.exp,
  });

  return data as TokenResponse;
};

// Background retry logic (unchanged)
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
