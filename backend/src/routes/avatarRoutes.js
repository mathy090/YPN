// src/routes/avatarRoutes.js
"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { MongoClient } = require("mongodb");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const MAX_BYTES = 5 * 1024 * 1024;
// ✅ FIX: Allow ALL common image formats
const ALLOWED_MIME = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif",
];

// Map MIME types to file extensions
const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
};

// ── 🔥 Rate Limiter for Avatar Uploads ───────────────────────────────────────
const avatarUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: {
    code: "RATE_LIMITED",
    message: "Too many avatar uploads. Please wait a few minutes.",
  },
  keyGenerator: (req) =>
    req.user?.sub || req.user?.uid || req.ip || "anonymous",
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Supabase client (lazy singleton) ──────────────────────────────────────────
let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("SUPABASE_URL env var not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var not set");

  _supabase = createClient(url, key, {
    auth: { persistSession: false },
  });

  return _supabase;
}

// ── DB Client (lazy singleton) ───────────────────────────────────────────────
let _db = null;
async function getDB() {
  if (_db) return _db;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  _db = client.db("ypn_users");
  return _db;
}

// ── POST /api/avatar ───────────────────────────────────────────────────────────
router.post("/", avatarUploadLimiter, async (req, res) => {
  try {
    const uid = req.user?.sub || req.user?.uid || req.user?.id;

    console.log("[/api/avatar] Request received:", {
      hasUser: !!req.user,
      userSub: req.user?.sub,
      userEmail: req.user?.email,
      extractedUid: uid,
      contentType: req.headers["content-type"],
      contentLength: req.headers["content-length"],
    });

    if (!uid) {
      console.error("[/api/avatar] ❌ Could not extract uid from JWT");
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "Invalid authentication token - missing user identifier",
      });
    }

    console.log(`[/api/avatar] Processing upload for uid=${uid}`);

    const mimeType = (req.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);

    // ✅ FIX: Allow all common image formats
    if (!ALLOWED_MIME.includes(mimeType)) {
      console.warn("[/api/avatar] Unsupported MIME type:", mimeType);
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: `Unsupported image format: ${mimeType}. Allowed: ${ALLOWED_MIME.join(", ")}`,
      });
    }

    if (contentLength > MAX_BYTES) {
      return res.status(400).json({
        code: "FILE_TOO_LARGE",
        message: "Photo must be under 5 MB.",
      });
    }

    // Read raw body into a Buffer
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({
        code: "FILE_TOO_LARGE",
        message: "Photo must be under 5 MB.",
      });
    }

    // ✅ FIX: Use correct extension from MIME type (not hardcoded)
    const ext = MIME_TO_EXT[mimeType] || "jpg";
    const filePath = `${uid}/avatar.${ext}`;

    console.log(
      `[/api/avatar] Uploading to Supabase: ${filePath} (MIME: ${mimeType})`,
    );

    const supabase = getSupabase();

    // ✅ FIX: Pass correct contentType to Supabase so it serves correct headers
    const uploadResult = await supabase.storage
      .from("avatars")
      .upload(filePath, buffer, {
        contentType: mimeType, // ✅ Critical: Ensures correct Content-Type header
        upsert: true,
        cacheControl: "3600",
      });

    console.log("[/api/avatar] Upload result:", {
      hasData: !!uploadResult.data,
      path: uploadResult.data?.path,
      hasError: !!uploadResult.error,
      errorMessage: uploadResult.error?.message,
    });

    if (uploadResult.error) {
      console.error("[/api/avatar] Supabase upload error:", {
        message: uploadResult.error.message,
        name: uploadResult.error.name,
        statusCode: uploadResult.error.statusCode,
      });
      return res.status(500).json({
        code: "SERVER_ERROR",
        message: "Sorry, this is on our side. Please try again later.",
      });
    }

    if (!uploadResult.data?.path) {
      console.error("[/api/avatar] ❌ Upload succeeded but no path returned");
      return res.status(500).json({
        code: "SERVER_ERROR",
        message: "Upload completed but path not returned",
      });
    }

    console.log(
      `[/api/avatar] Supabase upload success: path=${uploadResult.data.path}`,
    );

    // ✅ FIX: getPublicUrl returns { data: { publicUrl } }
    const urlResult = supabase.storage.from("avatars").getPublicUrl(filePath);

    console.log("[/api/avatar] getPublicUrl result:", {
      hasData: !!urlResult.data,
      publicUrl: urlResult.data?.publicUrl,
    });

    if (!urlResult.data?.publicUrl) {
      console.error("[/api/avatar] ❌ getPublicUrl returned no publicUrl", {
        urlResult,
      });
      return res.status(500).json({
        code: "SERVER_ERROR",
        message: "Failed to generate avatar URL",
      });
    }

    const avatarUrl = urlResult.data.publicUrl;
    console.log(`[/api/avatar] Generated public URL: ${avatarUrl}`);

    // Update MongoDB with the new URL
    const db = await getDB();
    const updateResult = await db
      .collection("users")
      .updateOne({ uid }, { $set: { avatarUrl, updatedAt: new Date() } });

    console.log(`[/api/avatar] MongoDB update result:`, {
      matchedCount: updateResult.matchedCount,
      modifiedCount: updateResult.modifiedCount,
      uid,
      avatarUrl,
    });

    if (updateResult.matchedCount === 0) {
      console.warn(
        `[/api/avatar] No user found with uid=${uid} to update avatar`,
      );
    }

    console.log(`[/api/avatar] ✅ Avatar uploaded successfully for uid=${uid}`);
    res.status(201).json({ avatarUrl, uid });
  } catch (err) {
    console.error("[/api/avatar] Upload error:", {
      message: err.message,
      name: err.name,
      stack: err.stack,
    });
    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Sorry, this is on our side. Please try again later.",
    });
  }
});

// ── DELETE /api/avatar ─────────────────────────────────────────────────────────
router.delete("/", avatarUploadLimiter, async (req, res) => {
  try {
    const uid = req.user?.sub || req.user?.uid || req.user?.id;

    if (!uid) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "Invalid authentication token - missing user identifier",
      });
    }

    console.log(`[/api/avatar DELETE] Removing avatar for uid=${uid}`);

    const supabase = getSupabase();

    const listResult = await supabase.storage
      .from("avatars")
      .list(uid, { limit: 10, search: "avatar." });

    if (listResult.error) {
      console.warn(
        "[/api/avatar DELETE] List error (non-fatal):",
        listResult.error.message,
      );
    }

    if (listResult.data && listResult.data.length > 0) {
      const filesToDelete = listResult.data.map((f) => `${uid}/${f.name}`);
      console.log(`[/api/avatar DELETE] Deleting files:`, filesToDelete);

      const removeResult = await supabase.storage
        .from("avatars")
        .remove(filesToDelete);

      if (removeResult.error) {
        console.error(
          "[/api/avatar DELETE] Remove error:",
          removeResult.error.message,
        );
      } else {
        console.log(`[/api/avatar DELETE] ✅ Files deleted from Supabase`);
      }
    }

    const db = await getDB();
    await db
      .collection("users")
      .updateOne(
        { uid },
        { $unset: { avatarUrl: "" }, $set: { updatedAt: new Date() } },
      );

    console.log(
      `[/api/avatar DELETE] ✅ MongoDB avatarUrl cleared for uid=${uid}`,
    );
    res.json({ success: true, uid });
  } catch (err) {
    console.error("[/api/avatar DELETE] Error:", err.message);
    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Sorry, this is on our side. Please try again later.",
    });
  }
});

module.exports = router;
