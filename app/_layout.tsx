// app/_layout.tsx
import {
  Stack,
  usePathname,
  useRootNavigationState,
  useRouter,
} from "expo-router";
import * as SecureStore from "expo-secure-store"; // ✅ Direct SecureStore import
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SessionExpiredProvider } from "../src/context/SessionExpiredContext";
import { useSessionHeartbeat } from "../src/hooks/useSessionHeartbeat";
import { useAuth } from "../src/store/authStore";
import { getLastRoute } from "../src/utils/cacheAppState";
import { getUserData } from "../src/utils/tokenManager";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const REFRESH_TOKEN_KEY = "refreshToken"; // 🔑 MUST match your actual key

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const navState = useRootNavigationState();
  const { checkAuth, isAuthenticated, isChecking } = useAuth();
  const [showExpired, setShowExpired] = useState(false);

  // ✅ Use ref + module flag for bulletproof single execution
  const didBoot = useRef(false);
  const BOOT_LOCKED = useRef(false);

  useSessionHeartbeat(isAuthenticated);

  useEffect(() => {
    // 🛑 TRIPLE GUARD - prevents any redirect loops
    if (BOOT_LOCKED.current || didBoot.current) return;

    // ✅ Only check pathname AFTER navigation is ready
    if (!navState?.key) return;

    // ✅ Normalize pathname check (Expo Router always uses leading slash)
    if (pathname?.startsWith("/welcome")) return;

    // 🔒 Lock immediately before any async work
    didBoot.current = true;
    BOOT_LOCKED.current = true;

    const boot = async () => {
      try {
        // 🔐 DIRECT SECURESTORE CHECK (bypasses any caching in getBackendToken)
        console.log(
          "[RootLayout] Checking SecureStore for:",
          REFRESH_TOKEN_KEY,
        );
        const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
        const hasValidToken = !!refreshToken && refreshToken.trim() !== "";

        if (!hasValidToken) {
          console.log(
            "[RootLayout] ❌ No refresh token → redirect to /welcome",
          );
          // ✅ Use replace with explicit pathname object for reliability
          router.replace({ pathname: "/welcome" });
          return;
        }

        console.log("[RootLayout] ✅ Token found, proceeding with auth...");

        // ✅ Token exists → validate with backend
        const valid = await checkAuth();
        if (!valid) {
          console.log(
            "[RootLayout] ❌ Auth validation failed → redirect to /welcome",
          );
          router.replace({ pathname: "/welcome" });
          return;
        }

        // ✅ Auth passed → check profile completion
        const user = await getUserData();
        if (!user?.hasProfile) {
          console.log(
            "[RootLayout] ⚠️ Profile incomplete → redirect to /auth/device",
          );
          router.replace({
            pathname: "/auth/device",
            params: { userEmail: user?.email || "" },
          } as any);
          return;
        }

        // ✅ All checks passed → restore session
        console.log("[RootLayout] ✅ All checks passed, restoring session...");
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
          router.replace("/(tabs)/discord");
        }
      } catch (error) {
        console.error("[RootLayout] 💥 Boot error:", error);
        // ✅ On any error, safely redirect to welcome
        if (!pathname?.startsWith("/welcome")) {
          router.replace({ pathname: "/welcome" });
        }
      }
    };

    boot();
  }, [navState?.key]); // ✅ Only depend on navState - pathname changes handled inside

  // ✅ Show splash ONLY during initial auth check, never block navigation
  const shouldShowSplash = isChecking && !pathname?.startsWith("/welcome");

  return (
    <>
      {/* ✅ Splash overlay - pointerEvents=none ensures it doesn't block touches */}
      {shouldShowSplash && (
        <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
          <View style={styles.splash}>
            <ActivityIndicator size="large" color="#1DB954" />
            <Text style={styles.msg}>Verifying session…</Text>
          </View>
        </View>
      )}

      <SessionExpiredProvider
        show={showExpired}
        onHide={() => {
          setShowExpired(false);
          router.replace("/auth/otp");
        }}
      >
        {/* ✅ Stack ALWAYS renders - navigation works even during splash */}
        <Stack
          screenOptions={{
            headerShown: false,
            animation: "slide_from_right",
            contentStyle: { backgroundColor: "#121212" },
          }}
        >
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
    </>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: "#121212",
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
