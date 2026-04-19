// src/utils/auth.ts
import * as SecureStore from "expo-secure-store";

const USER_EMAIL_KEY = "user_email";

export async function getUserEmail(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(USER_EMAIL_KEY);
  } catch (e) {
    console.warn("[auth] getEmail failed:", e);
    return null;
  }
}

export async function setUserEmail(email: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(USER_EMAIL_KEY, email);
  } catch (e) {
    console.warn("[auth] setEmail failed:", e);
  }
}

export async function clearUserEmail(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(USER_EMAIL_KEY);
  } catch (e) {
    console.warn("[auth] clearEmail failed:", e);
  }
}
