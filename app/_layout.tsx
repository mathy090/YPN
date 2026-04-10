// app/_layout.tsx
import { Stack, useRootNavigationState, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useAuth } from "../src/store/authStore";

export default function RootLayout() {
  const router = useRouter();
  const navState = useRootNavigationState();
  const { boot, silentVerify } = useAuth();
  const [booting, setBooting] = useState(true);
  const didBoot = useRef(false);

  useEffect(() => {
    // navState.key is only set once the navigator is fully mounted.
    // Without this guard, router.replace() fires before the stack
    // exists and silently does nothing — this is the Expo Router bug.
    if (!navState?.key) return;

    // Prevent double-run on fast refresh
    if (didBoot.current) return;
    didBoot.current = true;

    (async () => {
      const result = await boot();

      if (result === "cached") {
        // Show tabs immediately from whatever route was restored,
        // then silently verify in background
        router.replace("/tabs/discord");
        setBooting(false);
        silentVerify(() => {
          router.replace("/welcome?kicked=true");
        });
      } else {
        // No cache or logged out — always force welcome,
        // overriding any restored navigation state
        router.replace("/welcome");
        setBooting(false);
      }
    })();
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
      </Stack>

      {/*
        Black overlay while booting — covers any flash of a wrong
        restored route (discord showing for 1 frame before redirect).
        Removed the instant boot finishes and navigation is dispatched.
      */}
      {booting && (
        <View style={styles.splash}>
          <ActivityIndicator size="large" color="#1DB954" />
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
  },
});
