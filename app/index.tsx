// app/index.tsx
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../src/store/authStore";
import {
  initializeSecureCache,
  isSecureCacheInitialized,
} from "../src/utils/cache";

export default function Index() {
  const { hasAgreed, isLoggedIn, hydrate } = useAuth();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        if (!isSecureCacheInitialized()) await initializeSecureCache();
        await hydrate();
      } catch (e) {
        console.warn("Startup error:", e);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: "#000",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <ActivityIndicator size="large" color="#1DB954" />
      </View>
    );
  }

  if (!hasAgreed) return <Redirect href="/welcome" />;
  if (!isLoggedIn) return <Redirect href="/auth/otp" />;
  return <Redirect href="/tabs/chats" />;
}
