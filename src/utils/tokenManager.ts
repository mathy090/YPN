// src/utils/tokenManager.ts
import * as SecureStore from "expo-secure-store";

const KEYS = {
  FIREBASE_ID_TOKEN: "ypn_firebase_id_token",
  BACKEND_JWT: "ypn_backend_jwt",
  TOKEN_EXPIRY: "ypn_backend_jwt_expiry", // Unix timestamp in ms
};

const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Save BOTH tokens (Overwrites existing values automatically)
export const saveTokens = async (
  firebaseToken: string,
  backendJwt: string,
  expiryMs: number,
) => {
  try {
    // SecureStore.setItemAsync overwrites if the key already exists
    await SecureStore.setItemAsync(KEYS.FIREBASE_ID_TOKEN, firebaseToken);
    await SecureStore.setItemAsync(KEYS.BACKEND_JWT, backendJwt);
    await SecureStore.setItemAsync(KEYS.TOKEN_EXPIRY, expiryMs.toString());
  } catch (e) {
    console.error("Error saving tokens:", e);
  }
};

// Get valid backend JWT (auto-refreshes if expiring soon)
export const getValidBackendToken = async (): Promise<string> => {
  const backendJwt = await SecureStore.getItemAsync(KEYS.BACKEND_JWT);
  const expiryStr = await SecureStore.getItemAsync(KEYS.TOKEN_EXPIRY);
  const expiry = expiryStr ? parseInt(expiryStr) : 0;
  const now = Date.now();

  // If backend JWT is still valid (with 5-min buffer), use it
  if (backendJwt && expiry > now + 5 * 60 * 1000) {
    return backendJwt;
  }

  // Otherwise, refresh using Firebase ID Token
  const firebaseToken = await SecureStore.getItemAsync(KEYS.FIREBASE_ID_TOKEN);
  if (!firebaseToken) {
    throw new Error("NO_FIREBASE_TOKEN");
  }

  if (!API_URL) throw new Error("API_URL_NOT_SET");

  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firebase_id_token: firebaseToken }),
    });

    if (!res.ok) {
      // If refresh fails, clear everything to force re-login
      await clearAllTokens();
      throw new Error("REFRESH_FAILED");
    }

    const { backend_jwt, expires_in } = await res.json();

    // Calculate new expiry
    const newExpiry = Date.now() + expires_in * 1000;

    // 🔥 Overwrite old tokens with new ones
    await saveTokens(firebaseToken, backend_jwt, newExpiry);

    return backend_jwt;
  } catch (err) {
    // If network error or server error, clear tokens to be safe
    await clearAllTokens();
    throw new Error("REFRESH_FAILED");
  }
};

// Auth headers for API calls (auto-refreshes if needed)
export const authHeaders = async (): Promise<{ Authorization: string }> => {
  const token = await getValidBackendToken();
  return { Authorization: `Bearer ${token}` };
};

// Clear ALL tokens on logout or error
export const clearAllTokens = async () => {
  try {
    await SecureStore.deleteItemAsync(KEYS.FIREBASE_ID_TOKEN);
    await SecureStore.deleteItemAsync(KEYS.BACKEND_JWT);
    await SecureStore.deleteItemAsync(KEYS.TOKEN_EXPIRY);
  } catch (e) {
    console.error("Error clearing tokens:", e);
  }
};

// Legacy support (optional)
export const getToken = async () => SecureStore.getItemAsync(KEYS.BACKEND_JWT);
export const saveToken = async (token: string) => {
  await SecureStore.setItemAsync(KEYS.BACKEND_JWT, token);
};
