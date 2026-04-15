// src/hooks/useSessionHeartbeat.ts
import { useEffect, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import { useAuth } from "../store/authStore";
import { clearAllTokens, getValidBackendToken } from "../utils/tokenManager";

const HEARTBEAT_URL = `${process.env.EXPO_PUBLIC_AI_URL}/heartbeat`;
const INTERVAL_MS = 30000;

export const useSessionHeartbeat = (isAuthenticated: boolean) => {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const { signOut } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;

    const sendHeartbeat = async (
      status: "active" | "background" = "active",
    ) => {
      try {
        const token = await getValidBackendToken();
        await fetch(HEARTBEAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status }),
        });
      } catch {
        // Token failed → trigger logout
        await clearAllTokens();
        signOut();
      }
    };

    // Initial heartbeat
    sendHeartbeat("active");
    intervalRef.current = setInterval(
      () => sendHeartbeat("active"),
      INTERVAL_MS,
    );

    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === "active") {
        sendHeartbeat("active");
        if (!intervalRef.current) {
          intervalRef.current = setInterval(
            () => sendHeartbeat("active"),
            INTERVAL_MS,
          );
        }
      } else {
        sendHeartbeat("background");
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    };

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange,
    );

    return () => {
      subscription.remove();
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isAuthenticated, signOut]);
};
