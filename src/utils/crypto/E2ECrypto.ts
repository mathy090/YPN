/**
 * E2ECrypto.ts
 * AES-256-GCM + ECDH-P256 + HKDF — for future private 1:1 chats.
 * Uses Web Crypto API (SubtleCrypto). Lazy-initialized so it never
 * crashes on module load in React Native (RN 0.81+ / Hermes has subtle,
 * but the old `Crypto.webcrypto.subtle` reference does not exist).
 */

export type EncryptedPayload = {
  ciphertext: string;
  iv: string;
};

export type KeyBundle = {
  identityPublicKey: string;
};

export type ConversationKeys = {
  rootKey: CryptoKey;
  chainKey: ArrayBuffer;
  messageKeyCounter: number;
};

// ── Lazy SubtleCrypto accessor ─────────────────────────────────────────────
// Never initialise at module level — React Native may not have crypto.subtle
// ready at import time depending on the JS engine startup order.
function getSubtle(): SubtleCrypto {
  const s = (globalThis as any).crypto?.subtle as SubtleCrypto | undefined;
  if (!s) {
    throw new Error(
      "[E2ECrypto] SubtleCrypto is not available in this environment. " +
        "Requires React Native 0.71+ with Hermes, or a browser runtime.",
    );
  }
  return s;
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function b64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToB64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function randomIV(): Uint8Array {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return iv;
}

// ── Identity Keypair ──────────────────────────────────────────────────────

export async function generateIdentityKeypair(): Promise<{
  publicKeyB64: string;
  privateKeyJwk: string;
}> {
  const keypair = await getSubtle().generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );
  const publicKeySpki = await getSubtle().exportKey("spki", keypair.publicKey);
  const privateKeyJwk = await getSubtle().exportKey("jwk", keypair.privateKey);
  return {
    publicKeyB64: bufferToB64(publicKeySpki),
    privateKeyJwk: JSON.stringify(privateKeyJwk),
  };
}

export async function importPrivateKey(jwkString: string): Promise<CryptoKey> {
  return getSubtle().importKey(
    "jwk",
    JSON.parse(jwkString),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"],
  );
}

export async function importPublicKey(spkiB64: string): Promise<CryptoKey> {
  return getSubtle().importKey(
    "spki",
    b64ToBuffer(spkiB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

// ── Key Derivation ────────────────────────────────────────────────────────

export async function deriveSharedSecret(
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey,
): Promise<ArrayBuffer> {
  return getSubtle().deriveBits(
    { name: "ECDH", public: theirPublicKey },
    myPrivateKey,
    256,
  );
}

export async function hkdfExpand(
  rawSecret: ArrayBuffer,
  info: string,
  salt?: ArrayBuffer,
): Promise<CryptoKey> {
  const importedKey = await getSubtle().importKey(
    "raw",
    rawSecret,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  return getSubtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt ?? new Uint8Array(32),
      info: new TextEncoder().encode(info),
    },
    importedKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function ratchetChainKey(chainKey: ArrayBuffer): Promise<{
  messageKey: CryptoKey;
  nextChainKey: ArrayBuffer;
}> {
  const encoder = new TextEncoder();
  const hmacKey = await getSubtle().importKey(
    "raw",
    chainKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const msgKeyRaw = await getSubtle().sign(
    "HMAC",
    hmacKey,
    encoder.encode("\x01"),
  );
  const messageKey = await getSubtle().importKey(
    "raw",
    msgKeyRaw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const nextChainKey = await getSubtle().sign(
    "HMAC",
    hmacKey,
    encoder.encode("\x02"),
  );
  return { messageKey, nextChainKey };
}

export async function initConversationKeys(
  myPrivateKey: CryptoKey,
  theirPublicKeyB64: string,
  conversationId: string,
): Promise<ConversationKeys> {
  const theirPublicKey = await importPublicKey(theirPublicKeyB64);
  const sharedSecret = await deriveSharedSecret(myPrivateKey, theirPublicKey);
  const rootKey = await hkdfExpand(sharedSecret, `ypn-root-${conversationId}`);
  const chainKeyMaterial = await hkdfExpand(
    sharedSecret,
    `ypn-chain-${conversationId}`,
  );
  const chainKeyRaw = await getSubtle().exportKey("raw", chainKeyMaterial);
  return { rootKey, chainKey: chainKeyRaw, messageKeyCounter: 0 };
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────

export async function encryptMessage(
  plaintext: string,
  conversationKeys: ConversationKeys,
): Promise<{ payload: EncryptedPayload; nextChainKey: ArrayBuffer }> {
  const { messageKey, nextChainKey } = await ratchetChainKey(
    conversationKeys.chainKey,
  );
  const iv = randomIV();
  const ciphertext = await getSubtle().encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    messageKey,
    new TextEncoder().encode(plaintext),
  );
  return {
    payload: {
      ciphertext: bufferToB64(ciphertext),
      iv: bufferToB64(iv.buffer),
    },
    nextChainKey,
  };
}

export async function decryptMessage(
  payload: EncryptedPayload,
  chainKey: ArrayBuffer,
): Promise<{ plaintext: string; nextChainKey: ArrayBuffer }> {
  const { messageKey, nextChainKey } = await ratchetChainKey(chainKey);
  const iv = new Uint8Array(b64ToBuffer(payload.iv));
  const plaintextBuffer = await getSubtle().decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    messageKey,
    b64ToBuffer(payload.ciphertext),
  );
  return {
    plaintext: new TextDecoder().decode(plaintextBuffer),
    nextChainKey,
  };
}

export async function encryptBinary(
  data: ArrayBuffer,
  aesKey: CryptoKey,
): Promise<{ encrypted: ArrayBuffer; iv: string }> {
  const iv = randomIV();
  const encrypted = await getSubtle().encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    data,
  );
  return { encrypted, iv: bufferToB64(iv.buffer) };
}

export async function decryptBinary(
  encrypted: ArrayBuffer,
  aesKey: CryptoKey,
  ivB64: string,
): Promise<ArrayBuffer> {
  const iv = new Uint8Array(b64ToBuffer(ivB64));
  return getSubtle().decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    encrypted,
  );
}

export async function generateMediaKey(): Promise<{
  key: CryptoKey;
  keyJwk: string;
}> {
  const key = await getSubtle().generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const keyJwk = JSON.stringify(await getSubtle().exportKey("jwk", key));
  return { key, keyJwk };
}

export async function importMediaKey(jwkString: string): Promise<CryptoKey> {
  return getSubtle().importKey(
    "jwk",
    JSON.parse(jwkString),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
