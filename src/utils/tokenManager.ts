// src/utils/tokenManager.ts
import * as SecureStore from "expo-secure-store";
import { auth } from "../firebase/auth";

const TOKEN_KEY = "YPN_FIREBASE_TOKEN";
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "https://ypn.onrender.com";

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function refreshToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("No authenticated user");
  const fresh = await user.getIdToken(true);
  await saveToken(fresh);
  return fresh;
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function authHeaders(): Promise<{ Authorization: string }> {
  try {
    const token = await refreshToken();
    return { Authorization: `Bearer ${token}` };
  } catch {
    const cached = await getToken();
    if (!cached) throw new Error("Not authenticated");
    return { Authorization: `Bearer ${cached}` };
  }
}

/**
 * POST /api/auth/verify
 * Sends the Firebase ID token to backend for Admin SDK verification.
 * Returns { uid, email, hasProfile }
 */
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
