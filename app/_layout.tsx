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

// All routes that should NEVER show the loading splash
const PUBLIC_ROUTES = [
  "/welcome",
  "/auth/otp",
  "/auth/phone",
  "/auth/login",
  "/auth/device",
  "/auth/forgot-password",
  "/auth/reset-sent",
];

const isPublicRoute = (path: string | undefined): boolean => {
  if (!path) return false;
  return PUBLIC_ROUTES.some((route) => path.startsWith(route));
};

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const navState = useRootNavigationState();
  const { checkAuth, isAuthenticated, isChecking } = useAuth();
  const [showExpired, setShowExpired] = useState(false);

  const didBoot = useRef(false);
  const BOOT_LOCKED = useRef(false);

  useSessionHeartbeat(isAuthenticated);

  // Initialize SQLite on startup
  useEffect(() => {
    initChatDB().catch((err) =>
      console.warn("[RootLayout] SQLite init failed:", err),
    );
  }, []);

  useEffect(() => {
    if (BOOT_LOCKED.current || didBoot.current) return;
    if (!navState?.key) return;

    // Don't run boot logic on public/auth routes — let them navigate freely
    if (isPublicRoute(pathname)) {
      didBoot.current = true;
      return;
    }

    didBoot.current = true;
    BOOT_LOCKED.current = true;

    const boot = async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));

        const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
        const hasValidToken = !!refreshToken && refreshToken.trim() !== "";

        if (!hasValidToken) {
          router.replace({ pathname: "/welcome" });
          return;
        }

        const valid = await checkAuth();
        if (!valid) {
          router.replace({ pathname: "/welcome" });
          return;
        }

        const user = await getUserData();
        if (!user?.hasProfile) {
          router.replace({
            pathname: "/auth/device",
            params: { userEmail: user?.email || "" },
          } as any);
          return;
        }

        const lastRoute = await getLastRoute();
        if (lastRoute && !isPublicRoute(lastRoute)) {
          router.replace(lastRoute as any);
        } else {
          router.replace("/(tabs)/discord");
        }
      } catch (error) {
        console.error("[RootLayout] Boot error:", error);
        if (!isPublicRoute(pathname)) {
          router.replace({ pathname: "/welcome" });
        }
      }
    };

    boot();
  }, [navState?.key]);

  // ✅ FIX: Never show splash on public/auth routes — this was blocking navigation
  const shouldShowSplash =
    isChecking && !isPublicRoute(pathname) && !pathname?.startsWith("/welcome");

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
          <Stack.Screen name="splash" />
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
