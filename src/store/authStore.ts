// src/store/authStore.ts
//
// AUTH DECISION TREE (runs on every cold start via hydrate()):
//
//  OFFLINE + no cached session  → welcome
//  OFFLINE + cached session     → restore last screen (isLoggedIn=true, isOffline=true)
//  ONLINE  + no Firebase user   → welcome
//  ONLINE  + Firebase valid + backend ok   → discord
//  ONLINE  + Firebase valid + backend DOWN + cached session → restore (isOffline=true)
//  ONLINE  + Firebase valid + backend DOWN + no cache       → welcome
//  ONLINE  + backend rejects 401/403       → hard logout → welcome
//
// LOGOUT CONTRACT:
//  - Firebase signOut
//  - AsyncStorage.clear()     (sessions, agreed, TeamYPN, Discord cache)
//  - SecureStore key delete   (token + identity keys)
//  - expo-sqlite dbWipe()     (video manifest, news cache, kv store)
//  - Store reset with initialized:false, hasAgreed:false
//  - Caller (settings) navigates to /welcome

import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";
import { User } from "firebase/auth";
import { create } from "zustand";
import { auth, logout as fbLogout, subscribeToAuth } from "../firebase/auth";
import { dbWipe } from "../utils/db";
import {
  clearSession,
  loadAgreed,
  loadSession,
  saveAgreed,
  saveSession,
} from "../utils/session";
import {
  clearToken,
  saveToken,
  verifyWithBackend,
} from "../utils/tokenManager";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

// Every SecureStore key the app ever writes
const SECURE_KEYS = [
  "YPN_FIREBASE_TOKEN",
  "ypn_identity_private_jwk",
  "ypn_identity_public_spki",
];

// ── Connectivity check ────────────────────────────────────────────────────────
async function checkConnectivity(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    if (!state.isConnected || !state.isInternetReachable) return false;
    const res = await Promise.race<Response | never>([
      fetch(`${API_URL}/`, { method: "HEAD" }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), 4000),
      ),
    ]);
    return (res as Response).ok;
  } catch {
    return false;
  }
}

// ── Full wipe — called on logout ──────────────────────────────────────────────
// Wipes every storage layer so a killed + reopened app sees no session.
async function nukeEverything(): Promise<void> {
  // 1. AsyncStorage — sessions, agreed flag, all message/channel caches
  try {
    await AsyncStorage.clear();
  } catch (e) {
    console.warn("[authStore] AsyncStorage.clear() failed:", e);
  }

  // 2. SecureStore — token + crypto identity keys
  for (const key of SECURE_KEYS) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // key may not exist — safe to ignore
    }
  }

  // 3. expo-sqlite (ypn.db) — video manifest, news cache, kv store
  try {
    await dbWipe();
  } catch (e) {
    console.warn("[authStore] dbWipe() failed:", e);
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────
type AuthState = {
  user: User | null;
  initialized: boolean; // true once hydrate() has finished
  isLoggedIn: boolean;
  hasAgreed: boolean;
  isOffline: boolean;
  hydrate: () => Promise<void>;
  login: () => Promise<void>;
  agreeToTerms: () => Promise<void>;
  logout: () => Promise<void>;
  revalidateOnReconnect: () => Promise<void>;
};

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  initialized: false,
  isLoggedIn: false,
  hasAgreed: false,
  isOffline: false,

  // ── hydrate ──────────────────────────────────────────────────────────────
  // Called once on cold start by app/index.tsx.
  // Sets initialized:true when done — index blocks routing until then.
  hydrate: async () => {
    const agreed = await loadAgreed();
    set({ hasAgreed: agreed });

    const online = await checkConnectivity();

    // ── OFFLINE ──────────────────────────────────────────────────────────
    if (!online) {
      const cached = await loadSession();
      set({
        user: null,
        initialized: true,
        isLoggedIn: !!cached, // false → welcome, true → restore
        isOffline: true,
      });
      return;
    }

    // ── ONLINE ───────────────────────────────────────────────────────────
    await new Promise<void>((resolve) => {
      const unsub = subscribeToAuth(async (firebaseUser) => {
        unsub();

        // No Firebase session
        if (!firebaseUser) {
          await clearSession();
          await clearToken();
          set({
            user: null,
            initialized: true,
            isLoggedIn: false,
            isOffline: false,
          });
          resolve();
          return;
        }

        // Firebase session exists — verify with backend
        try {
          const idToken = await firebaseUser.getIdToken(true);
          await saveToken(idToken);
          const { uid, email } = await verifyWithBackend(idToken);
          await saveSession({
            uid,
            email,
            displayName: firebaseUser.displayName,
            savedAt: Date.now(),
          });
          set({
            user: firebaseUser,
            initialized: true,
            isLoggedIn: true,
            isOffline: false,
          });
        } catch (err: any) {
          const isAuthError =
            err?.status === 401 ||
            err?.status === 403 ||
            err?.code === "TOKEN_EXPIRED" ||
            err?.code === "INVALID_TOKEN" ||
            err?.code === "EMAIL_NOT_VERIFIED";

          if (isAuthError) {
            // Backend explicitly rejected → hard logout, go welcome
            await fbLogout();
            await clearSession();
            await clearToken();
            set({
              user: null,
              initialized: true,
              isLoggedIn: false,
              isOffline: false,
            });
          } else {
            // Backend unreachable (network err / 5xx) → restore if cache exists
            const cached = await loadSession();
            set({
              user: firebaseUser,
              initialized: true,
              isLoggedIn: !!cached, // false → welcome, true → restore
              isOffline: true,
            });
          }
        }
        resolve();
      });
    });
  },

  // ── login ─────────────────────────────────────────────────────────────────
  // Called after a successful sign-in to persist the session.
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
    } catch (e) {
      console.warn("[authStore] login: failed to persist session:", e);
    }
    set({ user: firebaseUser, isLoggedIn: true, isOffline: false });
  },

  // ── agreeToTerms ──────────────────────────────────────────────────────────
  agreeToTerms: async () => {
    await saveAgreed();
    set({ hasAgreed: true });
  },

  // ── logout ────────────────────────────────────────────────────────────────
  // Wipes every storage layer. After this, a killed + reopened app will
  // find no session anywhere and land on welcome.
  logout: async () => {
    // 1. Firebase sign out (best effort)
    try {
      await fbLogout();
    } catch {
      // always continue — local cleanup is mandatory
    }

    // 2. Wipe all storage
    await nukeEverything();

    // 3. Reset store — initialized:false forces index to re-run hydrate
    //    on next mount; hasAgreed:false shows welcome+terms again
    set({
      user: null,
      isLoggedIn: false,
      isOffline: false,
      hasAgreed: false,
      initialized: false,
    });
  },

  // ── revalidateOnReconnect ─────────────────────────────────────────────────
  // Fires when network comes back after being offline.
  // Re-verifies silently — if backend rejects, logs out.
  revalidateOnReconnect: async () => {
    const { isOffline, isLoggedIn } = get();
    if (!isOffline || !isLoggedIn) return;

    const online = await checkConnectivity();
    if (!online) return;

    const firebaseUser = auth.currentUser;
    if (!firebaseUser) {
      await clearSession();
      await clearToken();
      set({ user: null, isLoggedIn: false, isOffline: false });
      return;
    }

    try {
      const idToken = await firebaseUser.getIdToken(true);
      await saveToken(idToken);
      await verifyWithBackend(idToken);
      await saveSession({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        savedAt: Date.now(),
      });
      set({ user: firebaseUser, isLoggedIn: true, isOffline: false });
    } catch (err: any) {
      const isAuthError =
        err?.status === 401 ||
        err?.status === 403 ||
        err?.code === "TOKEN_EXPIRED" ||
        err?.code === "INVALID_TOKEN" ||
        err?.code === "EMAIL_NOT_VERIFIED";

      if (isAuthError) {
        await fbLogout();
        await clearSession();
        await clearToken();
        set({ user: null, isLoggedIn: false, isOffline: false });
      } else {
        // Still unreachable — stay offline, don't kick user out
        set({ isOffline: true });
      }
    }
  },
}));
