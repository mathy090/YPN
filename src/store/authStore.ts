// src/store/authStore.ts
import { router } from "expo-router";
import { create } from "zustand";
import {
  clearAllTokens,
  getBackendToken,
  getTokenExpiry,
  getUserData,
  OfflineError,
  refreshTokens,
  saveTokens,
  startBackgroundRetry,
  stopBackgroundRetry,
  UserData,
} from "../utils/tokenManager";

interface AuthState {
  isAuthenticated: boolean;
  isChecking: boolean;
  isSessionExpired: boolean; // ✅ NEW: Track expired session without auto-logout
  user: UserData | null;
  checkAuth: () => Promise<boolean>;
  login: (email: string, password: string) => Promise<void>;
  // ✅ NEW: Two-step sign out flow
  requestSignOut: () => void; // Starts password confirmation
  confirmSignOut: (
    email: string,
    password: string,
    clearLocalDb: () => Promise<void>,
  ) => Promise<void>; // Executes after verification
  cancelSignOut: () => void; // Cancels pending sign out
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
}

let heartbeatInterval: NodeJS.Timeout | null = null;

export const useAuth = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  isChecking: true,
  isSessionExpired: false, // ✅ Default: not expired
  user: null,

  // ✅ Login Function for REST API
  login: async (email: string, password: string) => {
    set({ isChecking: true });
    try {
      const API_URL = process.env.EXPO_PUBLIC_API_URL;
      if (!API_URL) throw new Error("API_URL_NOT_SET");

      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const err = await response
          .json()
          .catch(() => ({ message: "Login failed" }));
        throw new Error(err.message || "Invalid credentials");
      }

      const data = await response.json();
      await saveTokens(data);

      set({
        isAuthenticated: true,
        isChecking: false,
        isSessionExpired: false, // ✅ Clear expired flag on successful login
        user: data.user,
      });

      get().startHeartbeat();
      return true;
    } catch (error: any) {
      set({ isChecking: false });
      throw error;
    }
  },

  // ✅ Check Auth (unchanged logic, just adds expired flag handling)
  checkAuth: async () => {
    set({ isChecking: true });
    stopBackgroundRetry();

    const attemptAuth = async () => {
      let token = await getBackendToken();

      if (!token) {
        const refreshedData = await refreshTokens();
        await saveTokens(refreshedData);
        token = refreshedData.backend_jwt;
      }

      if (!token) throw new Error("NO_VALID_TOKEN");

      const user = await getUserData();
      set({
        isAuthenticated: true,
        isChecking: false,
        isSessionExpired: false,
        user: user || { uid: "unknown", email: "unknown", hasProfile: false },
      });
    };

    try {
      await attemptAuth();
      get().startHeartbeat();
      return true;
    } catch (error: any) {
      if (error instanceof OfflineError) {
        console.warn("[AuthStore] Offline. Keeping cached session.");
        const cachedUser = await getUserData();
        set({
          isAuthenticated: true,
          isChecking: false,
          isSessionExpired: false,
          user: cachedUser || {
            uid: "guest",
            email: "offline",
            hasProfile: false,
          },
        });

        startBackgroundRetry(attemptAuth, (success) => {
          if (success) {
            console.log("[AuthStore] Background retry successful.");
            get().startHeartbeat();
          }
        });
        return true;
      }

      if (
        error.message === "NO_REFRESH_TOKEN" ||
        error.message === "NO_VALID_TOKEN"
      ) {
        console.log("[AuthStore] No session found. Redirecting to Welcome.");
        set({
          isAuthenticated: false,
          isChecking: false,
          isSessionExpired: false,
          user: null,
        });
        return false;
      }

      // ✅ NEW: Instead of auto-redirect, mark session expired
      console.warn(
        "[AuthStore] Session expired or invalid. Marking for re-auth.",
      );
      set({
        isAuthenticated: true, // ✅ Stay "logged in" UI-wise
        isChecking: false,
        isSessionExpired: true, // ✅ Flag that re-auth is needed
        user: await getUserData(), // ✅ Keep user data visible
      });

      // Don't redirect - let UI handle re-auth prompt
      return false;
    }
  },

  // ✅ NEW: Start sign out flow (shows password modal)
  requestSignOut: () => {
    console.log(
      "[AuthStore] Sign out requested - awaiting password confirmation",
    );
    // Just set a flag or do nothing - UI handles the modal
  },

  // ✅ NEW: Execute sign out AFTER password verification
  confirmSignOut: async (
    email: string,
    password: string,
    clearLocalDb: () => Promise<void>,
  ) => {
    console.log("[AuthStore] Confirming sign out with credentials...");

    try {
      const API_URL = process.env.EXPO_PUBLIC_API_URL;
      if (!API_URL) throw new Error("API_URL_NOT_SET");

      // ✅ 1. Verify credentials with backend BEFORE clearing anything
      const response = await fetch(`${API_URL}/api/auth/verify-logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const err = await response
          .json()
          .catch(() => ({ message: "Verification failed" }));
        throw new Error(err.message || "Invalid credentials for sign out");
      }

      console.log(
        "[AuthStore] Credentials verified. Proceeding with secure logout...",
      );

      // ✅ 2. ONLY NOW: Clear local database (MANDATORY)
      await clearLocalDb();
      console.log("[AuthStore] Local database cleared");

      // ✅ 3. Clear all tokens
      await clearAllTokens();
      console.log("[AuthStore] Secure tokens cleared");

      // ✅ 4. Stop heartbeat and reset state
      get().stopHeartbeat();
      set({
        isAuthenticated: false,
        isChecking: false,
        isSessionExpired: false,
        user: null,
      });

      // ✅ 5. Redirect to login
      router.replace("../auth/login");
      console.log("[AuthStore] Sign out complete");
    } catch (error: any) {
      console.error("[AuthStore] Sign out verification failed:", error.message);
      // Don't clear anything if verification fails
      throw error; // Let UI show the error
    }
  },

  // ✅ NEW: Cancel pending sign out
  cancelSignOut: () => {
    console.log("[AuthStore] Sign out cancelled");
    // No state change needed - just abort the flow
  },

  // ✅ Heartbeat: Mark expired but DON'T auto-logout
  startHeartbeat: () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    console.log("[AuthStore] Heartbeat started (safe mode).");

    heartbeatInterval = setInterval(async () => {
      const expiry = await getTokenExpiry();
      const now = Date.now();
      const timeLeft = expiry - now;

      if (timeLeft < 5 * 60 * 1000 && timeLeft > 0) {
        console.log("[AuthStore] Token expiring soon. Silent refresh...");
        try {
          const refreshedData = await refreshTokens();
          await saveTokens(refreshedData);
        } catch (e) {
          console.warn("[AuthStore] Silent refresh failed.", e);
        }
      } else if (timeLeft <= 0) {
        console.log(
          "[AuthStore] Token expired. Marking session for re-auth...",
        );
        // ✅ NEW: Just mark expired, don't call signOut
        set({ isSessionExpired: true });
      }
    }, 30000);
  },

  stopHeartbeat: () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    stopBackgroundRetry();
  },
}));
