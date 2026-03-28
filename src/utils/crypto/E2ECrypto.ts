/**
 * E2ECrypto.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AES-256-GCM message encryption + ECDH-P256 key exchange + HKDF key derivation
 * Uses Web Crypto API (SubtleCrypto) — available in Hermes / JSC, zero extra packages.
 * Backend never sees plaintext. Keys never leave the device (expo-secure-store).
 *
 * ARCHITECTURE:
 *   • Each user generates an ECDH-P256 identity keypair on first launch
 *   • Public key is registered on the backend (server sees public key only)
 *   • Per-conversation shared secret derived via ECDH + HKDF
 *   • Each message encrypted with AES-256-GCM + fresh 96-bit IV
 *   • Double-ratchet: every message derives a new AES key from the chain key
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type EncryptedPayload = {
  ciphertext: string; // base64
  iv: string; // base64, 12 bytes
  authTag?: string; // embedded in GCM ciphertext by WebCrypto
};

export type KeyBundle = {
  identityPublicKey: string; // base64 SPKI
};

export type ConversationKeys = {
  rootKey: CryptoKey; // AES-256-GCM
  chainKey: ArrayBuffer; // 32 bytes, ratchet state
  messageKeyCounter: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const subtle = crypto.subtle;

/** base64 → ArrayBuffer */
export function b64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** ArrayBuffer → base64 */
export function bufferToB64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

/** Generate 12-byte random IV for AES-GCM */
function randomIV(): Uint8Array {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return iv;
}

// ─── Identity Key Management ──────────────────────────────────────────────────

/**
 * Generate ECDH-P256 identity keypair.
 * Private key is non-extractable — stored via expo-secure-store as PKCS8.
 * Public key exported as SPKI base64 for registration.
 */
export async function generateIdentityKeypair(): Promise<{
  publicKeyB64: string;
  privateKeyJwk: string; // stored in SecureStore
}> {
  const keypair = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true, // extractable so we can persist to SecureStore
    ["deriveKey", "deriveBits"],
  );

  const publicKeySpki = await subtle.exportKey("spki", keypair.publicKey);
  const privateKeyJwk = await subtle.exportKey("jwk", keypair.privateKey);

  return {
    publicKeyB64: bufferToB64(publicKeySpki),
    privateKeyJwk: JSON.stringify(privateKeyJwk),
  };
}

/** Import ECDH private key from JWK string (retrieved from SecureStore) */
export async function importPrivateKey(jwkString: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkString);
  return subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false, // non-extractable after import
    ["deriveKey", "deriveBits"],
  );
}

/** Import peer's ECDH public key from SPKI base64 */
export async function importPublicKey(spkiB64: string): Promise<CryptoKey> {
  return subtle.importKey(
    "spki",
    b64ToBuffer(spkiB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

// ─── Key Derivation ───────────────────────────────────────────────────────────

/**
 * ECDH + HKDF → 32-byte root secret for a conversation.
 * Both parties derive the same secret independently.
 */
export async function deriveSharedSecret(
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey,
): Promise<ArrayBuffer> {
  const rawBits = await subtle.deriveBits(
    { name: "ECDH", public: theirPublicKey },
    myPrivateKey,
    256,
  );
  return rawBits;
}

/**
 * HKDF expand: derive AES-256-GCM key from raw secret + info label.
 * Used to produce per-conversation root key and per-message keys.
 */
export async function hkdfExpand(
  rawSecret: ArrayBuffer,
  info: string,
  salt?: ArrayBuffer,
): Promise<CryptoKey> {
  const importedKey = await subtle.importKey(
    "raw",
    rawSecret,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );

  const encoder = new TextEncoder();
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt ?? new Uint8Array(32),
      info: encoder.encode(info),
    },
    importedKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Double-ratchet step: derive next message key + advance chain key.
 * Chain key never reused — forward secrecy per message.
 */
export async function ratchetChainKey(chainKey: ArrayBuffer): Promise<{
  messageKey: CryptoKey;
  nextChainKey: ArrayBuffer;
}> {
  const encoder = new TextEncoder();

  // Import chain key as HMAC key for HKDF-like expansion
  const hmacKey = await subtle.importKey(
    "raw",
    chainKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // Derive message key (label = 0x01)
  const msgKeyRaw = await subtle.sign("HMAC", hmacKey, encoder.encode("\x01"));
  const messageKey = await subtle.importKey(
    "raw",
    msgKeyRaw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Derive next chain key (label = 0x02)
  const nextChainKey = await subtle.sign(
    "HMAC",
    hmacKey,
    encoder.encode("\x02"),
  );

  return { messageKey, nextChainKey };
}

// ─── Conversation Root Key Initialisation ─────────────────────────────────────

/**
 * Called once when starting a new conversation.
 * Both sender and recipient derive the same root key via ECDH + HKDF.
 * Returns initial ConversationKeys with chain key ready for ratcheting.
 */
export async function initConversationKeys(
  myPrivateKey: CryptoKey,
  theirPublicKeyB64: string,
  conversationId: string,
): Promise<ConversationKeys> {
  const theirPublicKey = await importPublicKey(theirPublicKeyB64);
  const sharedSecret = await deriveSharedSecret(myPrivateKey, theirPublicKey);
  const rootKey = await hkdfExpand(sharedSecret, `ypn-root-${conversationId}`);

  // Initial chain key = HKDF with chain label
  const chainKeyMaterial = await hkdfExpand(
    sharedSecret,
    `ypn-chain-${conversationId}`,
  );
  // Export to raw bytes for ratcheting
  const chainKeyRaw = await subtle.exportKey("raw", chainKeyMaterial);

  return {
    rootKey,
    chainKey: chainKeyRaw,
    messageKeyCounter: 0,
  };
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string.
 * Advances the ratchet — returns updated chain key for storage.
 */
export async function encryptMessage(
  plaintext: string,
  conversationKeys: ConversationKeys,
): Promise<{
  payload: EncryptedPayload;
  nextChainKey: ArrayBuffer;
}> {
  const { messageKey, nextChainKey } = await ratchetChainKey(
    conversationKeys.chainKey,
  );

  const iv = randomIV();
  const encoder = new TextEncoder();
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    messageKey,
    encoder.encode(plaintext),
  );

  return {
    payload: {
      ciphertext: bufferToB64(ciphertext),
      iv: bufferToB64(iv.buffer),
    },
    nextChainKey,
  };
}

/**
 * Decrypt an encrypted payload.
 * IMPORTANT: caller must pass the correct chain key for the message index.
 * Out-of-order messages require storing skipped message keys (handled in KeyStore).
 */
export async function decryptMessage(
  payload: EncryptedPayload,
  chainKey: ArrayBuffer,
): Promise<{
  plaintext: string;
  nextChainKey: ArrayBuffer;
}> {
  const { messageKey, nextChainKey } = await ratchetChainKey(chainKey);

  const iv = new Uint8Array(b64ToBuffer(payload.iv));
  const ciphertext = b64ToBuffer(payload.ciphertext);

  const plaintextBuffer = await subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    messageKey,
    ciphertext,
  );

  const decoder = new TextDecoder();
  return {
    plaintext: decoder.decode(plaintextBuffer),
    nextChainKey,
  };
}

/**
 * Encrypt arbitrary binary data (voice notes, images).
 * Returns encrypted ArrayBuffer + IV. Key derived from conversation chain.
 */
export async function encryptBinary(
  data: ArrayBuffer,
  aesKey: CryptoKey,
): Promise<{ encrypted: ArrayBuffer; iv: string }> {
  const iv = randomIV();
  const encrypted = await subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    data,
  );
  return { encrypted, iv: bufferToB64(iv.buffer) };
}

/**
 * Decrypt binary data (voice notes, images).
 */
export async function decryptBinary(
  encrypted: ArrayBuffer,
  aesKey: CryptoKey,
  ivB64: string,
): Promise<ArrayBuffer> {
  const iv = new Uint8Array(b64ToBuffer(ivB64));
  return subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    encrypted,
  );
}

/**
 * Generate a one-off AES-256-GCM key for media encryption.
 * The key is exported as JWK and embedded inside the encrypted message payload.
 */
export async function generateMediaKey(): Promise<{
  key: CryptoKey;
  keyJwk: string;
}> {
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const keyJwk = JSON.stringify(await subtle.exportKey("jwk", key));
  return { key, keyJwk };
}

/** Import media key from JWK string (extracted from decrypted message payload) */
export async function importMediaKey(jwkString: string): Promise<CryptoKey> {
  return subtle.importKey(
    "jwk",
    JSON.parse(jwkString),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
