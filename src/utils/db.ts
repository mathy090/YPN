// src/utils/db.ts
// ─────────────────────────────────────────────────────────────────────────────
// Compatibility Layer & Unified Exports
// Re-exports Profile helpers from cache.ts to maintain consistent imports
// across the app (e.g., import { saveProfile } from '@/utils/db').
// ─────────────────────────────────────────────────────────────────────────────

export {
  CACHE_KEYS, clearSecureCache, getCachedProfile as getProfile, initializeSecureCache, saveProfileToCache as saveProfile, updateAvatarInCache as updateAvatarUrl
} from "./cache";

// Export types
export type { UserProfileCache as UserProfile } from "./cache";
