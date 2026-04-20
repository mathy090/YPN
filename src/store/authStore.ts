// src/store/authStore.ts
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store"; // ✅ Add SecureStore import
import { getAuth } from "firebase/auth";
import { create } from "zustand";
import {
  bindSessionToUID,
  clearAllTokens,
  getBackendToken,
  getStoredUID,
  getTokenExpiry,
  getUserData,
  isAuthError,
  isNetworkError,
  OfflineError,
  refreshTokens,
  saveTokens,
  startBackgroundRetry,
  stopBackgroundRetry,
  UIDMismatchError,
  UserData,
  validateUIDBinding,
} from "../utils/tokenManager";

// ✅ Add constant for terms agreement storage
const TERMS_AGREED_KEY = "user.terms_agreed";

interface AuthState {
  isAuthenticated: boolean;
  isChecking: boolean;
  isSessionExpired: boolean;
  user: UserData | null;

  // ✅ NEW: Terms agreement state
  hasAgreed: boolean;

  checkAuth: () => Promise<boolean>;
  login: (email: string, password: string) => Promise<void>;

  // ✅ NEW: Terms agreement action
  agreeToTerms: () => Promise<void>;

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

  // ✅ Initialize hasAgreed from SecureStore
  hasAgreed: false,

  // ✅ Load terms agreement status on store creation
  // Call this once when app starts (e.g., in _layout.tsx)
  initAuth: async () => {
    try {
      const agreed = await SecureStore.getItemAsync(TERMS_AGREED_KEY);
      set({ hasAgreed: agreed === "true" });
    } catch (error) {
      console.warn("[AuthStore] Failed to load terms agreement:", error);
    }
  },

  // ✅ Login: Firebase auth + UID binding + token exchange
  login: async (email: string, password: string) => {
    set({ isChecking: true });
    try {
      const API_URL = process.env.EXPO_PUBLIC_API_URL;
      if (!API_URL) throw new Error("API_URL_NOT_SET");

      // Firebase sign in
      const auth = getAuth();
      const result = await auth.signInWithEmailAndPassword(email, password);
      const user = result.user;

      if (!user.emailVerified) {
        await auth.signOut();
        throw new Error("Email not verified");
      }

      // 🔥 Bind session to this Firebase UID (prevents cross-user leakage)
      await bindSessionToUID(user.uid);

      // Exchange Firebase token for backend JWT
      const firebaseToken = await user.getIdToken();
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firebase_id_token: firebaseToken }),
      });

      if (!response.ok) {
        const err = await response
          .json()
          .catch(() => ({ message: "Token exchange failed" }));
        throw new Error(err.message || "Failed to obtain backend token");
      }

      const TokenResponse = await response.json();

      // 🔥 Save tokens with UID validation
      await saveTokens(TokenResponse, user.uid);

      set({
        isAuthenticated: true,
        isChecking: false,
        isSessionExpired: false,
        user: TokenResponse.user,
      });

      get().startHeartbeat();
      return true;
    } catch (error: any) {
      set({ isChecking: false });

      // 🔥 Clear tokens on auth failure to prevent stale session
      if (isAuthError(error) || error.message?.includes("Email not verified")) {
        await clearAllTokens();
      }

      throw error;
    }
  },

  // ✅ NEW: Save terms agreement to SecureStore
  agreeToTerms: async () => {
    try {
      await SecureStore.setItemAsync(TERMS_AGREED_KEY, "true");
      set({ hasAgreed: true });
      console.log("[AuthStore] ✅ Terms agreement saved");
    } catch (error) {
      console.error("[AuthStore] Failed to save terms agreement:", error);
      // Still update state even if storage fails (non-critical)
      set({ hasAgreed: true });
    }
  },

  // ✅ Check Auth: UID binding + auto-refresh
  checkAuth: async () => {
    set({ isChecking: true });
    stopBackgroundRetry();

    const attemptAuth = async () => {
      let token = await getBackendToken();
      const storedUID = await getStoredUID();

      // 🔥 Validate UID binding first
      const auth = getAuth();
      const currentUser = auth.currentUser;

      if (currentUser && storedUID) {
        const uidValid = await validateUIDBinding(currentUser.uid);
        if (!uidValid) {
          console.warn("[AuthStore] UID mismatch detected - clearing session");
          await clearAllTokens();
          throw new UIDMismatchError(storedUID, currentUser.uid);
        }
      }

      // Auto-refresh if token missing/expired
      if (!token) {
        console.log("[AuthStore] Token missing/expired, attempting refresh...");

        // Try to get fresh Firebase token for refresh
        let firebaseToken: string | undefined;
        if (currentUser) {
          try {
            firebaseToken = await currentUser.getIdToken(true);
            console.log("[AuthStore] Got fresh Firebase token for refresh");
          } catch (e) {
            console.warn("[AuthStore] Could not get Firebase token:", e);
          }
        }

        const refreshedData = await refreshTokens(firebaseToken);
        await saveTokens(refreshedData, refreshedData.user.uid);
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
      // 🔥 Network error: keep cached session, retry in background
      if (error instanceof OfflineError || isNetworkError(error)) {
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

      // 🔥 Auth error: clear session, redirect to login
      if (isAuthError(error) || error instanceof UIDMismatchError) {
        console.log("[AuthStore] Auth failed. Clearing session.");
        await clearAllTokens();
        set({
          isAuthenticated: false,
          isChecking: false,
          isSessionExpired: false,
          user: null,
        });
        return false;
      }

      // 🔥 Token expired but refresh failed: mark for re-auth
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

  requestSignOut: () => {
    console.log(
      "[AuthStore] Sign out requested - awaiting password confirmation",
    );
  },

  confirmSignOut: async (
    email: string,
    password: string,
    clearLocalDb: () => Promise<void>,
  ) => {
    console.log("[AuthStore] Confirming sign out with credentials...");

    try {
      const API_URL = process.env.EXPO_PUBLIC_API_URL;
      if (!API_URL) throw new Error("API_URL_NOT_SET");

      // Get current valid backend JWT
      let currentToken = await getBackendToken();
      if (!currentToken) {
        try {
          const refreshedData = await refreshTokens();
          await saveTokens(refreshedData, refreshedData.user.uid);
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

      const userData = await getUserData();
      const firebaseUid = userData?.uid || get()?.user?.uid;

      const signoutResponse = await fetch(`${API_URL}/api/auth/signout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${currentToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim(),
          firebase_uid: firebaseUid,
        }),
      });

      const signoutData = await signoutResponse.json().catch(() => ({}));

      if (!signoutResponse.ok) {
        if (signoutResponse.status === 401) {
          throw new Error("Invalid credentials. Please check your password.");
        }
        if (signoutResponse.status === 403) {
          throw new Error("Authentication failed. Please sign in again.");
        }
        if (signoutData.code !== "USER_NOT_FOUND") {
          throw new Error(
            signoutData.message || "Sign-out failed. Please try again.",
          );
        }
      }

      console.log(
        "[AuthStore] ✅ Backend sign-out verified. Proceeding with local cleanup...",
      );

      await clearLocalDb();
      await clearAllTokens();

      get().stopHeartbeat();
      set({
        isAuthenticated: false,
        isChecking: false,
        isSessionExpired: false,
        user: null,
      });

      router.replace("/welcome");
      console.log("[AuthStore] ✅ Sign out complete - redirected to /welcome");
    } catch (error: any) {
      console.error("[AuthStore] Sign out verification failed:", error.message);
      throw error;
    }
  },

  cancelSignOut: () => {
    console.log("[AuthStore] Sign out cancelled");
  },

  // ✅ Heartbeat: Auto-refresh before expiry
  startHeartbeat: () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    console.log("[AuthStore] Heartbeat started (auto-refresh mode).");

    heartbeatInterval = setInterval(async () => {
      const expiry = await getTokenExpiry();
      const now = Date.now();
      const timeLeft = expiry - now;

      // 🔥 Pre-emptive refresh 10 minutes before expiry
      if (timeLeft < 10 * 60 * 1000 && timeLeft > 0) {
        console.log("[AuthStore] Token expiring soon. Silent refresh...");
        try {
          const auth = getAuth();
          const currentUser = auth.currentUser;
          let firebaseToken: string | undefined;

          if (currentUser) {
            firebaseToken = await currentUser
              .getIdToken(true)
              .catch(() => undefined);
          }

          const refreshedData = await refreshTokens(firebaseToken);
          await saveTokens(refreshedData, refreshedData.user.uid);
          console.log("[AuthStore] ✅ Silent refresh successful");
        } catch (e: any) {
          console.warn("[AuthStore] Silent refresh failed:", e.message);
          // Don't logout here - let next API call handle it
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
