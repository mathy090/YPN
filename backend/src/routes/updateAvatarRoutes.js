// backend/src/routes/updateAvatarRoutes.js
//
// POST /api/users/update-avatar
//
// 🔓 Public route — no auth token required.
// Used exclusively by the Settings screen to replace a user's avatar.
//
// Flow:
//   1. Client sends multipart/form-data with fields:
//        file  — the image file
//        email — the user's email (used to find the MongoDB document)
//   2. We upload the new image to Supabase Storage, overwriting the old one
//      (same path pattern so the old object is automatically replaced).
//   3. We update the `avatarUrl` field in the MongoDB `users` collection.
//   4. We return { success: true, avatarUrl } so the client can update its
//      local state and SQLite cache immediately without a round-trip GET.
//
// The client must NOT use /api/avatar (onboarding route) for updates because
// that route is keyed by uid which is not always available without a token.
// This route is keyed by email, which is always stored in the local cache.
"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");

const router = express.Router();

// ── Multer — in-memory, 5 MB cap, images only ─────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("INVALID_TYPE"), false);
    }
  },
});

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

// ── Supabase lazy singleton ───────────────────────────────────────────────
let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("SUPABASE_URL env var not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var not set");

  _supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: { apiKey: key, Authorization: `Bearer ${key}` },
    },
  });

  return _supabase;
}

// ── POST /api/users/update-avatar ─────────────────────────────────────────
router.post("/", upload.single("file"), async (req, res) => {
  try {
    // ── 1. Validate email ───────────────────────────────────────────────
    const email = (req.body?.email ?? req.query?.email ?? "")
      .toString()
      .trim()
      .toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        code: "MISSING_EMAIL",
        message: "Something went wrong. Please try again.",
      });
    }

    // ── 2. Resolve image buffer ─────────────────────────────────────────
    let buffer;
    let mimeType;

    if (req.file) {
      // FormData path (standard React Native FormData upload)
      buffer = req.file.buffer;
      mimeType = req.file.mimetype;
    } else {
      // Raw body fallback (Content-Type: image/*)
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      buffer = Buffer.concat(chunks);
      mimeType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    }

    // ── 3. Validate type and size ───────────────────────────────────────
    if (!ALLOWED_MIME.includes(mimeType)) {
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: "Something went wrong. Please try again.",
      });
    }

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({
        code: "EMPTY_FILE",
        message: "Something went wrong. Please try again.",
      });
    }

    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({
        code: "FILE_TOO_LARGE",
        message: "Something went wrong. Please try again.",
      });
    }

    // ── 4. Upload to Supabase Storage ───────────────────────────────────
    // We use a stable path based on a sanitised email so uploading a new
    // photo always overwrites the old one (upsert: true) — no orphaned files.
    const supabase = getSupabase();
    const ext = mimeType.split("/")[1] ?? "jpg";
    const safeEmail = email.replace(/[^a-z0-9._-]/g, "_");
    const filePath = `avatars_by_email/${safeEmail}/avatar.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, buffer, {
        contentType: mimeType,
        upsert: true, // overwrite existing — no duplicates
        cacheControl: "3600",
      });

    if (uploadError) {
      console.error(
        "[UpdateAvatar] Supabase upload error:",
        uploadError.message,
      );
      return res.status(500).json({
        code: "UPLOAD_FAILED",
        message: "Something went wrong. Please try again.",
      });
    }

    // ── 5. Build the public URL ─────────────────────────────────────────
    // Construct manually — getPublicUrl() can sometimes return an incorrect
    // URL depending on Supabase JS SDK version.
    const supabaseUrl = process.env.SUPABASE_URL;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/avatars/${filePath}`;

    // ── 6. Update MongoDB ───────────────────────────────────────────────
    // req.app.get("db") is injected by the middleware in server.js.
    const db = req.app.get("db");

    if (!db) {
      console.error("[UpdateAvatar] db not injected into request");
      return res.status(500).json({
        code: "SERVER_ERROR",
        message: "Something went wrong. Please try again.",
      });
    }

    const result = await db.collection("users").findOneAndUpdate(
      { email },
      {
        $set: {
          avatarUrl: publicUrl,
          updatedAt: new Date(),
        },
      },
      {
        returnDocument: "after",
        projection: { _id: 0, uid: 1, email: 1, username: 1, avatarUrl: 1 },
      },
    );

    // findOneAndUpdate returns null value when no document matched
    if (!result?.value) {
      console.warn(`[UpdateAvatar] No user found for email=${email}`);
      return res.status(404).json({
        code: "USER_NOT_FOUND",
        message: "Something went wrong. Please try again.",
      });
    }

    console.log(
      `[UpdateAvatar] ✅ Avatar updated for email=${email} → ${publicUrl}`,
    );

    // ── 7. Return the confirmed URL so the client can update its cache ──
    // We return the full user object so settings.tsx can refresh all fields
    // in one shot without a separate GET /api/users/profile call.
    return res.status(200).json({
      success: true,
      avatarUrl: publicUrl,
      user: result.value,
    });
  } catch (err) {
    console.error("[UpdateAvatar] Unexpected error:", err.message);
    return res.status(500).json({
      code: "SERVER_ERROR",
      message: "Something went wrong. Please try again.",
    });
  }
});

module.exports = router;
