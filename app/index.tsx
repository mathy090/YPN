// app/index.tsx
//
// COLD START GATE
//
// Renders a spinner until hydrate() finishes (initialized=true).
// No auth logic here — authStore.hydrate() owns all decisions.
//
// ROUTING AFTER GATE:
//   !hasAgreed              → /welcome   (first launch or post-logout)
//   !isLoggedIn             → /auth/otp  (logged out but agreed before)
//   isLoggedIn              → /tabs/discord
//
// The gate prevents the brief flash where expo-router would render
// /tabs/discord (the default route) before auth state is known.

import NetInfo from "@react-native-community/netinfo";
import { Redirect } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useAuth } from "../src/store/authStore";
import {
  initializeSecureCache,
  isSecureCacheInitialized,
} from "../src/utils/cache";

export default function Index() {
  const {
    hasAgreed,
    isLoggedIn,
    isOffline,
    initialized,
    hydrate,
    revalidateOnReconnect,
  } = useAuth();

  // ready = cache init + hydrate() both done
  const [ready, setReady] = useState(false);
  const wasOfflineRef = useRef(false);

  // ── Cold start: init SQLite cache then hydrate auth ─────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!isSecureCacheInitialized()) {
          await initializeSecureCache();
        }
        await hydrate();
      } catch (e) {
        console.warn("[index] cold start error:", e);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Network watcher: re-verify when coming back online ──────────────────
  // Only attaches after boot is done to avoid race with hydrate().
  useEffect(() => {
    if (!ready) return;

    wasOfflineRef.current = isOffline;

    const unsub = NetInfo.addEventListener((state) => {
      const nowOnline =
        (state.isConnected ?? false) && (state.isInternetReachable ?? true);

      if (wasOfflineRef.current && nowOnline) {
        revalidateOnReconnect();
      }
      wasOfflineRef.current = !nowOnline;
    });

    return () => unsub();
  }, [ready, isOffline]);

  // ── Gate: block ALL routing until hydrate() finishes ────────────────────
  // Without this, expo-router renders /tabs/discord for ~300ms on
  // every cold start before the redirect fires — visible flicker.
  if (!ready || !initialized) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator size="large" color="#1DB954" />
      </View>
    );
  }

  // ── Route ────────────────────────────────────────────────────────────────
  if (!hasAgreed) return <Redirect href="/welcome" />;
  if (!isLoggedIn) return <Redirect href="/auth/otp" />;
  return <Redirect href="/tabs/discord" />;
}

const styles = StyleSheet.create({
  loader: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
});
