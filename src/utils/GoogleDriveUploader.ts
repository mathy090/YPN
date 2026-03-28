// src/utils/GoogleDriveUploader.ts
//
// Client-side helper for E2E-encrypted media over Google Drive.
//
// Upload flow  (device → backend → Drive):
//   1. Generate a fresh AES-256-GCM key for this media item.
//   2. Encrypt the raw bytes in memory → ciphertext.
//   3. POST the ciphertext blob to our backend proxy (/api/media/upload).
//   4. Backend streams the ciphertext to Google Drive, returns fileId.
//   5. Caller stores { driveFileId, mediaIv, mediaKeyJwk } in Firestore
//      (mediaKeyJwk is further encrypted by the channel key before storage).
//
// Download + decrypt flow (Drive → backend → device):
//   1. GET /api/media/:fileId — backend streams ciphertext.
//   2. Decrypt in memory with the AES key recovered from Firestore.
//   3. Build an object URL for playback — plaintext never touches disk.
//
// Ephemeral delete flow:
//   1. After the recipient renders the message, wait EPHEMERAL_TTL_MS.
//   2. DELETE /api/media/:fileId via the backend proxy.
//   3. deleteDoc() the Firestore message doc.
//   4. Remove message from local React state.

import { auth } from "../firebase/auth";

const API_URL = process.env.EXPO_PUBLIC_API_URL;

// ── Types ─────────────────────────────────────────────────────

export type DriveUploadResult = {
  driveFileId: string; // Google Drive file ID — store in Firestore
  mediaIv: string; // base64 AES-GCM IV — store in Firestore
  mediaKeyJwk: string; // JSON-stringified AES key — encrypt with channel key before storing
  mimeType: string;
  durationSeconds?: number;
};

// ── Internal helpers ──────────────────────────────────────────

/** Returns a fresh Bearer token for the currently signed-in Firebase user. */
async function getBearerToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("[DriveUploader] No authenticated user");
  return user.getIdToken();
}

/** Convert a base64 string to Uint8Array (works in Hermes / JSC). */
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Convert ArrayBuffer to base64 string. */
function bufferToB64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

// ── encryptAndUpload ──────────────────────────────────────────
// Encrypts the raw media bytes with AES-256-GCM, then streams the
// ciphertext to the backend proxy which stores it in Google Drive.
//
// Returns DriveUploadResult — the caller must encrypt mediaKeyJwk
// with the channel key before writing it to Firestore.
export async function encryptAndUpload(
  plainData: ArrayBuffer,
  mimeType: string,
  filename?: string,
  durationSeconds?: number,
): Promise<DriveUploadResult> {
  // 1. Generate a per-file AES-256-GCM key (never reused)
  const mediaKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable so we can export the JWK for storage
    ["encrypt", "decrypt"],
  );

  // 2. Encrypt in memory — 96-bit random IV per spec recommendation
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    mediaKey,
    plainData,
  );

  // 3. Export the AES key as JWK (will be further encrypted by channel key)
  const keyJwk = await crypto.subtle.exportKey("jwk", mediaKey);
  const mediaKeyJwk = JSON.stringify(keyJwk);
  const mediaIv = bufferToB64(iv.buffer);

  // 4. Upload the ciphertext blob to backend → Google Drive
  const token = await getBearerToken();
  const name = filename ?? `media_${Date.now()}.enc`;

  const uploadRes = await fetch(`${API_URL}/api/media/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "X-Media-Mime-Type": mimeType,
      "X-Media-Name": name,
    },
    body: ciphertext, // raw encrypted bytes — server never decrypts
  });

  if (!uploadRes.ok) {
    const body = await uploadRes.json().catch(() => ({}));
    throw new Error(
      body.message ?? `Drive upload failed (${uploadRes.status})`,
    );
  }

  const { fileId: driveFileId } = await uploadRes.json();

  return { driveFileId, mediaIv, mediaKeyJwk, mimeType, durationSeconds };
}

// ── downloadAndDecrypt ────────────────────────────────────────
// Downloads the encrypted blob from Google Drive via the backend
// proxy and decrypts it in memory. Returns a plain ArrayBuffer —
// caller turns it into an object URL for playback.
//
// Parameters come straight from the Firestore message doc after the
// channel-key decryption step in decryptFirestoreMessage().
export async function downloadAndDecrypt(
  driveFileId: string,
  mediaIv: string,
  mediaKeyJwk: string, // already decrypted from Firestore by channel key
): Promise<ArrayBuffer> {
  // 1. Import the AES key from the JWK recovered from Firestore
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(mediaKeyJwk),
    { name: "AES-GCM", length: 256 },
    false, // non-extractable after import — forward secrecy at rest
    ["decrypt"],
  );

  // 2. Download the encrypted blob from Drive via our backend proxy
  const token = await getBearerToken();
  const dlRes = await fetch(`${API_URL}/api/media/${driveFileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!dlRes.ok) {
    throw new Error(`Drive download failed (${dlRes.status})`);
  }

  const encryptedBuffer = await dlRes.arrayBuffer();

  // 3. Decrypt in memory — plaintext never written to disk
  const iv = b64ToBytes(mediaIv);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    encryptedBuffer,
  );
}

// ── deleteDriveFile ───────────────────────────────────────────
// Asks the backend proxy to permanently delete the Drive file.
// Called as part of the ephemeral-message cleanup after the
// recipient has seen the message.
// Idempotent — a 404 from the server is treated as success.
export async function deleteDriveFile(driveFileId: string): Promise<void> {
  try {
    const token = await getBearerToken();
    const res = await fetch(`${API_URL}/api/media/${driveFileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    // 404 = already gone (previous deletion succeeded or TTL fired) — fine
    if (!res.ok && res.status !== 404) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? `Drive delete failed (${res.status})`);
    }
  } catch (err) {
    // Non-fatal: Firestore doc will be deleted regardless.
    // Log and move on so the UI ephemeral flow isn't blocked.
    console.warn("[DriveUploader] deleteDriveFile non-fatal error:", err);
  }
}
