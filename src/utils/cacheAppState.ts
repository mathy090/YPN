// src/utils/cacheAppState.ts
import * as SecureStore from "expo-secure-store";

const LAST_ROUTE_KEY = "ypn_last_route";

export const saveLastRoute = async (routeName: string) => {
  try {
    // Only save if it's not empty
    if (routeName && routeName !== "/") {
      await SecureStore.setItemAsync(LAST_ROUTE_KEY, routeName);
    }
  } catch (e) {
    console.warn("Failed to save last route", e);
  }
};

export const getLastRoute = async (): Promise<string | null> => {
  try {
    return await SecureStore.getItemAsync(LAST_ROUTE_KEY);
  } catch (e) {
    console.warn("Failed to get last route", e);
    return null;
  }
};

export const clearLastRoute = async () => {
  try {
    await SecureStore.deleteItemAsync(LAST_ROUTE_KEY);
  } catch (e) {
    console.warn("Failed to clear last route", e);
  }
};
