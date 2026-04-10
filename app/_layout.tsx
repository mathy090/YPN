// app/_layout.tsx
import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { useAuth } from "../src/store/authStore";

function AuthGuard() {
  const { isLoggedIn, hasAgreed, initialized } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!initialized) return;

    const inAuthGroup = segments[0] === "auth";
    const isWelcome = segments[0] === "welcome";
    const isIndex = segments[0] === undefined || segments[0] === "index";

    const isPublic = inAuthGroup || isWelcome || isIndex;

    if (!isPublic) {
      if (!hasAgreed) {
        router.replace("/welcome");
      } else if (!isLoggedIn) {
        router.replace("/auth/otp");
      }
    } else if (isLoggedIn && hasAgreed) {
      if ((inAuthGroup || isWelcome) && !isIndex) {
        router.replace("/tabs/discord");
      }
    }
  }, [isLoggedIn, hasAgreed, initialized, segments]);

  return null;
}

export default function RootLayout() {
  return (
    <>
      <AuthGuard />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: "slide_from_right",
          gestureEnabled: true,
        }}
      >
        <Stack.Screen
          name="tabs"
          options={{ headerShown: false, animation: "none" }}
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
    </>
  );
}
