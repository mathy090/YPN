// app/_layout.tsx
import { Stack, useRootNavigationState, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SessionExpiredProvider } from "../src/context/SessionExpiredContext";
import { useSessionHeartbeat } from "../src/hooks/useSessionHeartbeat";
import { useAuth } from "../src/store/authStore";
import { getLastRoute } from "../src/utils/cacheAppState";

export default function RootLayout() {
  const router = useRouter();
  const navState = useRootNavigationState();
  const { checkAuth, isAuthenticated, isChecking } = useAuth();
  const [showExpired, setShowExpired] = useState(false);
  const didBoot = useRef(false);

  // 🔥 Start heartbeat only when authenticated
  useSessionHeartbeat(isAuthenticated);

  useEffect(() => {
    if (!navState?.key || didBoot.current) return;
    didBoot.current = true;

    const boot = async () => {
      const valid = await checkAuth();
      if (!valid) {
        setShowExpired(true);
        return;
      }

      // Preload last session
      const lastRoute = await getLastRoute();
      const publicRoutes = ["/welcome", "/auth/otp", "/auth/phone"];

      if (lastRoute && !publicRoutes.includes(lastRoute)) {
        router.replace(lastRoute as any);
      } else {
        router.replace("/tabs/discord");
      }
    };

    boot();
  }, [navState?.key]);

  if (isChecking) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={styles.msg}>Verifying session…</Text>
      </View>
    );
  }

  return (
    <SessionExpiredProvider
      show={showExpired}
      onHide={() => {
        setShowExpired(false);
        router.replace("/auth/otp");
      }}
    >
      <Stack
        screenOptions={{ headerShown: false, animation: "slide_from_right" }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="tabs" options={{ animation: "none" }} />
        <Stack.Screen
          name="discord"
          options={{ presentation: "fullScreenModal" }}
        />
        <Stack.Screen name="welcome" options={{ animation: "fade" }} />
        <Stack.Screen name="auth" />
        <Stack.Screen name="TeamYPN" />
        <Stack.Screen name="settings" />
      </Stack>
    </SessionExpiredProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
  },
  msg: { color: "#B3B3B3", fontSize: 14, textAlign: "center" },
});
