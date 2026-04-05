// src/utils/cache.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";

const CACHE_PREFIX = "YPN_SECURE_CACHE:";
const DEVICE_ID_KEY = "YPN_DEVICE_ID";
const INITIALIZATION_FLAG = "YPN_CACHE_INITIALIZED";
const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

let deviceId: string | null = null;

/**
 * Generates a unique identifier for this specific app installation on this device.
 * This ID will persist through app updates but likely change if the app is uninstalled and reinstalled.
 * @returns A unique device/installation ID.
 */
const generateDeviceId = async (): Promise<string> => {
  return Crypto.randomUUID();
};

/**
 * Initializes the caching system by retrieving or creating the device ID.
 * This should ideally be called once when the app starts.
 */
export const initializeSecureCache = async (): Promise<void> => {
  if (deviceId) {
    console.log("Secure cache already initialized.");
    return;
  }

  try {
    const isInitialized = await AsyncStorage.getItem(INITIALIZATION_FLAG);

    if (isInitialized) {
      const storedDeviceId = await AsyncStorage.getItem(DEVICE_ID_KEY);
      if (storedDeviceId) {
        deviceId = storedDeviceId;
        console.log("Secure cache initialized with existing device ID.");
      } else {
        console.warn(
          "Initialization flag found, but device ID missing. Reinitializing...",
        );
        await _performInitialization();
      }
    } else {
      await _performInitialization();
    }
  } catch (error) {
    console.error("Error initializing secure cache:", error);
    await _performInitialization();
  }
};

/**
 * Helper function to perform the core initialization logic.
 */
const _performInitialization = async (): Promise<void> => {
  try {
    deviceId = await generateDeviceId();
    await AsyncStorage.setItem(DEVICE_ID_KEY, deviceId);
    await AsyncStorage.setItem(INITIALIZATION_FLAG, "true");
    console.log("Secure cache initialized with new device ID:", deviceId);
  } catch (error) {
    console.error("Critical error during cache initialization:", error);
    deviceId = null;
    throw error;
  }
};

/**
 * Prepares a cache key by combining the prefix, the device ID, and the user-provided key.
 * This ensures data is keyed specifically to this device installation.
 * @param key The user-provided cache key.
 * @returns The combined, device-specific cache key.
 */
const prepareKey = (key: string): string => {
  if (!deviceId) {
    throw new Error(
      "Secure cache not initialized. Call initializeSecureCache first.",
    );
  }
  return `${CACHE_PREFIX}${deviceId}:${key}`;
};

/**
 * Stores data in the cache with a device-specific key and optional TTL.
 * @param key The user-friendly key for the data.
 * @param data The data to store (must be serializable by JSON.stringify).
 * @param ttl Time to live in milliseconds (defaults to 24 hours).
 * @returns A promise that resolves when the data is stored.
 */
export const setSecureCache = async (
  key: string,
  data: any,
  ttl: number = DEFAULT_TTL,
): Promise<void> => {
  try {
    const fullKey = prepareKey(key);
    const item = {
      data,
      timestamp: Date.now(),
      ttl,
      deviceId,
    };
    await AsyncStorage.setItem(fullKey, JSON.stringify(item));
    console.log(`Cached data for key: ${fullKey}, TTL: ${ttl}ms`);
  } catch (error) {
    console.error(`Error setting cache for key '${key}':`, error);
    throw error;
  }
};

/**
 * Retrieves data from the cache.
 * Checks if the data exists, belongs to the current device, and hasn't expired.
 * @param key The user-friendly key for the data.
 * @returns The cached data if valid and not expired, otherwise null.
 */
export const getSecureCache = async (key: string) => {
  if (!deviceId) {
    console.error("Secure cache not initialized. Cannot retrieve data.");
    return null;
  }

  try {
    const fullKey = prepareKey(key);
    const cachedItemStr = await AsyncStorage.getItem(fullKey);

    if (!cachedItemStr) {
      console.log(
        `Cache miss for key: ${fullKey} (Not found or belongs to different device/installation)`,
      );
      return null;
    }

    const cachedItem = JSON.parse(cachedItemStr);

    if (cachedItem.deviceId !== deviceId) {
      console.log(
        `Cache miss for key: ${fullKey} (Data belongs to a different device/installation)`,
      );
      return null;
    }

    const now = Date.now();

    if (now - cachedItem.timestamp > cachedItem.ttl) {
      console.log(`Cache miss for key: ${fullKey} (Expired)`);
      await removeSecureCache(key);
      return null;
    }

    console.log(`Retrieved cached data for key: ${fullKey}`);
    return cachedItem.data;
  } catch (error) {
    console.error(`Error getting cache for key '${key}':`, error);
    return null;
  }
};

/**
 * Removes a specific item from the cache.
 * @param key The user-friendly key for the data.
 * @returns A promise that resolves when the data is removed.
 */
export const removeSecureCache = async (key: string): Promise<void> => {
  try {
    const fullKey = prepareKey(key);
    await AsyncStorage.removeItem(fullKey);
    console.log(`Removed cache for key: ${fullKey}`);
  } catch (error) {
    console.error(`Error removing cache for key '${key}':`, error);
    throw error;
  }
};

/**
 * Clears the entire cache for the current device.
 * This removes *all* items stored under the CACHE_PREFIX for the current deviceId.
 * @returns A promise that resolves when the cache is cleared.
 */
export const clearSecureCache = async (): Promise<void> => {
  try {
    if (!deviceId) {
      console.error("Secure cache not initialized. Cannot clear.");
      return;
    }
    const keys = await AsyncStorage.getAllKeys();
    const cacheKeys = keys.filter((k) =>
      k.startsWith(`${CACHE_PREFIX}${deviceId}:`),
    );
    if (cacheKeys.length > 0) {
      await AsyncStorage.multiRemove(cacheKeys);
      console.log(
        `Cleared ${cacheKeys.length} cached items for current device.`,
      );
    } else {
      console.log("No cached items found for current device to clear.");
    }
  } catch (error) {
    console.error("Error clearing secure cache:", error);
    throw error;
  }
};

/**
 * Checks if the cache system is initialized.
 * @returns True if initialized, false otherwise.
 */
export const isSecureCacheInitialized = (): boolean => {
  return deviceId !== null;
};
