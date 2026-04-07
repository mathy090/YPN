// app/index.tsx
import NetInfo from "@react-native-community/netinfo";
import { Redirect } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../src/store/authStore";
import {
  getSecureCache,
  initializeSecureCache,
  isSecureCacheInitialized,
  setSecureCache,
} from "../src/utils/cache";
import { authHeaders, clearToken, getToken } from "../src/utils/tokenManager";

// ── Constants ─────────────────────────────────────────────────────────────────
const SESSION_CACHE_KEY = "ypn_session_valid";
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

// ── Authorization check ───────────────────────────────────────────────────────
async function verifyAuthorization(): Promise<boolean> {
  try {
    const headers = await authHeaders();
    if (!headers.Authorization) return false;

    const res = await fetch(`${API_URL}/api/auth/verify`, {
      method: "GET",
      headers,
    });

    if (!res.ok) {
      console.warn("[Auth] Verify failed:", res.status);
      return false;
    }

    const data = await res.json();
    return data.valid === true;
  } catch (e) {
    console.warn("[Auth] Verify error:", e);
    // Backend unreachable — allow access only if cached session exists
    const cached = await getSecureCache(SESSION_CACHE_KEY);
    return cached === true;
  }
}

export default function Index() {
  const { hasAgreed, hydrate, login, logout, revalidateOnReconnect } =
    useAuth();
  const [ready, setReady] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        // Initialize cache
        if (!isSecureCacheInitialized()) {
          await initializeSecureCache();
        }

        // Check for token first
        const token = await getToken();
        if (!token) {
          // No token — not logged in
          await logout();
          setAuthorized(false);
          setReady(true);
          return;
        }

        // Token exists — verify with backend
        const isValid = await verifyAuthorization();

        if (isValid) {
          // Token valid — cache session, hydrate store, allow access
          await setSecureCache(SESSION_CACHE_KEY, true, SESSION_TTL);
          await hydrate();
          await login();
          setAuthorized(true);
        } else {
          // Token invalid — clear token, logout, deny access
          await clearToken();
          await logout();
          setAuthorized(false);
        }
      } catch (e) {
        console.warn("Startup error:", e);
        // On error, check cached session as fallback
        try {
          const cached = await getSecureCache(SESSION_CACHE_KEY);
          if (cached === true) {
            await hydrate();
            setAuthorized(true);
          } else {
            setAuthorized(false);
          }
        } catch {
          setAuthorized(false);
        }
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // Network reconnection handler
  useEffect(() => {
    if (!ready) return;
    wasOfflineRef.current = false;
    const unsub = NetInfo.addEventListener((state) => {
      const nowOnline =
        (state.isConnected ?? false) && (state.isInternetReachable ?? true);
      if (wasOfflineRef.current && nowOnline) {
        revalidateOnReconnect();
      }
      wasOfflineRef.current = !nowOnline;
    });
    return () => unsub();
  }, [ready]);

  // Loading state
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

  // Redirects
  if (!hasAgreed) return <Redirect href="/welcome" />;
  if (!authorized) return <Redirect href="/welcome" />;
  return <Redirect href="/tabs/discord" />;
}
