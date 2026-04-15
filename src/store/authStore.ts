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
  isSessionExpired: boolean;
  user: UserData | null;
  checkAuth: () => Promise<boolean>;
  login: (email: string, password: string) => Promise<void>;
  requestSignOut: () => void;
  confirmSignOut: (
    email: string,
    password: string,
    clearLocalDb: () => Promise<void>,
  ) => Promise<void>;
  cancelSignOut: () => void;
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
}

let heartbeatInterval: NodeJS.Timeout | null = null;

export const useAuth = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  isChecking: true,
  isSessionExpired: false,
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
        isSessionExpired: false,
        user: data.user,
      });

      get().startHeartbeat();
      return true;
    } catch (error: any) {
      set({ isChecking: false });
      throw error;
    }
  },

  // ✅ Check Auth
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

      console.warn(
        "[AuthStore] Session expired or invalid. Marking for re-auth.",
      );
      set({
        isAuthenticated: true,
        isChecking: false,
        isSessionExpired: true,
        user: await getUserData(),
      });
      return false;
    }
  },

  // ✅ Start sign out flow (shows password modal)
  requestSignOut: () => {
    console.log(
      "[AuthStore] Sign out requested - awaiting password confirmation",
    );
  },

  // ✅ Execute sign out AFTER password verification - ✅ FIXED
  confirmSignOut: async (
    email: string,
    password: string,
    clearLocalDb: () => Promise<void>,
  ) => {
    console.log("[AuthStore] Confirming sign out with credentials...");

    try {
      const API_URL = process.env.EXPO_PUBLIC_API_URL;
      if (!API_URL) throw new Error("API_URL_NOT_SET");

      // ✅ STEP 1: Get the CURRENT valid backend JWT for Authorization header
      console.log("[AuthStore] Fetching current backend token for sign-out...");
      let currentToken = await getBackendToken();

      // If no valid token, try to refresh first
      if (!currentToken) {
        console.log("[AuthStore] No valid token found, attempting refresh...");
        try {
          const refreshedData = await refreshTokens();
          await saveTokens(refreshedData);
          currentToken = await getBackendToken();
        } catch (refreshError: any) {
          console.warn(
            "[AuthStore] Token refresh failed during sign-out:",
            refreshError.message,
          );
          throw new Error("Session expired. Please sign in again to sign out.");
        }
      }

      if (!currentToken) {
        throw new Error("Could not obtain valid authentication token");
      }

      console.log("[AuthStore] Token ready for sign-out request");

      // ✅ STEP 2: Get user UID for the request body
      const userData = await getUserData();
      const firebaseUid = userData?.uid || get()?.user?.uid;

      if (!firebaseUid) {
        console.warn(
          "[AuthStore] Could not determine firebase_uid, using email only",
        );
      }

      // ✅ STEP 3: Call backend sign-out endpoint WITH proper Authorization header
      console.log("[AuthStore] Calling POST /api/auth/signout...");

      const signoutResponse = await fetch(`${API_URL}/api/auth/signout`, {
        method: "POST",
        headers: {
          // ✅ CRITICAL: Send backend JWT in Authorization header
          Authorization: `Bearer ${currentToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim(),
          firebase_uid: firebaseUid,
        }),
      });

      const signoutData = await signoutResponse.json().catch(() => ({}));

      console.log("[AuthStore] Sign-out response:", {
        status: signoutResponse.status,
        ok: signoutResponse.ok,
        success: signoutData.success,
        message: signoutData.message,
        code: signoutData.code,
      });

      // ✅ STEP 4: Handle response
      if (!signoutResponse.ok) {
        if (signoutResponse.status === 401) {
          throw new Error("Invalid credentials. Please check your password.");
        }
        if (signoutResponse.status === 403) {
          throw new Error("Authentication failed. Please sign in again.");
        }
        if (signoutData.code === "USER_NOT_FOUND") {
          // User not found is OK - proceed with local cleanup (idempotent sign-out)
          console.warn(
            "[AuthStore] User not found in DB, proceeding with local sign-out",
          );
        } else {
          throw new Error(
            signoutData.message || "Sign-out failed. Please try again.",
          );
        }
      }

      console.log(
        "[AuthStore] ✅ Backend sign-out verified. Proceeding with local cleanup...",
      );

      // ✅ STEP 5: Clear local database (MANDATORY)
      await clearLocalDb();
      console.log("[AuthStore] Local database cleared");

      // ✅ STEP 6: Clear all tokens from SecureStore
      await clearAllTokens();
      console.log("[AuthStore] Secure tokens cleared");

      // ✅ STEP 7: Stop heartbeat and reset state
      get().stopHeartbeat();
      set({
        isAuthenticated: false,
        isChecking: false,
        isSessionExpired: false,
        user: null,
      });

      // ✅ STEP 8: Redirect to login/welcome
      router.replace("/welcome");

      console.log("[AuthStore] ✅ Sign out complete - redirected to /welcome");
    } catch (error: any) {
      console.error("[AuthStore] Sign out verification failed:", error.message);
      // Don't clear anything if verification fails - let user retry
      throw error; // Let UI show the error
    }
  },

  // ✅ Cancel pending sign out
  cancelSignOut: () => {
    console.log("[AuthStore] Sign out cancelled");
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
