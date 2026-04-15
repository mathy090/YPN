// app/_layout.tsx
import { useFocusEffect } from "@react-navigation/native";
import {
  Stack,
  usePathname,
  useRootNavigationState,
  useRouter,
} from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../src/store/authStore";
import { getLastRoute, saveLastRoute } from "../src/utils/cacheAppState";

// List of routes that are considered "pre-auth" or public
const PUBLIC_ROUTES = ["welcome", "auth/otp", "auth/phone", "index"];

export default function RootLayout() {
  const router = useRouter();
  const navState = useRootNavigationState();
  const pathname = usePathname();
  const { bootAndVerify } = useAuth();

  const [booting, setBooting] = useState(true);
  const didBoot = useRef(false);

  // Cache the current route whenever it changes
  useFocusEffect(
    useCallback(() => {
      if (pathname) {
        saveLastRoute(pathname);
      }
    }, [pathname]),
  );

  useEffect(() => {
    if (!navState?.key) return;
    if (didBoot.current) return;
    didBoot.current = true;

    const handleBoot = async () => {
      const result = await bootAndVerify();

      if (result.ok) {
        // User is authenticated
        const lastRoute = await getLastRoute();

        // Determine where to go
        let targetRoute = "/tabs/discord"; // Default home

        if (lastRoute && !PUBLIC_ROUTES.some((r) => lastRoute.includes(r))) {
          // If last route was a protected page (e.g., TeamYPN), go there
          targetRoute = lastRoute;
        } else if (!result.hasProfile) {
          // If profile not complete, force device setup
          targetRoute = "/auth/device";
        }

        router.replace(targetRoute as any);
      } else {
        // User is NOT authenticated
        router.replace("/welcome");
      }

      setBooting(false);
    };

    handleBoot();
  }, [navState?.key]);

  return (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: "slide_from_right",
          gestureEnabled: true,
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen
          name="tabs"
          options={{ headerShown: false, animation: "none" }}
        />
        <Stack.Screen
          name="discord"
          options={{
            headerShown: false,
            animation: "slide_from_bottom",
            presentation: "fullScreenModal",
          }}
        />
        <Stack.Screen
          name="discordChannel"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="chat"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="welcome"
          options={{ headerShown: false, animation: "fade" }}
        />
        <Stack.Screen name="auth" options={{ headerShown: false }} />
        <Stack.Screen
          name="TeamYPN"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
      </Stack>

      {booting && (
        <View style={styles.splash}>
          <ActivityIndicator size="large" color="#1DB954" />
          <Text style={styles.msg}>Loading YPN...</Text>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  splash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
    zIndex: 9999,
  },
  msg: {
    color: "#B3B3B3",
    fontSize: 14,
    textAlign: "center",
    paddingHorizontal: 32,
  },
});
