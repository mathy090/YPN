// src/utils/teamYPNBadge.ts
import AsyncStorage from "@react-native-async-storage/async-storage";

const BADGE_KEY = "team_ypn_unread_count";

type BadgeListener = (count: number) => void;
const listeners: BadgeListener[] = [];

export const addBadgeListener = (listener: BadgeListener) => {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index > -1) listeners.splice(index, 1);
  };
};

const notifyListeners = (count: number) => {
  listeners.forEach((listener) => listener(count));
};

export const incrementUnreadBadge = async () => {
  try {
    const currentCountStr = await AsyncStorage.getItem(BADGE_KEY);
    const currentCount = currentCountStr ? parseInt(currentCountStr, 10) : 0;
    const newCount = currentCount + 1;
    await AsyncStorage.setItem(BADGE_KEY, newCount.toString());
    notifyListeners(newCount);
    console.log(`[Badge] Updated to ${newCount}`);
  } catch (error) {
    console.warn("[Badge] Error incrementing badge:", error);
  }
};

// ALIAS: Fix for "incrementTeamYPNUnreadBadge is not a function" error
export const incrementTeamYPNUnreadBadge = incrementUnreadBadge;

export const clearTeamYPNUnreadBadge = async () => {
  try {
    await AsyncStorage.setItem(BADGE_KEY, "0");
    notifyListeners(0);
  } catch (error) {
    console.warn("[Badge] Error clearing badge:", error);
  }
};

export const getUnreadBadgeCount = async (): Promise<number> => {
  try {
    const countStr = await AsyncStorage.getItem(BADGE_KEY);
    return countStr ? parseInt(countStr, 10) : 0;
  } catch {
    return 0;
  }
};
