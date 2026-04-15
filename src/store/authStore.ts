// src/store/authStore.ts
import { create } from "zustand";
import { clearLastRoute } from "../utils/cacheAppState";
import { clearAllTokens, getValidBackendToken } from "../utils/tokenManager";

interface AuthState {
  isAuthenticated: boolean;
  isChecking: boolean;
  user: { uid: string; email: string; hasProfile: boolean } | null;
  checkAuth: () => Promise<boolean>;
  signOut: () => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  isChecking: true,
  user: null,

  checkAuth: async () => {
    set({ isChecking: true });
    try {
      const token = await getValidBackendToken(); // Auto-refreshes if needed
      // Decode payload or fetch user profile if needed
      // For now, we assume valid token = authenticated
      set({ isAuthenticated: true, isChecking: false });
      return true;
    } catch {
      await clearAllTokens();
      await clearLastRoute();
      set({ isAuthenticated: false, isChecking: false, user: null });
      return false;
    }
  },

  signOut: async () => {
    await clearAllTokens();
    await clearLastRoute();
    set({ isAuthenticated: false, isChecking: false, user: null });
  },
}));
