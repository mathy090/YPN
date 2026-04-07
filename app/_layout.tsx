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

    // These routes are always accessible
    const isPublic =
      segments[0] === "welcome" ||
      segments[0] === "auth" ||
      segments[0] === undefined;

    if (!isPublic && (!hasAgreed || !isLoggedIn)) {
      router.replace("/welcome");
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
