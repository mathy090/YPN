// app/index.tsx
import NetInfo from "@react-native-community/netinfo";
import { Redirect } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../src/store/authStore";
import {
  initializeSecureCache,
  isSecureCacheInitialized,
} from "../src/utils/cache";

export default function Index() {
  const { hasAgreed, isLoggedIn, isOffline, hydrate, revalidateOnReconnect } =
    useAuth();
  const [ready, setReady] = useState(false);
  const wasOfflineRef = useRef(false);

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

  useEffect(() => {
    if (!ready) return;
    wasOfflineRef.current = isOffline;
    const unsub = NetInfo.addEventListener((state) => {
      const nowOnline =
        (state.isConnected ?? false) && (state.isInternetReachable ?? true);
      if (wasOfflineRef.current && nowOnline && isOffline)
        revalidateOnReconnect();
      wasOfflineRef.current = !nowOnline;
    });
    return () => unsub();
  }, [ready, isOffline]);

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
  return <Redirect href="/splash" />;
}
