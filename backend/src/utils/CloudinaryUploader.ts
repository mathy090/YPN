// src/utils/CloudinaryUploader.ts
// Encrypts media in memory, then uploads the ciphertext blob directly to
// Cloudinary via a signed URL obtained from our backend.
// The server and Cloudinary only ever see encrypted bytes.

import { auth } from "../firebase/auth";
import { encryptBinary, generateMediaKey } from "./crypto/E2ECrypto";

const API_URL = process.env.EXPO_PUBLIC_API_URL;

export type CloudinaryUploadResult = {
  cloudinaryUrl: string; // public_id URL — store in Firestore
  mediaIv: string; // base64 IV — store in Firestore
  mediaKeyJwk: string; // base64 AES key — encrypt with channel key before storing
  durationSeconds?: number;
  mimeType: string;
};

type ResourceType = "raw" | "video" | "image";

// Fetch a signed upload URL from our backend (server never sees the bytes)
async function getSignedUploadParams(
  resourceType: ResourceType = "raw",
): Promise<{
  signature: string;
  timestamp: number;
  cloudName: string;
  apiKey: string;
  folder: string;
  uploadUrl: string;
}> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");

  const token = await user.getIdToken();
  const res = await fetch(`${API_URL}/api/media/sign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ resourceType }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? "Failed to get upload signature");
  }
  return res.json();
}

// Main export: encrypts ArrayBuffer, uploads to Cloudinary, returns metadata
export async function encryptAndUpload(
  plainData: ArrayBuffer,
  mimeType: string,
  durationSeconds?: number,
): Promise<CloudinaryUploadResult> {
  // 1. Generate a fresh AES-256-GCM key for this media item
  const { key: mediaKey, keyJwk: mediaKeyJwk } = await generateMediaKey();

  // 2. Encrypt the plaintext bytes in memory — Cloudinary gets ciphertext only
  const { encrypted, iv: mediaIv } = await encryptBinary(plainData, mediaKey);

  // 3. Determine Cloudinary resource type
  const resourceType: ResourceType = mimeType.startsWith("video/")
    ? "video"
    : mimeType.startsWith("image/")
      ? "image"
      : "raw";

  // 4. Get signed upload params from our backend
  const { signature, timestamp, cloudName, apiKey, folder, uploadUrl } =
    await getSignedUploadParams(resourceType);

  // 5. Build multipart form — blob name doesn't matter, content is opaque ciphertext
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([encrypted], { type: "application/octet-stream" }),
  );
  formData.append("api_key", apiKey);
  formData.append("timestamp", String(timestamp));
  formData.append("signature", signature);
  formData.append("folder", folder);

  // 6. Upload directly to Cloudinary (device → Cloudinary, backend not involved)
  const uploadRes = await fetch(uploadUrl, { method: "POST", body: formData });
  if (!uploadRes.ok) {
    const body = await uploadRes.json().catch(() => ({}));
    throw new Error(body.error?.message ?? "Cloudinary upload failed");
  }
  const data = await uploadRes.json();

  return {
    cloudinaryUrl: data.secure_url,
    mediaIv,
    mediaKeyJwk,
    durationSeconds,
    mimeType,
  };
}

// Download encrypted blob from Cloudinary and decrypt in memory
export async function downloadAndDecrypt(
  cloudinaryUrl: string,
  mediaIv: string,
  mediaKeyJwk: string,
): Promise<ArrayBuffer> {
  // 1. Import the AES key from JWK
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(mediaKeyJwk),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // 2. Download the encrypted blob
  const res = await fetch(cloudinaryUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const encryptedBuffer = await res.arrayBuffer();

  // 3. Decrypt in memory — plaintext never touches disk or network
  const iv = new Uint8Array(
    atob(mediaIv)
      .split("")
      .map((c) => c.charCodeAt(0)),
  );

  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    encryptedBuffer,
  );
}
