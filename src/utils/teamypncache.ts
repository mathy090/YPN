// src/utils/teamypncache.ts
import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Types ───────────────────────────────────────────────────────────────
export type TeamYPNMessage = {
  id: string;
  text: string;
  sender: "user" | "ai";
  timestamp: number;
  status: "sending" | "sent" | "read" | "failed";
};

// ── Constants ───────────────────────────────────────────────────────────
const STORAGE_KEY = "TEAM_YPN_MESSAGES_V1";

// ── Initialize (optional placeholder for future encryption) ─────────────
export async function initializeSecureCache() {
  try {
    const existing = await AsyncStorage.getItem(STORAGE_KEY);
    if (!existing) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([]));
    }
  } catch (err) {
    console.log("Cache init error:", err);
  }
}

// ── Save Messages ───────────────────────────────────────────────────────
export async function cacheTeamYPNMessages(
  messages: TeamYPNMessage[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch (err) {
    console.log("Cache save error:", err);
  }
}

// ── Get Messages ────────────────────────────────────────────────────────
export async function getCachedTeamYPNMessages(): Promise<TeamYPNMessage[]> {
  try {
    const data = await AsyncStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch (err) {
    console.log("Cache load error:", err);
    return [];
  }
}

// ── Clear Cache (optional utility) ──────────────────────────────────────
export async function clearTeamYPNCache() {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.log("Cache clear error:", err);
  }
}
