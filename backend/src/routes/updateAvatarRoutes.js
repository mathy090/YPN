// backend/src/routes/updateAvatarRoutes.js
"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");

const router = express.Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("INVALID_TYPE"), false);
    }
  },
});

const MAX_BYTES = 5 * 1024 * 1024;

// ── Supabase client (lazy singleton) ──────────────────────────────────────────
let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) throw new Error("Supabase credentials not set");

  _supabase = createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { apiKey: key, Authorization: `Bearer ${key}` } },
  });

  return _supabase;
}

// ── POST /api/users/update-avatar ─────────────────────────────────────────────
// 🔓 PUBLIC: No auth required. Updates avatar by email only.
// Accepts: multipart/form-data with 'file' field + 'email' in body/query
// Returns: { success: true, avatarUrl: string } or generic error
router.post("/", upload.single("file"), async (req, res) => {
  try {
    // ✅ Get email from body or query (no UID required)
    const email = (req.body?.email || req.query?.email || "")
      .toString()
      .trim()
      .toLowerCase();

    if (!email || !email.includes("@")) {
      // ✅ Return generic error - no technical details
      return res.status(400).json({
        code: "SERVER_ERROR",
        message: "Something went wrong. Please try again.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        code: "SERVER_ERROR",
        message: "Something went wrong. Please try again.",
      });
    }

    // Validate file size (double-check)
    if (req.file.size > MAX_BYTES) {
      return res.status(400).json({
        code: "SERVER_ERROR",
        message: "Something went wrong. Please try again.",
      });
    }

    const supabase = getSupabase();

    // ✅ Generate unique filename
    const ext = req.file.mimetype.split("/")[1] || "jpg";
    const fileName = `avatar_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
    const filePath = `public/${fileName}`;

    // ✅ Upload to Supabase
    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
        cacheControl: "3600",
      });

    if (uploadError) {
      console.error(
        "[UpdateAvatar] Supabase upload error:",
        uploadError.message,
      );
      return res.status(500).json({
        code: "SERVER_ERROR",
        message: "Something went wrong. Please try again.",
      });
    }

    // ✅ Get public URL
    const { publicUrl } = supabase.storage
      .from("avatars")
      .getPublicUrl(filePath);

    if (!publicUrl) {
      return res.status(500).json({
        code: "SERVER_ERROR",
        message: "Something went wrong. Please try again.",
      });
    }

    // ✅ Update MongoDB profile by email (no UID needed)
    // Access db from app locals (set in server.js middleware)
    const db = req.app.get("db");

    if (!db) {
      console.error("[UpdateAvatar] DB not injected into request");
      return res.status(500).json({
        code: "SERVER_ERROR",
        message: "Something went wrong. Please try again.",
      });
    }

    const result = await db.collection("users").updateOne(
      { email },
      {
        $set: {
          avatarUrl: publicUrl,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      // User not found by email - return generic error
      return res.status(404).json({
        code: "SERVER_ERROR",
        message: "Something went wrong. Please try again.",
      });
    }

    // ✅ Success - return only what's needed
    console.log(`[UpdateAvatar] ✅ Updated avatar for ${email}: ${publicUrl}`);
    res.status(200).json({
      success: true,
      avatarUrl: publicUrl,
    });
  } catch (err) {
    console.error("[UpdateAvatar] Unexpected error:", err.message);
    // ✅ Always return generic error to frontend
    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Something went wrong. Please try again.",
    });
  }
});

module.exports = router;
