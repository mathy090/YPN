// src/utils/profileUpload.ts
import * as ImagePicker from "expo-image-picker";
import { auth } from "../firebase/auth";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const MAX_BYTES = 5 * 1024 * 1024;

// ── Types ─────────────────────────────────────────────────────────────────────

export type UploadErrorCode =
  | "PERMISSION_DENIED"
  | "NO_IMAGE_SELECTED"
  | "FILE_TOO_LARGE"
  | "INVALID_TYPE"
  | "NETWORK_ERROR"
  | "SERVER_ERROR";

export type UploadError = { code: UploadErrorCode; message: string };

export type AvatarResult =
  | { ok: true; avatarUrl: string; localUri: string }
  | { ok: false; error: UploadError };

export type UsernameCheckResult =
  | { ok: true; available: boolean; message: string }
  | { ok: false; code: string; message: string };

// ── pickAndUploadAvatar ───────────────────────────────────────────────────────

export async function pickAndUploadAvatar(): Promise<AvatarResult> {
  // 1. Permission
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== "granted") {
    return {
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "Please allow photo access to set a profile picture.",
      },
    };
  }

  // 2. Pick
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.85,
  });

  if (picked.canceled || !picked.assets?.[0]) {
    return {
      ok: false,
      error: { code: "NO_IMAGE_SELECTED", message: "No photo selected." },
    };
  }

  const asset = picked.assets[0];
  const localUri = asset.uri;
  const mimeType = asset.mimeType ?? guessMime(localUri);
  const allowed = ["image/jpeg", "image/png", "image/webp"];

  // 3. Validate type
  if (!allowed.includes(mimeType)) {
    return {
      ok: false,
      error: {
        code: "INVALID_TYPE",
        message: "Only JPEG, PNG or WebP images are supported.",
      },
    };
  }

  // 4. Validate size (fileSize may be undefined on some devices)
  if (asset.fileSize && asset.fileSize > MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: "FILE_TOO_LARGE",
        message: "Photo must be under 5 MB. Please pick a smaller image.",
      },
    };
  }

  // 5. Read as blob
  let blob: Blob;
  try {
    const r = await fetch(localUri);
    blob = await r.blob();
  } catch {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: "Could not read the photo. Try again.",
      },
    };
  }

  // Double-check size from blob
  if (blob.size > MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: "FILE_TOO_LARGE",
        message: "Photo must be under 5 MB. Please pick a smaller image.",
      },
    };
  }

  // 6. Auth token
  let token: string;
  try {
    const user = auth.currentUser;
    if (!user) throw new Error("no user");
    token = await user.getIdToken();
  } catch {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: "Session error. Please sign in again.",
      },
    };
  }

  // 7. Upload
  let uploadRes: Response;
  try {
    uploadRes = await fetch(`${API_URL}/api/avatar`, {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(blob.size),
        Authorization: `Bearer ${token}`,
      },
      body: blob,
    });
  } catch {
    // fetch threw = truly no network
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: "No connection. Check your internet and try again.",
      },
    };
  }

  const body = await uploadRes.json().catch(() => ({}));

  if (!uploadRes.ok) {
    if (uploadRes.status >= 500) {
      return {
        ok: false,
        error: {
          code: "SERVER_ERROR",
          message: "Sorry, this is on our side. Please try again later.",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "SERVER_ERROR",
        message: body.message ?? "Upload failed. Please try again.",
      },
    };
  }

  return { ok: true, avatarUrl: body.avatarUrl, localUri };
}

// ── checkUsernameAvailability ─────────────────────────────────────────────────

export async function checkUsernameAvailability(
  username: string,
): Promise<UsernameCheckResult> {
  try {
    const res = await fetch(
      `${API_URL}/api/auth/check-username?username=${encodeURIComponent(username)}`,
    );
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        ok: false,
        code: body.code ?? "ERROR",
        message: body.message ?? "Check failed.",
      };
    }

    return { ok: true, available: body.available, message: body.message };
  } catch {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: "No connection. Check your internet and try again.",
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function guessMime(uri: string): string {
  const u = uri.toLowerCase();
  if (u.includes(".png")) return "image/png";
  if (u.includes(".webp")) return "image/webp";
  return "image/jpeg";
}
