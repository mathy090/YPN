// app/_layout.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Root Stack navigator.
// Discord and Chat screens are pushed as full Stack routes — the bottom tab
// navigator never renders over them. Each screen manages its own safe area.
// ─────────────────────────────────────────────────────────────────────────────

import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
        // Prevent the system gesture from revealing the tab bar behind
        gestureEnabled: true,
      }}
    >
      {/* Tab shell — the bottom nav lives only inside this route */}
      <Stack.Screen
        name="tabs"
        options={{
          headerShown: false,
          animation: "none",
        }}
      />

      {/* ── Full-screen routes — tab bar never renders ── */}

      {/* Discord community — pushed from community tab */}
      <Stack.Screen
        name="discord"
        options={{
          headerShown: false,
          animation: "slide_from_bottom",
          // Full screen — no tab bar, no header
          presentation: "fullScreenModal",
        }}
      />

      {/* TeamYPN AI chat + future 1:1 chats */}
      <Stack.Screen
        name="chat"
        options={{
          headerShown: false,
          animation: "slide_from_right",
        }}
      />

      {/* Auth flow */}
      <Stack.Screen
        name="welcome"
        options={{ headerShown: false, animation: "fade" }}
      />
      <Stack.Screen name="auth" options={{ headerShown: false }} />
    </Stack>
  );
}
