// backend/src/routes/avatarRoutes.js
"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

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

// ── Helper: Get uid from request (no verification) ───────────────────────────
function getUid(req) {
  return req.body?.uid || req.query?.uid || req.headers["x-uid"] || null;
}

// ── POST /api/avatar ───────────────────────────────────────────────────────────
// 🔓 FULLY OPEN: No authentication, no token checks
// Accepts uid via: body, query string, or X-Uid header
// Returns: { avatarUrl: string }
router.post("/", async (req, res) => {
  try {
    const uid = getUid(req);

    if (!uid || typeof uid !== "string" || uid.trim() === "") {
      return res.status(400).json({
        code: "MISSING_UID",
        message: "uid is required. Send via body, query, or X-Uid header.",
      });
    }

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

    // Read raw body into Buffer
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
    const safeUid = uid.trim().replace(/[^a-zA-Z0-9_-]/g, ""); // Basic sanitization
    const filePath = `${safeUid}/avatar.${ext}`;

    const supabase = getSupabase();

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, buffer, {
        contentType: mimeType,
        upsert: true,
        cacheControl: "3600",
      });

    if (uploadError) {
      console.error("[Avatar] Supabase upload error:", uploadError.message);
      return res.status(500).json({
        code: "SERVER_ERROR",
        message: "Sorry, this is on our side. Please try again later.",
      });
    }

    // Get public URL
    const { urlData } = supabase.storage.from("avatars").getPublicUrl(filePath);

    const avatarUrl = urlData.publicUrl;
    console.log(`[Avatar] uid=${safeUid} uploaded: ${avatarUrl}`);

    res.status(201).json({ avatarUrl });
  } catch (err) {
    console.error("[Avatar] upload error:", err.message);
    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Sorry, this is on our side. Please try again later.",
    });
  }
});

module.exports = router;
