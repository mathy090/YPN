import { getValidBackendToken } from "./tokenManager";

const API_URL = process.env.EXPO_PUBLIC_API_URL;
let intervalId: any = null;

export const startHeartbeat = () => {
  if (intervalId) clearInterval(intervalId);

  intervalId = setInterval(async () => {
    try {
      const token = await getValidBackendToken(); // Auto-refreshes if needed
      await fetch(`${API_URL}/api/auth/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: "online" }),
      });
    } catch (err) {
      // Silent fail - if token is invalid, heartbeat stops,
      // next API call will trigger redirect to login
      console.warn("Heartbeat failed", err);
    }
  }, 30000); // Every 30 seconds
};

export const stopHeartbeat = () => {
  if (intervalId) clearInterval(intervalId);
};
