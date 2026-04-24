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

const PUBLIC_ROUTES = ["/welcome", "/auth", "/auth/otp", "/auth/phone"];

const isPublicRoute = (path?: string) => {
  if (!path) return false;
  return PUBLIC_ROUTES.some((route) => path.startsWith(route));
};

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const navState = useRootNavigationState();

  const { checkAuth, isChecking, initAuth } = useAuth();

  const [showExpired, setShowExpired] = useState(false);
  const didBoot = useRef(false);

  useSessionHeartbeat(true);

  // ─────────────────────────────────────────────
  // INIT SYSTEMS (DB + AUTH)
  // ─────────────────────────────────────────────
  useEffect(() => {
    initChatDB().catch(console.warn);
    initAuth().catch(console.warn);
  }, []);

  // ─────────────────────────────────────────────
  // BOOTSTRAP NAVIGATION (MAIN FIXED LOGIC)
  // ─────────────────────────────────────────────
  useEffect(() => {
    if (!navState?.key) return;
    if (didBoot.current) return;

    didBoot.current = true;

    const timer = setTimeout(() => {
      boot();
    }, 80);

    return () => clearTimeout(timer);
  }, [navState?.key]);

  const boot = async () => {
    try {
      // 1. Check refresh token exists
      const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);

      if (!refreshToken) {
        router.replace("/welcome");
        return;
      }

      // 2. Validate auth session
      const valid = await checkAuth();

      if (!valid) {
        router.replace("/welcome");
        return;
      }

      // 3. Get user profile
      const user = await getUserData();

      if (!user) {
        router.replace("/auth");
        return;
      }

      // 4. Ensure profile setup is complete
      if (!user?.hasProfile) {
        router.replace("/auth/device");
        return;
      }

      // 5. Restore last route if safe
      const lastRoute = await getLastRoute();

      if (lastRoute && !isPublicRoute(lastRoute)) {
        router.replace(lastRoute as any);
        return;
      }

      // 6. DEFAULT: always go to Discord (your main app screen)
      router.replace("/(tabs)/discord");
    } catch (err) {
      console.warn("Boot error:", err);
      router.replace("/welcome");
    }
  };

  // ─────────────────────────────────────────────
  // SPLASH CONTROL
  // ─────────────────────────────────────────────
  const shouldShowSplash =
    isChecking &&
    !isPublicRoute(pathname) &&
    pathname !== "/" &&
    pathname !== "/index";

  return (
    <>
      {shouldShowSplash && (
        <View style={StyleSheet.absoluteFillObject}>
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
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="welcome" />
          <Stack.Screen name="auth" />
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
  },
  msg: {
    color: "#B3B3B3",
    marginTop: 10,
  },
});
