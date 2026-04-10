// src/store/authStore.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";
import { User } from "firebase/auth";
import { create } from "zustand";
import { auth, logout as fbLogout } from "../firebase/auth";
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

const SECURE_KEYS = [
  "YPN_FIREBASE_TOKEN",
  "ypn_identity_private_jwk",
  "ypn_identity_public_spki",
];

async function nukeEverything(): Promise<void> {
  try {
    await AsyncStorage.clear();
  } catch {}
  for (const key of SECURE_KEYS) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {}
  }
  try {
    await dbWipe();
  } catch {}
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
    try {
      const agreed = await loadAgreed();
      const cachedSession = await loadSession();

      set({
        hasAgreed: !!agreed,
        isLoggedIn: !!cachedSession,
        initialized: true, // UNLOCK UI
        isOffline: true,
        user: null,
      });

      backgroundVerify(cachedSession);
    } catch (e) {
      console.error("[Auth] Hydration critical error:", e);
      // Even on error, unlock UI so user isn't stuck on spinner
      set({ initialized: true, isLoggedIn: false, hasAgreed: false });
    }
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
      set({ user: firebaseUser, isLoggedIn: true, isOffline: false });
    } catch (e) {
      console.warn("[authStore] login error:", e);
    }
  },

  agreeToTerms: async () => {
    await saveAgreed();
    set({ hasAgreed: true });
  },

  logout: async () => {
    try {
      await fbLogout();
    } catch {}
    await nukeEverything();
    set({
      user: null,
      isLoggedIn: false,
      isOffline: false,
      hasAgreed: false,
      initialized: true,
    });
  },

  revalidateOnReconnect: async () => {
    const { isLoggedIn } = get();
    if (!isLoggedIn) return;
    const cachedSession = await loadSession();
    backgroundVerify(cachedSession);
  },
}));

async function backgroundVerify(cachedSession: any) {
  const state = await NetInfo.fetch();
  const isConnected =
    (state.isConnected ?? false) && (state.isInternetReachable ?? true);

  if (!isConnected) return;

  let firebaseUser: User | null = auth.currentUser;

  if (!firebaseUser) {
    firebaseUser = await new Promise((resolve) => {
      const unsub = auth.onAuthStateChanged((user) => {
        unsub();
        resolve(user);
      });
      setTimeout(() => resolve(null), 2000);
    });
  }

  if (!firebaseUser) {
    await clearSession();
    await clearToken();
    useAuth.setState({ user: null, isLoggedIn: false, isOffline: false });
    return;
  }

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

    useAuth.setState({
      user: firebaseUser,
      isLoggedIn: true,
      isOffline: false,
    });
  } catch (err: any) {
    const isAuthError = err?.status === 401 || err?.status === 403;

    if (isAuthError) {
      await fbLogout();
      await clearSession();
      await clearToken();
      useAuth.setState({ user: null, isLoggedIn: false, isOffline: false });
    } else {
      useAuth.setState({
        user: firebaseUser,
        isLoggedIn: !!cachedSession,
        isOffline: true,
      });
    }
  }
}
