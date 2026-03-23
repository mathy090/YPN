// src/store/authStore.ts
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

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

type AuthState = {
  user: User | null;
  initialized: boolean;
  isLoggedIn: boolean;
  hasAgreed: boolean;
  isOffline: boolean;
  hydrate: () => Promise<void>;
  login: () => void;
  agreeToTerms: () => Promise<void>;
  logout: () => Promise<void>;
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

    let online = false;
    try {
      const res = await Promise.race([
        fetch(`${API_URL}/`),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 4000),
        ),
      ]);
      online = (res as Response).ok;
    } catch {
      online = false;
    }

    if (!online) {
      const cached = await loadSession();
      set({ initialized: true, isOffline: true, isLoggedIn: !!cached });
      return;
    }

    await new Promise<void>((resolve) => {
      const unsub = subscribeToAuth(async (firebaseUser) => {
        unsub();

        if (!firebaseUser) {
          await clearSession();
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
          const token = await firebaseUser.getIdToken(true);
          const res = await fetch(`${API_URL}/api/auth/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          });

          if (res.ok) {
            await saveSession({
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              displayName: firebaseUser.displayName,
              savedAt: Date.now(),
            });
            set({
              user: firebaseUser,
              initialized: true,
              isLoggedIn: true,
              isOffline: false,
            });
          } else {
            await fbLogout();
            await clearSession();
            set({
              user: null,
              initialized: true,
              isLoggedIn: false,
              isOffline: false,
            });
          }
        } catch {
          const cached = await loadSession();
          set({
            user: firebaseUser,
            initialized: true,
            isLoggedIn: !!cached,
            isOffline: true,
          });
        }

        resolve();
      });
    });
  },

  login: () => {
    const user = auth.currentUser;
    if (user) {
      saveSession({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        savedAt: Date.now(),
      });
    }
    set({ isLoggedIn: true, user: auth.currentUser });
  },

  agreeToTerms: async () => {
    await saveAgreed();
    set({ hasAgreed: true });
  },

  logout: async () => {
    await fbLogout();
    await clearSession();
    set({ user: null, isLoggedIn: false, isOffline: false });
  },
}));
