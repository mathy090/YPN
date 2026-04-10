// app/_layout.tsx
//
// SECURITY: The app renders a black splash overlay until bootAndVerify()
// resolves. Navigation ONLY fires after the backend has confirmed the token.
// No cached session can bypass this gate.

import { Stack, useRootNavigationState, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../src/store/authStore";

export default function RootLayout() {
  const router = useRouter();
  const navState = useRootNavigationState();
  const { bootAndVerify } = useAuth();

  // Keep the splash gate up until we have a definitive result.
  const [booting, setBooting] = useState(true);
  const [statusMsg, setStatusMsg] = useState("Verifying session…");

  const didBoot = useRef(false);

  useEffect(() => {
    // Wait for the Expo Router navigator to fully mount before navigating.
    if (!navState?.key) return;
    if (didBoot.current) return;
    didBoot.current = true;

    (async () => {
      setStatusMsg("Verifying session…");

      const result = await bootAndVerify();

      if (result.ok) {
        // Backend confirmed — route based on profile completeness.
        if (result.hasProfile) {
          router.replace("/tabs/discord");
        } else {
          // Firebase account exists but profile setup not finished.
          router.replace("/auth/device");
        }
      } else {
        // Any failure: sign-out already done inside bootAndVerify.
        switch (result.reason) {
          case "offline":
          case "timeout":
            setStatusMsg(
              "Could not reach server. Please check your connection.",
            );
            // Give the user a moment to read the message then redirect.
            await new Promise((r) => setTimeout(r, 1800));
            break;
          case "auth_error":
          case "no_user":
          default:
            break;
        }
        router.replace("/welcome");
      }

      setBooting(false);
    })();
  }, [navState?.key]); // eslint-disable-line react-hooks/exhaustive-deps

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

      {/*
        Blocking splash gate.
        Stays on top of everything until bootAndVerify() resolves AND
        the router.replace() call has fired.  setBooting(false) is called
        AFTER replace() so there is zero flash of the wrong screen.
      */}
      {booting && (
        <View style={styles.splash}>
          <ActivityIndicator size="large" color="#1DB954" />
          <Text style={styles.msg}>{statusMsg}</Text>
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
