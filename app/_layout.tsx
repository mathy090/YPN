// app/_layout.tsx
import {
  Stack,
  usePathname,
  useRootNavigationState,
  useRouter,
} from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SessionExpiredProvider } from "../src/context/SessionExpiredContext";
import { useSessionHeartbeat } from "../src/hooks/useSessionHeartbeat";
import { useAuth } from "../src/store/authStore";
import { getLastRoute } from "../src/utils/cacheAppState";
import { getBackendToken, getUserData } from "../src/utils/tokenManager";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

// 🔒 Module-level flag survives component remounts, Fast Refresh & nav transitions
let BOOT_LOCKED = false;

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const navState = useRootNavigationState();
  const { checkAuth, isAuthenticated, isChecking } = useAuth();
  const [showExpired, setShowExpired] = useState(false);

  useSessionHeartbeat(isAuthenticated);

  useEffect(() => {
    // 🛑 TRIPLE GUARD: Prevents loop 100% of the time
    if (BOOT_LOCKED) return; // Already ran this session
    if (pathname === "/welcome" || pathname === "welcome") return; // Already on target
    if (!navState?.key) return; // Navigation container not ready

    BOOT_LOCKED = true; // 🔒 Lock immediately (won't reset on remount)

    const boot = async () => {
      try {
        const token = await getBackendToken();

        if (!token) {
          console.log("[RootLayout] No valid token → redirect to /welcome");
          setTimeout(() => router.replace({ pathname: "/welcome" }), 300);
          return;
        }

        const valid = await checkAuth();
        if (!valid) {
          console.log("[RootLayout] Auth failed → redirect to /welcome");
          setTimeout(() => router.replace({ pathname: "/welcome" }), 300);
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
        console.error("[RootLayout] Boot error:", error);
        setTimeout(() => router.replace({ pathname: "/welcome" }), 300);
      }
    };

    boot();
  }, [navState?.key, pathname]);

  // ✅ FIX: Only show splash overlay if NOT already navigating to welcome
  // This prevents the overlay from blocking the welcome screen after redirect
  const showSplash =
    isChecking && pathname !== "/welcome" && pathname !== "welcome";

  return (
    <>
      {showSplash && (
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
        {/* ✅ Stack ALWAYS renders - navigation happens even if splash is visible */}
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
