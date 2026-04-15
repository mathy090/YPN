// src/hooks/useSessionHeartbeat.ts
import { useEffect } from "react";
import { useAuth } from "../store/authStore";

/**
 * Session Heartbeat Hook - SAFE MODE
 *
 * This hook monitors token expiry but DOES NOT auto-logout.
 * Instead, it marks the session as expired and lets the UI handle re-authentication.
 *
 * Why? To prevent unexpected logouts when:
 * - User is offline temporarily
 * - Backend has a brief outage
 * - Token refresh is delayed
 */
export function useSessionHeartbeat(isAuthenticated: boolean) {
  const { startHeartbeat, stopHeartbeat } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) {
      stopHeartbeat();
      return;
    }

    // Start the heartbeat monitoring
    startHeartbeat();

    // Cleanup on unmount or auth change
    return () => {
      stopHeartbeat();
    };
  }, [isAuthenticated, startHeartbeat, stopHeartbeat]);
}
