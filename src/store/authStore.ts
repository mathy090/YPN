// src/store/authStore.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { User } from "firebase/auth";
import { create } from "zustand";
import { auth, logout as fbLogout, subscribeToAuth } from "../firebase/auth";
import { dbWipe } from "../utils/db";
import { clearSession, loadSession, saveSession } from "../utils/session";
import {
  clearToken,
  getToken,
  saveToken,
  verifyWithBackend,
} from "../utils/tokenManager";

const AGREED_KEY = "YPN_HAS_AGREED"; // never wiped on logout

type AuthState = {
  user: User | null;
  isLoggedIn: boolean;
  hasAgreed: boolean;
  boot: () => Promise<"cached" | "no-cache">;
  silentVerify: (onKick: () => void) => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  agreeToTerms: () => Promise<void>;
};

async function isOnline(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    return (state.isConnected ?? false) && (state.isInternetReachable ?? true);
  } catch {
    return false;
  }
}

async function getHasAgreed(): Promise<boolean> {
  const v = await AsyncStorage.getItem(AGREED_KEY).catch(() => null);
  return v === "1";
}

async function setHasAgreed(): Promise<void> {
  await AsyncStorage.setItem(AGREED_KEY, "1").catch(() => {});
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  isLoggedIn: false,
  hasAgreed: false,

  // Reads cache only — no network. Returns in ~50-100ms.
  // "cached"   → render tabs immediately, then silentVerify in background
  // "no-cache" → go to welcome
  boot: async () => {
    const [agreed, token, session] = await Promise.all([
      getHasAgreed(),
      getToken(),
      loadSession(),
    ]);

    set({ hasAgreed: agreed });

    if (token && session) {
      set({ isLoggedIn: true, user: auth.currentUser });
      return "cached";
    }

    return "no-cache";
  },

  // Runs in background after a cached boot.
  // Kicks user immediately if Firebase or backend rejects them.
  silentVerify: async (onKick) => {
    const online = await isOnline();
    if (!online) return; // offline — trust the cache

    try {
      // Wait for Firebase to hydrate (max 5s)
      const firebaseUser = await new Promise<User | null>((resolve) => {
        let done = false;
        const unsub = subscribeToAuth((u) => {
          if (done) return;
          done = true;
          unsub();
          resolve(u);
        });
        setTimeout(() => {
          if (done) return;
          done = true;
          unsub();
          resolve(auth.currentUser);
        }, 5000);
      });

      if (!firebaseUser) {
        await get().logout();
        onKick();
        return;
      }

      const idToken = await firebaseUser.getIdToken(true);
      await saveToken(idToken);
      await verifyWithBackend(idToken);

      await saveSession({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        savedAt: Date.now(),
      });

      set({ user: firebaseUser, isLoggedIn: true });
    } catch (err: any) {
      const isAuthError =
        err?.status === 401 ||
        err?.status === 403 ||
        err?.code === "TOKEN_EXPIRED" ||
        err?.code === "INVALID_TOKEN" ||
        err?.code === "EMAIL_NOT_VERIFIED";

      if (isAuthError) {
        await get().logout();
        onKick();
      }
      // Network/server errors → stay logged in, try again next open
    }
  },

  // Called after login screens complete
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
    } catch {}
    set({ user: firebaseUser, isLoggedIn: true });
  },

  // Full wipe. hasAgreed intentionally NOT cleared (WhatsApp style).
  logout: async () => {
    try {
      await fbLogout();
    } catch {}
    await Promise.all([clearToken(), clearSession(), dbWipe()]);
    set({ user: null, isLoggedIn: false });
  },

  agreeToTerms: async () => {
    await setHasAgreed();
    set({ hasAgreed: true });
  },
}));
