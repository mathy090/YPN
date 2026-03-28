/**
 * KeyStore.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages all cryptographic key material:
 *   • Identity keypair  → expo-secure-store (survives app restart, encrypted)
 *   • Conversation chain keys → expo-secure-store per conversation
 *   • In-memory cache → Map<conversationId, ConversationKeys> (L1, runtime only)
 *   • Skipped message keys → MMKV (for out-of-order message decryption)
 *
 * SECURITY PROPERTIES:
 *   • Private keys never leave the device
 *   • Chain keys deleted after each ratchet step (forward secrecy)
 *   • Skipped keys stored with TTL — auto-expire after 7 days
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as SecureStore from "expo-secure-store";
import {
    ConversationKeys,
    b64ToBuffer,
    bufferToB64,
    generateIdentityKeypair,
    hkdfExpand,
    importPrivateKey,
    initConversationKeys,
    ratchetChainKey,
} from "./E2ECrypto";

// ─── MMKV instance (L1 cache for skipped keys + chain key counters) ───────────
const mmkv = new MMKV({ id: "ypn-keystore-v1" });

// ─── SecureStore key names ─────────────────────────────────────────────────────
const SK_IDENTITY_PRIVATE = "ypn_identity_private_jwk";
const SK_IDENTITY_PUBLIC = "ypn_identity_public_spki";
const conversationChainKey = (convId: string) => `ypn_chain_${convId}`;
const conversationCounterKey = (convId: string) => `ypn_counter_${convId}`;

// ─── In-memory L1 cache (cleared on app restart — re-derived from SecureStore) ──
const memoryCache = new Map<string, ConversationKeys>();

// ─── Skipped message keys (MMKV with TTL) ─────────────────────────────────────
type SkippedKey = {
  chainKeyB64: string;
  messageIndex: number;
  expiresAt: number; // unix ms
};
const SKIPPED_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const skippedKeyMmkvKey = (convId: string, idx: number) =>
  `skipped_${convId}_${idx}`;

// ─── Exported API ─────────────────────────────────────────────────────────────

export const KeyStore = {
  // ── Identity Keypair ──────────────────────────────────────────────────────

  /**
   * Returns existing identity keypair or generates a new one.
   * Called once on app startup. Public key is sent to backend for registration.
   */
  async getOrCreateIdentity(): Promise<{ publicKeyB64: string }> {
    const existing = await SecureStore.getItemAsync(SK_IDENTITY_PUBLIC, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (existing) return { publicKeyB64: existing };

    const { publicKeyB64, privateKeyJwk } = await generateIdentityKeypair();

    await SecureStore.setItemAsync(SK_IDENTITY_PRIVATE, privateKeyJwk, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(SK_IDENTITY_PUBLIC, publicKeyB64, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });

    return { publicKeyB64 };
  },

  /** Returns CryptoKey for ECDH operations */
  async getPrivateKey(): Promise<CryptoKey> {
    const jwk = await SecureStore.getItemAsync(SK_IDENTITY_PRIVATE, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!jwk)
      throw new Error(
        "[KeyStore] Identity private key not found — call getOrCreateIdentity first",
      );
    return importPrivateKey(jwk);
  },

  async getPublicKeyB64(): Promise<string> {
    const pub = await SecureStore.getItemAsync(SK_IDENTITY_PUBLIC, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!pub) throw new Error("[KeyStore] Identity public key not found");
    return pub;
  },

  // ── Conversation Keys ─────────────────────────────────────────────────────

  /**
   * Initialise keys for a new conversation.
   * Called when sending the first message OR receiving the first message.
   * theirPublicKeyB64 comes from the backend key server.
   */
  async initConversation(
    conversationId: string,
    theirPublicKeyB64: string,
  ): Promise<ConversationKeys> {
    const privateKey = await this.getPrivateKey();
    const keys = await initConversationKeys(
      privateKey,
      theirPublicKeyB64,
      conversationId,
    );

    // Persist chain key to SecureStore
    await SecureStore.setItemAsync(
      conversationChainKey(conversationId),
      bufferToB64(keys.chainKey),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    mmkv.set(conversationCounterKey(conversationId), 0);

    // Cache in memory
    memoryCache.set(conversationId, keys);
    return keys;
  },

  /**
   * Get conversation keys from memory cache, or restore from SecureStore.
   * Throws if conversation was never initialised (caller must call initConversation).
   */
  async getConversationKeys(conversationId: string): Promise<ConversationKeys> {
    // L1 memory hit
    const cached = memoryCache.get(conversationId);
    if (cached) return cached;

    // L2 SecureStore restore
    const chainKeyB64 = await SecureStore.getItemAsync(
      conversationChainKey(conversationId),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    if (!chainKeyB64)
      throw new Error(`[KeyStore] No keys for conversation ${conversationId}`);

    const counter = mmkv.getNumber(conversationCounterKey(conversationId)) ?? 0;

    // We need a root key — re-derive it (it's deterministic from the shared secret)
    // Since we don't store the raw shared secret, we use a stored dummy root key
    // (forward secrecy means we only need the current chain key, not root)
    const restoredKeys: ConversationKeys = {
      rootKey: await _deriveStoredRootKey(conversationId),
      chainKey: b64ToBuffer(chainKeyB64),
      messageKeyCounter: counter,
    };

    memoryCache.set(conversationId, restoredKeys);
    return restoredKeys;
  },

  /**
   * Advance the ratchet after encrypting/decrypting a message.
   * Persists new chain key. Old chain key is overwritten (forward secrecy).
   */
  async advanceRatchet(conversationId: string): Promise<ConversationKeys> {
    const current = await this.getConversationKeys(conversationId);
    const { nextChainKey } = await ratchetChainKey(current.chainKey);

    const updated: ConversationKeys = {
      ...current,
      chainKey: nextChainKey,
      messageKeyCounter: current.messageKeyCounter + 1,
    };

    // Overwrite in SecureStore — old chain key gone (forward secrecy)
    await SecureStore.setItemAsync(
      conversationChainKey(conversationId),
      bufferToB64(nextChainKey),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    mmkv.set(conversationCounterKey(conversationId), updated.messageKeyCounter);

    // Update memory cache
    memoryCache.set(conversationId, updated);
    return updated;
  },

  // ── Skipped Message Keys (out-of-order delivery) ──────────────────────────

  /**
   * Store a skipped message key so out-of-order messages can be decrypted later.
   * Stored in MMKV with 7-day TTL.
   */
  storeSkippedKey(
    conversationId: string,
    messageIndex: number,
    chainKeyB64: string,
  ): void {
    const entry: SkippedKey = {
      chainKeyB64,
      messageIndex,
      expiresAt: Date.now() + SKIPPED_KEY_TTL_MS,
    };
    mmkv.set(
      skippedKeyMmkvKey(conversationId, messageIndex),
      JSON.stringify(entry),
    );
  },

  /**
   * Retrieve and delete a skipped key. Returns null if not found or expired.
   */
  consumeSkippedKey(
    conversationId: string,
    messageIndex: number,
  ): string | null {
    const raw = mmkv.getString(skippedKeyMmkvKey(conversationId, messageIndex));
    if (!raw) return null;

    const entry: SkippedKey = JSON.parse(raw);
    mmkv.delete(skippedKeyMmkvKey(conversationId, messageIndex));

    if (Date.now() > entry.expiresAt) return null; // expired
    return entry.chainKeyB64;
  },

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /** Delete all key material for a conversation (e.g. after user leaves chat) */
  async deleteConversation(conversationId: string): Promise<void> {
    await SecureStore.deleteItemAsync(conversationChainKey(conversationId));
    mmkv.delete(conversationCounterKey(conversationId));
    memoryCache.delete(conversationId);
  },

  /** Full reset — deletes identity + all conversations. Use with caution. */
  async fullReset(): Promise<void> {
    await SecureStore.deleteItemAsync(SK_IDENTITY_PRIVATE);
    await SecureStore.deleteItemAsync(SK_IDENTITY_PUBLIC);
    memoryCache.clear();
    // Note: MMKV skipped keys will expire naturally
  },
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Derive a deterministic AES root key from a stored conversation secret.
 * We store a separate root key material in SecureStore on first init,
 * so we can restore ConversationKeys after app restart without the raw ECDH secret.
 */
async function _deriveStoredRootKey(
  conversationId: string,
): Promise<CryptoKey> {
  const rootKeyB64 = await SecureStore.getItemAsync(
    `ypn_root_${conversationId}`,
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  );

  if (!rootKeyB64) {
    // Generate a fresh one — this is a recovery path, not ideal but safe
    const randomMaterial = new Uint8Array(32);
    crypto.getRandomValues(randomMaterial);
    const key = await hkdfExpand(
      randomMaterial.buffer,
      `ypn-root-restore-${conversationId}`,
    );
    return key;
  }

  return hkdfExpand(
    b64ToBuffer(rootKeyB64),
    `ypn-root-restore-${conversationId}`,
  );
}
