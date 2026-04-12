// src/utils/db.ts
// ─────────────────────────────────────────────────────────────────────────────
// Compatibility Layer & Unified Exports
// Re-exports all cache helpers to maintain consistent imports across the app.
// Example: import { saveProfile, initializeSecureCache } from '@/utils/db';
// ─────────────────────────────────────────────────────────────────────────────

export {
  CACHE_KEYS, cacheDiscordChannels,
  // Discord & TeamYPN helpers
  cacheDiscordMessages, cacheTeamYPNMessages, clearSecureCache, getCachedDiscordChannels, getCachedDiscordMessages, getCachedTeamYPNMessages, getCachedForYouManifest as getForYouVideos, getCachedProfile as getProfile, initializeSecureCache, cacheForYouManifest as saveForYouVideos, saveProfileToCache as saveProfile,
  updateAvatarInCache as updateAvatarUrl
} from "./cache";

// Export Types
export type {
  CachedMessage, ForYouVideo,
  TeamYPNMessage, UserProfileCache as UserProfile
} from "./cache";

