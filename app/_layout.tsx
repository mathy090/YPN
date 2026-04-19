// app/_layout.tsx
import {
  Stack,
  usePathname,
  useRootNavigationState,
  useRouter,
} from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SessionExpiredProvider } from "../src/context/SessionExpiredContext";
import { useSessionHeartbeat } from "../src/hooks/useSessionHeartbeat";
import { useAuth } from "../src/store/authStore";
import { getLastRoute } from "../src/utils/cacheAppState";
import { getUserData } from "../src/utils/tokenManager";
// ✅ ADD THIS: Import SQLite init
import { initChatDB } from "../src/utils/chatCache";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const REFRESH_TOKEN_KEY = "app.refresh_token";

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const navState = useRootNavigationState();
  const { checkAuth, isAuthenticated, isChecking } = useAuth();
  const [showExpired, setShowExpired] = useState(false);

  const didBoot = useRef(false);
  const BOOT_LOCKED = useRef(false);

  useSessionHeartbeat(isAuthenticated);

  // ✅ ADD THIS: Initialize SQLite database on app start
  useEffect(() => {
    let mounted = true;

    const initDB = async () => {
      try {
        await initChatDB();
        console.log("[RootLayout] ✅ SQLite chat database initialized");
      } catch (err) {
        console.warn("[RootLayout] ⚠️ SQLite init failed:", err);
        // Non-fatal: app can still work with API-only mode
      }
    };

    initDB();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (BOOT_LOCKED.current || didBoot.current) return;
    if (!navState?.key) return;

    const publicRoutes = [
      "/welcome",
      "/auth/otp",
      "/auth/phone",
      "/auth/login",
      "/auth/device",
    ];
    if (publicRoutes.some((route) => pathname?.startsWith(route))) {
      didBoot.current = true;
      return;
    }

    didBoot.current = true;
    BOOT_LOCKED.current = true;

    const boot = async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));

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
          router.replace({ pathname: "/welcome" });
          return;
        }

        console.log("[RootLayout] ✅ Token found, proceeding with auth...");

        const valid = await checkAuth();
        if (!valid) {
          console.log(
            "[RootLayout] ❌ Auth validation failed → redirect to /welcome",
          );
          router.replace({ pathname: "/welcome" });
          return;
        }

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

        console.log("[RootLayout] ✅ All checks passed, restoring session...");
        const lastRoute = await getLastRoute();
        const protectedRoutes = [
          "/welcome",
          "/auth/otp",
          "/auth/phone",
          "/auth/login",
          "/auth/device",
        ];

        if (lastRoute && !protectedRoutes.includes(lastRoute)) {
          router.replace(lastRoute as any);
        } else {
          router.replace("/(tabs)/discord");
        }
      } catch (error) {
        console.error("[RootLayout] 💥 Boot error:", error);
        if (!pathname?.startsWith("/welcome")) {
          router.replace({ pathname: "/welcome" });
        }
      }
    };

    boot();
  }, [navState?.key]);

  const shouldShowSplash = isChecking && !pathname?.startsWith("/welcome");

  return (
    <>
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
          {/* ✅ ADD THIS: Register the chat channel screen */}
          <Stack.Screen
            name="discordChannel"
            options={{ presentation: "card", animation: "slide_from_bottom" }}
          />
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
