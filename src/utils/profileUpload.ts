// src/utils/profileUpload.ts
import * as ImagePicker from "expo-image-picker";
import { getAuth } from "firebase/auth";
import { Platform } from "react-native";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const MAX_BYTES = 5 * 1024 * 1024;

export type UploadErrorCode =
  | "PERMISSION_DENIED"
  | "NO_IMAGE_SELECTED"
  | "FILE_TOO_LARGE"
  | "INVALID_TYPE"
  | "NETWORK_ERROR"
  | "SERVER_ERROR"
  | "AUTH_ERROR";
export type UploadError = { code: UploadErrorCode; message: string };
export type AvatarResult =
  | { ok: true; avatarUrl: string; localUri: string; mimeType: string }
  | { ok: false; error: UploadError };
export type UsernameCheckResult =
  | { ok: true; available: boolean; message: string }
  | { ok: false; code: string; message: string };

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
  "image/x-ms-bmp",
  "image/*",
]);

function guessMime(uri: string): string {
  const u = uri.toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".gif")) return "image/gif";
  if (u.endsWith(".heic") || u.endsWith(".heif")) return "image/heic";
  if (u.endsWith(".bmp")) return "image/bmp";
  if (u.endsWith(".tiff") || u.endsWith(".tif")) return "image/tiff";
  return "image/jpeg";
}

function isValidImageType(mimeType: string | null | undefined): boolean {
  if (!mimeType) return true;
  const normalized = mimeType.toLowerCase().trim();
  if (ALLOWED_MIME_TYPES.has(normalized)) return true;
  if (normalized === "image/*") return true;
  if (normalized.includes("heic") || normalized.includes("heif")) return true;
  if (normalized.includes("bmp") || normalized.includes("tiff")) return true;
  return normalized.startsWith("image/");
}

export async function pickAndUploadAvatar(): Promise<AvatarResult> {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== "granted")
    return {
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "Please allow photo access to set a profile picture.",
      },
    };

  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.85,
    ...(Platform.OS === "ios" && {
      presentationStyle: ImagePicker.UIImagePickerPresentationStyle.AUTOMATIC,
    }),
  });
  if (picked.canceled || !picked.assets?.[0])
    return {
      ok: false,
      error: { code: "NO_IMAGE_SELECTED", message: "No photo selected." },
    };

  const asset = picked.assets[0];
  const localUri = asset.uri;
  const detectedMime = asset.mimeType ?? guessMime(localUri);
  const mimeType = detectedMime.toLowerCase();

  if (!isValidImageType(mimeType))
    return {
      ok: false,
      error: {
        code: "INVALID_TYPE",
        message: Platform.select({
          ios: "Unsupported image format. Please use JPEG, PNG, HEIC, or WebP.",
          android:
            "Unsupported image format. Please use JPEG, PNG, WebP, or BMP.",
          default: "Unsupported image format. Please try a different photo.",
        }),
      },
    };
  if (asset.fileSize && asset.fileSize > MAX_BYTES)
    return {
      ok: false,
      error: {
        code: "FILE_TOO_LARGE",
        message: "Photo must be under 5 MB. Please pick a smaller image.",
      },
    };

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
  if (blob.size > MAX_BYTES)
    return {
      ok: false,
      error: {
        code: "FILE_TOO_LARGE",
        message: "Photo must be under 5 MB. Please pick a smaller image.",
      },
    };

  // 🔥 Avatar upload is PUBLIC - token optional for backend logging
  const headers: Record<string, string> = {
    "Content-Type": mimeType,
    "Content-Length": String(blob.size),
  };
  try {
    const token = await getAuth().currentUser?.getIdToken(true);
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch (err) {
    console.warn(
      "[profileUpload] Could not get auth token (non-blocking):",
      err,
    );
  }

  let uploadRes: Response;
  try {
    uploadRes = await fetch(`${API_URL}/api/avatar`, {
      method: "POST",
      headers,
      body: blob,
    });
  } catch (err: any) {
    if (
      err?.message?.includes("Network request failed") ||
      err?.message?.includes("Failed to fetch") ||
      err?.type === "NetworkError"
    )
      return {
        ok: false,
        error: {
          code: "NETWORK_ERROR",
          message: "No connection. Check your internet and try again.",
        },
      };
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: "Upload failed. Please check your connection.",
      },
    };
  }

  const body = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) {
    if (uploadRes.status >= 500)
      return {
        ok: false,
        error: {
          code: "SERVER_ERROR",
          message: "Sorry, this is on our side. Please try again later.",
        },
      };
    if (body.code === "INVALID_FILE")
      return {
        ok: false,
        error: {
          code: "INVALID_TYPE",
          message: body.message || "This image format is not supported.",
        },
      };
    return {
      ok: false,
      error: {
        code: "SERVER_ERROR",
        message: body.message ?? "Upload failed. Please try again.",
      },
    };
  }
  if (!body.avatarUrl)
    return {
      ok: false,
      error: {
        code: "SERVER_ERROR",
        message: "Upload succeeded but no URL returned. Please try again.",
      },
    };

  return { ok: true, avatarUrl: body.avatarUrl, localUri, mimeType };
}

export async function checkUsernameAvailability(
  username: string,
): Promise<UsernameCheckResult> {
  try {
    // 🔥 Get Firebase ID token for auth-protected endpoint
    let token: string | null = null;
    try {
      const auth = getAuth();
      const user = auth.currentUser;
      if (user) token = await user.getIdToken(true);
    } catch (err) {
      console.warn(
        "[profileUpload] Could not get token for username check:",
        err,
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(
      `${API_URL}/api/auth/check-username?username=${encodeURIComponent(username)}`,
      { headers },
    );
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401)
        return {
          ok: false,
          code: "AUTH_ERROR",
          message: "Session expired. Please sign in again.",
        };
      return {
        ok: false,
        code: body.code ?? "ERROR",
        message: body.message ?? "Check failed.",
      };
    }
    return {
      ok: true,
      available: body.available,
      message: body.message || (body.available ? "Available" : "Taken"),
    };
  } catch (err: any) {
    console.error("[profileUpload] Username check error:", err);
    if (
      err?.message?.includes("Network request failed") ||
      err?.message?.includes("Failed to fetch") ||
      err?.type === "NetworkError"
    )
      return {
        ok: false,
        code: "NETWORK_ERROR",
        message: "No connection. Check your internet and try again.",
      };
    return {
      ok: false,
      code: "ERROR",
      message: "Check failed. Please try again.",
    };
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
