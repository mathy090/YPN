// src/utils/tokenManager.ts
import * as SecureStore from "expo-secure-store";
import { auth } from "../firebase/auth";

const TOKEN_KEY = "YPN_FIREBASE_TOKEN";
const API_URL = process.env.EXPO_PUBLIC_API_URL;

if (__DEV__ && !API_URL) {
  console.error(
    "[tokenManager] EXPO_PUBLIC_API_URL is not set.\n" +
      "Copy .env.example → .env.local and set it.",
  );
}

// ── Helper: Check if token is near expiry (<5 mins) ────────────────────────
function isTokenExpiringSoon(token: string): boolean {
  try {
    // Firebase ID tokens are JWTs; decode payload without verification
    const payload = JSON.parse(atob(token.split(".")[1]));
    const expiry = payload.exp * 1000; // convert to ms
    const now = Date.now();
    return expiry - now < 5 * 60 * 1000; // <5 mins remaining
  } catch {
    return true; // If we can't decode, assume expiring
  }
}

// ── Save token to SecureStore ─────────────────────────────────────────────
export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

// ── Get cached token (no network) ─────────────────────────────────────────
export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

// ── Get valid token: cached if fresh, else refresh from Firebase ──────────
export async function getValidToken(): Promise<string> {
  const cached = await getToken();

  // Use cached if still valid (not expiring soon)
  if (cached && !isTokenExpiringSoon(cached)) {
    return cached;
  }

  // Otherwise, get fresh token from Firebase
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");

  // Force refresh only if truly needed
  const fresh = await user.getIdToken(!!cached); // true if we had a cached one
  await saveToken(fresh);
  return fresh;
}

// ── Auth headers for API calls ────────────────────────────────────────────
export async function authHeaders(): Promise<{ Authorization: string }> {
  const token = await getValidToken();
  return { Authorization: `Bearer ${token}` };
}

// ── Clear token on logout ─────────────────────────────────────────────────
export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

// ── Verify token with backend (for profile checks, etc.) ──────────────────
export async function verifyWithBackend(
  idToken: string,
): Promise<{ uid: string; email: string; hasProfile: boolean }> {
  const res = await fetch(`${API_URL}/api/auth/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(body.message ?? "Backend verification failed") as any;
    err.code = body.code ?? "UNKNOWN";
    err.status = res.status;
    throw err;
  }

  return body as { uid: string; email: string; hasProfile: boolean };
}
