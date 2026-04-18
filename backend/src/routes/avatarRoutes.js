// backend/src/routes/avatarRoutes.js
"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer"); // ✅ Add multer for FormData handling

const router = express.Router();

// Configure multer to store files in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
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
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

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

// ── Helper: Get uid from request ─────────────────────────────────────────────
function getUid(req) {
  return req.body?.uid || req.query?.uid || req.headers["x-uid"] || null;
}

// ── POST /api/avatar ───────────────────────────────────────────────────────────
// Accepts both:
// 1. Raw body: Content-Type: image/jpeg
// 2. FormData: Content-Type: multipart/form-data
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const uid = getUid(req);

    if (!uid || typeof uid !== "string" || uid.trim() === "") {
      return res.status(400).json({
        code: "MISSING_UID",
        message: "uid is required. Send via body, query, or X-Uid header.",
      });
    }

    // ✅ Support both raw body and FormData
    let buffer, mimeType;

    if (req.file) {
      // FormData upload
      console.log("[Avatar] FormData upload detected");
      buffer = req.file.buffer;
      mimeType = req.file.mimetype;
    } else {
      // Raw body upload
      console.log("[Avatar] Raw body upload detected");
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks);
      mimeType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    }

    // Validate MIME type
    if (!ALLOWED_MIME.includes(mimeType)) {
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: "Only JPEG, PNG or WebP photos are allowed.",
      });
    }

    // Validate size
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({
        code: "FILE_TOO_LARGE",
        message: "Photo must be under 5 MB.",
      });
    }

    console.log(
      `[Avatar] Upload params: uid=${uid}, size=${buffer.length}, mime=${mimeType}`,
    );

    const ext = mimeType.split("/")[1] ?? "jpg";
    const safeUid = uid.trim().replace(/[^a-zA-Z0-9_-]/g, "");
    const filePath = `${safeUid}/avatar.${ext}`;

    const supabase = getSupabase();

    // Upload to Supabase Storage
    const { uploadData, error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, buffer, {
        contentType: mimeType,
        upsert: true,
        cacheControl: "3600",
      });

    if (uploadError) {
      console.error("[Avatar] Supabase upload error:", uploadError);
      return res.status(500).json({
        code: "UPLOAD_FAILED",
        message: uploadError.message || "Supabase upload failed",
      });
    }

    console.log(`[Avatar] Upload successful:`, uploadData);

    // Get public URL
    const { publicUrl } = supabase.storage
      .from("avatars")
      .getPublicUrl(filePath);

    if (!publicUrl) {
      console.error("[Avatar] getPublicUrl returned no publicUrl");
      return res.status(500).json({
        code: "URL_GENERATION_FAILED",
        message: "Could not generate public URL for avatar",
      });
    }

    console.log(`[Avatar] Success: uid=${safeUid}, url=${publicUrl}`);
    res.status(201).json({ avatarUrl: publicUrl });
  } catch (err) {
    console.error("[Avatar] Unexpected error:", err);

    if (err.message === "INVALID_TYPE" || err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: "Only JPEG, PNG or WebP photos are allowed.",
      });
    }

    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Sorry, this is on our side. Please try again later.",
    });
  }
});

module.exports = router;
