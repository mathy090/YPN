// src/routes/avatarRoutes.js
"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { MongoClient } = require("mongodb");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

// ── 🔥 Rate Limiter for Avatar Uploads ───────────────────────────────────────
const avatarUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: {
    code: "RATE_LIMITED",
    message: "Too many avatar uploads. Please try again later.",
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

    const mimeType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);

    if (!ALLOWED_MIME.includes(mimeType)) {
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: "Only JPEG, PNG or WebP photos are allowed.",
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

    const ext = mimeType.split("/")[1] ?? "jpg";
    const filePath = `${uid}/avatar.${ext}`;

    console.log(`[/api/avatar] Uploading to Supabase: ${filePath}`);

    const supabase = getSupabase();

    // ✅ FIX 1: Correct destructuring for upload() - returns { data, error }
    const { uploadData, error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, buffer, {
        contentType: mimeType,
        upsert: true,
        cacheControl: "3600",
      });

    if (uploadError) {
      console.error("[/api/avatar] Supabase upload error:", {
        message: uploadError.message,
        name: uploadError.name,
        statusCode: uploadError.statusCode,
      });
      return res.status(500).json({
        code: "SERVER_ERROR",
        message: "Sorry, this is on our side. Please try again later.",
      });
    }

    console.log(`[/api/avatar] Supabase upload success:`, {
      path: uploadData?.path,
      fullPath: uploadData?.fullPath,
    });

    // ✅ FIX 2: Correct destructuring for getPublicUrl() - returns {  publicUrl } DIRECTLY
    const { publicUrl } = supabase.storage
      .from("avatars")
      .getPublicUrl(filePath);

    if (!publicUrl) {
      console.error("[/api/avatar] ❌ getPublicUrl returned no publicUrl");
      return res.status(500).json({
        code: "SERVER_ERROR",
        message: "Failed to generate avatar URL",
      });
    }

    const avatarUrl = publicUrl;
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

    const { files, error: listError } = await supabase.storage
      .from("avatars")
      .list(uid, { limit: 10, search: "avatar." });

    if (listError) {
      console.warn(
        "[/api/avatar DELETE] List error (non-fatal):",
        listError.message,
      );
    }

    if (files && files.length > 0) {
      const filesToDelete = files.map((f) => `${uid}/${f.name}`);
      console.log(`[/api/avatar DELETE] Deleting files:`, filesToDelete);

      const { error: removeError } = await supabase.storage
        .from("avatars")
        .remove(filesToDelete);

      if (removeError) {
        console.error(
          "[/api/avatar DELETE] Remove error:",
          removeError.message,
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
