// app/_layout.tsx
import { Stack, useRootNavigationState, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SessionExpiredProvider } from "../src/context/SessionExpiredContext";
import { useSessionHeartbeat } from "../src/hooks/useSessionHeartbeat";
import { useAuth } from "../src/store/authStore";
import { getCachedProfile } from "../src/utils/cache";
import { getLastRoute } from "../src/utils/cacheAppState";
import { getBackendToken } from "../src/utils/tokenManager";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

export default function RootLayout() {
  const router = useRouter();
  const navState = useRootNavigationState();
  const { checkAuth, isAuthenticated, isChecking } = useAuth();
  const [showExpired, setShowExpired] = useState(false);
  const didBoot = useRef(false);

  // 🔥 Start heartbeat only when authenticated
  useSessionHeartbeat(isAuthenticated);

  useEffect(() => {
    // Wait for navigation to be ready and ensure we only run once
    if (!navState?.key || didBoot.current) return;
    didBoot.current = true;

    const boot = async () => {
      try {
        const valid = await checkAuth();

        if (!valid) {
          // ❌ AUTH FAILED (No cache, invalid token, or offline without session)
          console.log("[RootLayout] Auth failed. Redirecting to Welcome.");

          // 1. Hide any expired modal
          setShowExpired(false);

          // 2. FORCE REDIRECT to Welcome screen for first-time users
          router.replace("/welcome");
          return;
        }

        // ✅ AUTH SUCCESS - Now check if profile exists in MongoDB
        console.log("[RootLayout] Auth successful. Checking profile setup...");

        // 🔥 Check if user has completed profile setup (username set in MongoDB)
        const hasProfile = await checkProfileSetup();

        if (!hasProfile) {
          // ❌ User authenticated but NO profile in MongoDB → redirect to setup
          console.log(
            "[RootLayout] Profile not set up. Redirecting to /auth/device",
          );

          // Get user email from cache or token for pre-filling device screen
          const cached = await getCachedProfile();
          const userEmail = cached?.email || "";

          router.replace({
            pathname: "/auth/device",
            params: { userEmail },
          } as any);
          return;
        }

        // ✅ Profile exists → restore normal session
        console.log("[RootLayout] Profile found. Restoring session.");

        // Preload last session
        const lastRoute = await getLastRoute();
        const publicRoutes = [
          "/welcome",
          "/auth/otp",
          "/auth/phone",
          "/auth/login",
          "/auth/device",
        ];

        if (lastRoute && !publicRoutes.includes(lastRoute)) {
          router.replace(lastRoute as any);
        } else {
          // Default fallback if no last route found
          router.replace("/(tabs)/discord");
        }
      } catch (error) {
        console.error("[RootLayout] Boot error:", error);
        // On critical error, safest bet is to send to welcome/login
        router.replace("/welcome");
      }
    };

    boot();
  }, [navState?.key]);

  // 🔥 NEW: Check if user has completed profile setup in MongoDB
  const checkProfileSetup = async (): Promise<boolean> => {
    try {
      // 1. Try cached profile first (offline support)
      const cached = await getCachedProfile();
      if (cached?.username && cached?.email) {
        console.log("[RootLayout] Using cached profile:", cached.username);
        return true;
      }

      // 2. Fetch fresh profile from backend
      const backendToken = await getBackendToken();
      if (!backendToken) {
        console.warn("[RootLayout] No backend token for profile check");
        return false;
      }

      const response = await fetch(`${API_URL}/api/users/profile`, {
        headers: {
          Authorization: `Bearer ${backendToken}`,
          "Content-Type": "application/json",
        },
      });

      // Handle 404 = profile not found in MongoDB
      if (response.status === 404) {
        console.log("[RootLayout] Profile not found in MongoDB (404)");
        return false;
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.warn("[RootLayout] Profile fetch failed:", err.message);
        // If token expired, let auth flow handle re-auth
        if (response.status === 401) return false;
        // For other errors, assume profile exists to avoid redirect loops
        return true;
      }

      const profile = await response.json();

      // 🔥 Key check: does profile have a username? (profile completion flag)
      const hasUsername =
        !!profile?.username && profile.username.trim().length > 0;

      console.log("[RootLayout] Profile check:", {
        uid: profile?.uid,
        hasUsername,
        username: profile?.username,
      });

      return hasUsername;
    } catch (error) {
      // Network error / offline: check cache as fallback
      console.warn("[RootLayout] Profile check error (offline?):", error);

      const cached = await getCachedProfile();
      if (cached?.username) {
        console.log("[RootLayout] Using cached username while offline");
        return true;
      }

      // If truly no data, assume profile not set up
      return false;
    }
  };

  // Show Splash Screen while checking
  if (isChecking) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={styles.msg}>Verifying session…</Text>
      </View>
    );
  }

  // Render the Stack Navigator once checking is done
  return (
    <SessionExpiredProvider
      show={showExpired}
      onHide={() => {
        setShowExpired(false);
        // If they dismiss the expired modal, send them to login/otp
        router.replace("/auth/otp");
      }}
    >
      <Stack
        screenOptions={{
          headerShown: false,
          animation: "slide_from_right",
          contentStyle: { backgroundColor: "#121212" }, // Match your theme
        }}
      >
        {/* 
           Ensure these names match your FILE PATHS exactly inside app/ 
           Example: app/welcome.tsx -> name="welcome"
           Example: app/(tabs)/_layout.tsx -> name="(tabs)"
        */}
        <Stack.Screen name="index" />
        <Stack.Screen name="(tabs)" options={{ animation: "none" }} />
        <Stack.Screen
          name="discord"
          options={{ presentation: "fullScreenModal" }}
        />
        <Stack.Screen name="welcome" options={{ animation: "fade" }} />
        <Stack.Screen name="auth" />
        <Stack.Screen name="TeamYPN" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="chat" />
        <Stack.Screen name="voice-call" />
        <Stack.Screen name="splash" />
      </Stack>
    </SessionExpiredProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: "#121212", // Match your dark theme
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
  },
  msg: {
    color: "#B3B3B3",
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
  },
});
