// src/utils/tokenManager.ts
import * as SecureStore from "expo-secure-store";

const KEYS = {
  FIREBASE_ID_TOKEN: "ypn_firebase_id_token",
  BACKEND_JWT: "ypn_backend_jwt",
  TOKEN_EXPIRY: "ypn_backend_jwt_expiry", // Unix timestamp in ms
};

// Save BOTH tokens after login/refresh
export const saveTokens = async (
  firebaseToken: string,
  backendJwt: string,
  expiryMs: number,
) => {
  await SecureStore.setItemAsync(KEYS.FIREBASE_ID_TOKEN, firebaseToken);
  await SecureStore.setItemAsync(KEYS.BACKEND_JWT, backendJwt);
  await SecureStore.setItemAsync(KEYS.TOKEN_EXPIRY, expiryMs.toString());
};

// Get valid backend JWT (auto-refresh if expiring soon)
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

  const API_URL = process.env.EXPO_PUBLIC_API_URL;
  if (!API_URL) throw new Error("API_URL_NOT_SET");

  const res = await fetch(`${API_URL}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firebase_id_token: firebaseToken }),
  });

  if (!res.ok) {
    await clearAllTokens();
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.code || "REFRESH_FAILED");
  }

  const { backend_jwt, expires_in } = await res.json();
  const newExpiry = Date.now() + expires_in * 1000;
  await saveTokens(firebaseToken, backend_jwt, newExpiry);
  return backend_jwt;
};

// Auth headers for API calls (auto-refreshes if needed)
export const authHeaders = async (): Promise<{ Authorization: string }> => {
  const token = await getValidBackendToken();
  return { Authorization: `Bearer ${token}` };
};

// Clear ALL tokens on logout
export const clearAllTokens = async () => {
  await SecureStore.deleteItemAsync(KEYS.FIREBASE_ID_TOKEN);
  await SecureStore.deleteItemAsync(KEYS.BACKEND_JWT);
  await SecureStore.deleteItemAsync(KEYS.TOKEN_EXPIRY);
};

// Legacy support (optional, for backward compatibility)
export const saveToken = async (token: string) => {
  await SecureStore.setItemAsync(KEYS.BACKEND_JWT, token);
};
export const getToken = async () => SecureStore.getItemAsync(KEYS.BACKEND_JWT);
