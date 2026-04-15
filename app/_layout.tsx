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

        // ✅ AUTH SUCCESS
        console.log("[RootLayout] Auth successful. Restoring session.");

        // Preload last session
        const lastRoute = await getLastRoute();
        const publicRoutes = [
          "/welcome",
          "/auth/otp",
          "/auth/phone",
          "/auth/login",
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
