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
import { initChatDB } from "../src/utils/chatCache";
import { getUserData } from "../src/utils/tokenManager";

const REFRESH_TOKEN_KEY = "app.refresh_token";

// ─────────────────────────────────────────────────────────────
// Public routes (NO auth interference)
// ─────────────────────────────────────────────────────────────
const PUBLIC_ROUTES = [
  "/welcome",
  "/auth",
  "/auth/otp",
  "/auth/phone",
  "/auth/login",
  "/auth/device",
  "/auth/forgot-password",
  "/auth/reset-sent",
];

const isPublicRoute = (path?: string) => {
  if (!path) return false;
  return PUBLIC_ROUTES.some((route) => path.startsWith(route));
};

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const navState = useRootNavigationState();

  const { checkAuth, isChecking, isAuthenticated } = useAuth();
  const [showExpired, setShowExpired] = useState(false);

  const didBoot = useRef(false);

  useSessionHeartbeat(isAuthenticated);

  // ─────────────────────────────────────────────────────────────
  // Init local DB
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    initChatDB().catch((err) =>
      console.warn("[RootLayout] SQLite init failed:", err),
    );
  }, []);

  // ─────────────────────────────────────────────────────────────
  // BOOT STRATEGY (SAFE VERSION)
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!navState?.key) return;

    // ❗ Never interfere with auth/public routes
    if (isPublicRoute(pathname)) return;

    // prevent double boot
    if (didBoot.current) return;
    didBoot.current = true;

    const boot = async () => {
      try {
        const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);

        // 1. No token → welcome
        if (!refreshToken) {
          router.replace("/welcome");
          return;
        }

        // 2. Validate session
        const valid = await checkAuth();
        if (!valid) {
          router.replace("/welcome");
          return;
        }

        // 3. Get user profile
        const user = await getUserData();

        // 4. No profile → onboarding
        if (!user?.hasProfile) {
          router.replace({
            pathname: "/auth/device",
            params: {
              userEmail: user?.email || "",
              userUid: user?.uid || "",
            },
          } as any);
          return;
        }

        // 5. Restore last route or go home
        const lastRoute = await getLastRoute();

        if (lastRoute && !isPublicRoute(lastRoute)) {
          router.replace(lastRoute as any);
        } else {
          router.replace("/(tabs)/discord");
        }
      } catch (error) {
        console.error("[RootLayout] Boot error:", error);
        router.replace("/welcome");
      }
    };

    boot();
  }, [navState?.key]);

  // ─────────────────────────────────────────────────────────────
  // Splash only for protected routes
  // ─────────────────────────────────────────────────────────────
  const shouldShowSplash =
    isChecking &&
    !isPublicRoute(pathname) &&
    pathname !== "/" &&
    pathname !== "/index";

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
          {/* Root */}
          <Stack.Screen name="index" />

          {/* Tabs */}
          <Stack.Screen name="(tabs)" options={{ animation: "none" }} />

          {/* Main app routes */}
          <Stack.Screen
            name="discord"
            options={{ presentation: "fullScreenModal" }}
          />
          <Stack.Screen name="chat" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="TeamYPN" />
          <Stack.Screen name="splash" />

          {/* Auth group (IMPORTANT: isolated) */}
          <Stack.Screen name="auth" options={{ headerShown: false }} />

          {/* Public screens */}
          <Stack.Screen name="welcome" options={{ animation: "fade" }} />
          <Stack.Screen
            name="support"
            options={{
              presentation: "card",
              animation: "slide_from_bottom",
              gestureEnabled: true,
            }}
          />
          <Stack.Screen
            name="privacy"
            options={{
              presentation: "card",
              animation: "slide_from_bottom",
              gestureEnabled: true,
            }}
          />
          <Stack.Screen
            name="terms"
            options={{
              presentation: "card",
              animation: "slide_from_bottom",
              gestureEnabled: true,
            }}
          />

          <Stack.Screen
            name="discordChannel"
            options={{
              presentation: "card",
              animation: "slide_from_bottom",
            }}
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
