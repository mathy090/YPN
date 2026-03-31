// app/_layout.tsx
import { Stack } from "expo-router";

export default function RootLayout() {
  return (
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
        name="discord"
        options={{
          headerShown: false,
          animation: "slide_from_bottom",
          presentation: "fullScreenModal",
        }}
      />
      <Stack.Screen
        name="discordChannel"
        options={{
          headerShown: false,
          animation: "slide_from_right",
        }}
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
  );
}
