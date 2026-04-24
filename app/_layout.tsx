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

  const { checkAuth, isChecking, isAuthenticated, initAuth } = useAuth();
  const [showExpired, setShowExpired] = useState(false);

  const booting = useRef(false);

  useSessionHeartbeat(isAuthenticated);

  // Init DB + auth
  useEffect(() => {
    initChatDB().catch((err) =>
      console.warn("[RootLayout] SQLite init failed:", err)
    );

    initAuth().catch((err) =>
      console.warn("[RootLayout] initAuth failed:", err)
    );
  }, []);

  // SAFE BOOT (FIXES ERROR 139)
  useEffect(() => {
    if (!navState?.key) return;
    if (isPublicRoute(pathname)) return;
    if (booting.current) return;

    booting.current = true;

    const run = async () => {
      try {
        const refreshToken = await SecureStore.getItemAsync(
          REFRESH_TOKEN_KEY
        );

        if (!refreshToken) {
          return router.replace("/welcome");
        }

        const valid = await checkAuth();
        if (!valid) {
          return router.replace("/welcome");
        }

        const user = await getUserData();

        if (!user?.hasProfile) {
          return router.replace("/auth/device");
        }

        const lastRoute = await getLastRoute();

        if (lastRoute && !isPublicRoute(lastRoute)) {
          return router.replace(lastRoute as any);
        }

        router.replace("/(tabs)/discord");
      } catch (error) {
        console.error("[RootLayout] Boot error:", error);
        router.replace("/welcome");
      }
    };

    // CRITICAL: wait until navigation fully mounts
    requestAnimationFrame(() => {
      run();
    });
  }, [navState?.key]);

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
          <Stack.Screen name="index" />
          <Stack.Screen name="(tabs)" options={{ animation: "none" }} />
          <Stack.Screen
            name="discord"
            options={{ presentation: "fullScreenModal" }}
          />
          <Stack.Screen name="chat" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="TeamYPN" />
          <Stack.Screen name="splash" />
          <Stack.Screen name="auth" options={{ headerShown: false }} />
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
          <Stack.Screen name="article/[id]" options={{ headerShown: false }} />
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