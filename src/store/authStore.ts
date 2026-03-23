// src/store/authStore.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { User } from "firebase/auth";
import { create } from "zustand";
import { logout, subscribeToAuth } from "../firebase/auth";
import { clearToken } from "../utils/tokenManager";

const AGREED_KEY = "YPN_HAS_AGREED";

type AuthState = {
  user: User | null;
  initialized: boolean;
  isLoggedIn: boolean;
  hasAgreed: boolean;
  setUser: (user: User | null) => void;
  startListener: () => void;
  login: () => void;
  agreeToTerms: () => Promise<void>;
  logout: () => Promise<void>;
};

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  initialized: false,
  isLoggedIn: false,
  hasAgreed: false,

  setUser: (user) => set({ user }),

  startListener: () => {
    if (get().initialized) return;
    subscribeToAuth((user) => {
      set({ user, initialized: true, isLoggedIn: !!user });
    });
  },

  login: () => set({ isLoggedIn: true }),

  agreeToTerms: async () => {
    await AsyncStorage.setItem(AGREED_KEY, "1");
    set({ hasAgreed: true });
  },

  logout: async () => {
    await logout();
    await clearToken();
    set({ user: null, isLoggedIn: false });
  },
}));

/**
 * Call once at startup to read hasAgreed from AsyncStorage.
 * Keeps the value across app restarts so users don't see /welcome every time.
 */
export async function hydrateAgreed(): Promise<void> {
  const val = await AsyncStorage.getItem(AGREED_KEY);
  useAuth.setState({ hasAgreed: val === "1" });
}
