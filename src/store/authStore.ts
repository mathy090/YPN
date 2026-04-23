// src/store/authStore.ts
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import {
  getAuth,
  signInWithEmailAndPassword, // Bug 1 fixed - import separately
} from "firebase/auth";
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

const TERMS_AGREED_KEY = "user.terms_agreed";

interface AuthState {
  isAuthenticated: boolean;
  isChecking: boolean;
  isSessionExpired: boolean;
  user: UserData | null;
  hasAgreed: boolean;

  initAuth: () => Promise<void>; // Bug 7 fixed - added to interface
  checkAuth: () => Promise<boolean>;
  login: (email: string, password: string) => Promise<void>;
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
  hasAgreed: false,

  // Bug 7 fixed - properly defined, exported in interface
  initAuth: async () => {
    try {
      const agreed = await SecureStore.getItemAsync(TERMS_AGREED_KEY);
      set({ hasAgreed: agreed === "true" });
    } catch (error) {
      console.warn("[AuthStore] Failed to load terms agreement:", error);
    }
  },

  // Bug 1 fixed - use imported signInWithEmailAndPassword
  // Bug 2 fixed - saveTokens called with one arg
  login: async (email: string, password: string) => {
    set({ isChecking: true });
    try {
      const API_URL = process.env.EXPO_PUBLIC_API_URL;
      if (!API_URL) throw new Error("API_URL_NOT_SET");

      const auth = getAuth();
      // Bug 1 fix: use imported function, not auth.signInWithEmailAndPassword
      const result = await signInWithEmailAndPassword(auth, email, password);
      const user = result.user;

      if (!user.emailVerified) {
        await auth.signOut();
        throw new Error("Email not verified");
      }

      await bindSessionToUID(user.uid);

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

      // Bug 2 fix: saveTokens takes one arg, uid binding already inside it
      await saveTokens(TokenResponse);

      set({
        isAuthenticated: true,
        isChecking: false,
        isSessionExpired: false,
        user: TokenResponse.user,
      });

      get().startHeartbeat();
    } catch (error: any) {
      set({ isChecking: false });

      if (isAuthError(error) || error.message?.includes("Email not verified")) {
        await clearAllTokens();
      }

      throw error;
    }
  },

  agreeToTerms: async () => {
    try {
      await SecureStore.setItemAsync(TERMS_AGREED_KEY, "true");
      set({ hasAgreed: true });
    } catch (error) {
      console.error("[AuthStore] Failed to save terms agreement:", error);
      set({ hasAgreed: true });
    }
  },

  checkAuth: async () => {
    set({ isChecking: true });
    stopBackgroundRetry();

    const attemptAuth = async () => {
      let token = await getBackendToken();
      const storedUID = await getStoredUID();

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

      if (!token) {
        console.log("[AuthStore] Token missing/expired, attempting refresh...");

        let firebaseToken: string | undefined;
        if (currentUser) {
          try {
            firebaseToken = await currentUser.getIdToken(true);
          } catch (e) {
            console.warn("[AuthStore] Could not get Firebase token:", e);
          }
        }

        const refreshedData = await refreshTokens(firebaseToken);
        // Bug 2 fix: single arg
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

      console.warn("[AuthStore] Session expired or invalid.");
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
    console.log("[AuthStore] Sign out requested");
  },

  confirmSignOut: async (
    email: string,
    password: string,
    clearLocalDb: () => Promise<void>,
  ) => {
    console.log("[AuthStore] Confirming sign out...");

    try {
      const API_URL = process.env.EXPO_PUBLIC_API_URL;
      if (!API_URL) throw new Error("API_URL_NOT_SET");

      let currentToken = await getBackendToken();
      if (!currentToken) {
        try {
          const refreshedData = await refreshTokens();
          // Bug 2 fix: single arg
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
    } catch (error: any) {
      console.error("[AuthStore] Sign out failed:", error.message);
      throw error;
    }
  },

  cancelSignOut: () => {
    console.log("[AuthStore] Sign out cancelled");
  },

  startHeartbeat: () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    heartbeatInterval = setInterval(async () => {
      const expiry = await getTokenExpiry();
      const now = Date.now();
      const timeLeft = expiry - now;

      if (timeLeft < 10 * 60 * 1000 && timeLeft > 0) {
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
          // Bug 2 fix: single arg
          await saveTokens(refreshedData);
        } catch (e: any) {
          console.warn("[AuthStore] Silent refresh failed:", e.message);
        }
      } else if (timeLeft <= 0) {
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
