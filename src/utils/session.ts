// src/utils/session.ts
import AsyncStorage from "@react-native-async-storage/async-storage";

const SESSION_KEY = "YPN_SESSION_V1";
const AGREED_KEY = "YPN_HAS_AGREED";

export type CachedSession = {
  uid: string;
  email: string | null;
  displayName: string | null;
  savedAt: number;
};

// ── save after every successful login ──
export const saveSession = async (session: CachedSession) => {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
};

// ── load on app start ──
export const loadSession = async (): Promise<CachedSession | null> => {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

// ── clear on logout ──
export const clearSession = async () => {
  await AsyncStorage.removeItem(SESSION_KEY);
};

// ── terms agreement ──
export const saveAgreed = async () => {
  await AsyncStorage.setItem(AGREED_KEY, "1");
};

export const loadAgreed = async (): Promise<boolean> => {
  const v = await AsyncStorage.getItem(AGREED_KEY);
  return v === "1";
};
