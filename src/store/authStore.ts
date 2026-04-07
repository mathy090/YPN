// src/store/authStore.ts
import NetInfo from "@react-native-community/netinfo";
import { User } from "firebase/auth";
import { create } from "zustand";
import { auth, logout as fbLogout, subscribeToAuth } from "../firebase/auth";
import {
  clearSession,
  loadAgreed,
  loadSession,
  saveAgreed,
  saveSession,
} from "../utils/session";
import {
  clearToken,
  getToken,
  saveToken,
  verifyWithBackend,
} from "../utils/tokenManager";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

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

type AuthState = {
  user: User | null;
  initialized: boolean;
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

  hydrate: async () => {
    const agreed = await loadAgreed();
    set({ hasAgreed: agreed });

    const online = await checkConnectivity();

    if (!online) {
      // Offline: allow access only if cached session and token exist
      const cached = await loadSession();
      const token = await getToken();
      set({
        user: null,
        initialized: true,
        isLoggedIn: !!cached && !!token,
        isOffline: true,
      });
      return;
    }

    // Online: wait for Firebase auth state
    await new Promise<void>((resolve) => {
      const unsub = subscribeToAuth(async (firebaseUser) => {
        unsub();

        if (!firebaseUser) {
          // No Firebase user — clear everything
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

        try {
          // Firebase user exists — verify with backend
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
            // Auth error — force logout
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
            // Backend unreachable — allow access if cached session exists
            const cached = await loadSession();
            set({
              user: firebaseUser,
              initialized: true,
              isLoggedIn: !!cached,
              isOffline: true,
            });
          }
        }
        resolve();
      });
    });
  },

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
      console.warn("login: failed to persist session:", e);
    }
    set({ user: firebaseUser, isLoggedIn: true, isOffline: false });
  },

  agreeToTerms: async () => {
    await saveAgreed();
    set({ hasAgreed: true });
  },

  logout: async () => {
    // ✅ Ensure Firebase sign-out succeeds
    await fbLogout();

    // Clear local data only after successful sign-out
    await clearToken();
    await clearSession();
    set({ user: null, isLoggedIn: false, isOffline: false });
  },

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
        set({ isOffline: true });
      }
    }
  },
}));
