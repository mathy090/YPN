// src/store/authStore.ts
//
// SECURITY MODEL:
//   • On every cold boot, we force-refresh the Firebase ID token and POST it
//     to /api/auth/verify on the backend (Firebase Admin SDK + MongoDB).
//   • If the backend is unreachable OR returns 401/403, the user is signed out
//     immediately and redirected to /welcome. No cached session can bypass this.
//   • The app renders a blocking splash gate until verification resolves.
//   • hasAgreed (terms acceptance) is the ONLY flag that survives logout — it
//     is stored separately and never wiped (WhatsApp-style UX).

import AsyncStorage from "@react-native-async-storage/async-storage";
import { User } from "firebase/auth";
import { create } from "zustand";
import { auth, logout as fbLogout, subscribeToAuth } from "../firebase/auth";
import { dbWipe } from "../utils/db";
import { clearSession, saveSession } from "../utils/session";
import {
  clearToken,
  saveToken,
  verifyWithBackend,
} from "../utils/tokenManager";

// ── Constants ────────────────────────────────────────────────────────────────
const AGREED_KEY = "YPN_HAS_AGREED"; // never wiped on logout
const VERIFY_TIMEOUT_MS = 12_000; // 12 s before we treat backend as down

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getHasAgreed(): Promise<boolean> {
  const v = await AsyncStorage.getItem(AGREED_KEY).catch(() => null);
  return v === "1";
}

async function setHasAgreed(): Promise<void> {
  await AsyncStorage.setItem(AGREED_KEY, "1").catch(() => {});
}

/** Wait up to timeoutMs for the Firebase auth SDK to hydrate. */
function waitForFirebaseUser(timeoutMs = 6_000): Promise<User | null> {
  return new Promise((resolve) => {
    let settled = false;

    const unsub = subscribeToAuth((user) => {
      if (settled) return;
      settled = true;
      unsub();
      resolve(user);
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      resolve(auth.currentUser); // fall back to synchronous snapshot
    }, timeoutMs);
  });
}

/** Race a promise against a timeout. Rejects with "timeout" on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

// ── State shape ───────────────────────────────────────────────────────────────

export type VerifyResult =
  | { ok: true; hasProfile: boolean } // verified — proceed
  | { ok: false; reason: "no_user" } // no Firebase user — go to welcome
  | { ok: false; reason: "auth_error" } // 401 / 403 — sign out + welcome
  | { ok: false; reason: "offline" } // unreachable — sign out + welcome
  | { ok: false; reason: "timeout" }; // backend too slow — sign out + welcome

type AuthState = {
  user: User | null;
  isLoggedIn: boolean;
  hasAgreed: boolean;
  isVerifying: boolean; // true while the boot verification is in flight

  /** Called once from _layout.tsx on mount. Handles the full verification gate. */
  bootAndVerify: () => Promise<VerifyResult>;

  /** Called after successful login screens complete (otp.tsx → device.tsx). */
  login: () => Promise<void>;

  /** Full sign-out + local wipe. */
  logout: () => Promise<void>;

  /** Persist terms acceptance. */
  agreeToTerms: () => Promise<void>;
};

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  isLoggedIn: false,
  hasAgreed: false,
  isVerifying: true, // start true so the splash gate blocks immediately

  // ── bootAndVerify ─────────────────────────────────────────────────────────
  // This is the SINGLE entry point called once on app start.
  // It always hits the backend — no cached-session fast path.
  bootAndVerify: async (): Promise<VerifyResult> => {
    set({ isVerifying: true });

    const agreed = await getHasAgreed();
    set({ hasAgreed: agreed });

    // 1. Wait for Firebase SDK to resolve the persisted user.
    const firebaseUser = await waitForFirebaseUser(6_000);

    if (!firebaseUser) {
      // No local Firebase session at all → go to welcome.
      set({ isVerifying: false, isLoggedIn: false, user: null });
      return { ok: false, reason: "no_user" };
    }

    // 2. Force-refresh the ID token (bypasses any expired cached token).
    let idToken: string;
    try {
      idToken = await firebaseUser.getIdToken(/* forceRefresh */ true);
    } catch {
      // Firebase can't refresh — likely revoked or no network.
      await get().logout();
      set({ isVerifying: false });
      return { ok: false, reason: "auth_error" };
    }

    // 3. Verify with backend. We require this to succeed — no bypass.
    let verifyData: { uid: string; email: string; hasProfile: boolean };
    try {
      verifyData = await withTimeout(
        verifyWithBackend(idToken),
        VERIFY_TIMEOUT_MS,
      );
    } catch (err: any) {
      const isAuthError =
        err?.status === 401 ||
        err?.status === 403 ||
        err?.code === "TOKEN_EXPIRED" ||
        err?.code === "INVALID_TOKEN" ||
        err?.code === "EMAIL_NOT_VERIFIED";

      const isTimeout = err?.message === "timeout";

      // Always sign out — we never allow unverified sessions.
      await get().logout();
      set({ isVerifying: false });

      if (isAuthError) return { ok: false, reason: "auth_error" };
      if (isTimeout) return { ok: false, reason: "timeout" };

      // Network error / CORS / server down.
      return { ok: false, reason: "offline" };
    }

    // 4. Verification succeeded — persist minimal session data.
    await saveToken(idToken);
    await saveSession({
      uid: firebaseUser.uid,
      email: firebaseUser.email,
      displayName: firebaseUser.displayName,
      savedAt: Date.now(),
    });

    set({ user: firebaseUser, isLoggedIn: true, isVerifying: false });
    return { ok: true, hasProfile: verifyData.hasProfile };
  },

  // ── login ─────────────────────────────────────────────────────────────────
  // Called by otp.tsx after signInWithEmailAndPassword succeeds.
  // Does NOT navigate — the caller decides where to go based on hasProfile.
  login: async () => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) return;

    try {
      const idToken = await firebaseUser.getIdToken(true);
      await saveToken(idToken);
      await saveSession({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        savedAt: Date.now(),
      });
    } catch {
      // Non-fatal — token will be refreshed on next boot
    }

    set({ user: firebaseUser, isLoggedIn: true });
  },

  // ── logout ────────────────────────────────────────────────────────────────
  logout: async () => {
    try {
      await fbLogout();
    } catch {}
    await Promise.allSettled([clearToken(), clearSession(), dbWipe()]);
    set({ user: null, isLoggedIn: false });
  },

  // ── agreeToTerms ──────────────────────────────────────────────────────────
  agreeToTerms: async () => {
    await setHasAgreed();
    set({ hasAgreed: true });
  },
}));
