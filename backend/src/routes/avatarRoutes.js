// backend/src/routes/avatarRoutes.js
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
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

// ── Supabase client (lazy singleton) ──────────────────────────────────────────
let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log(
    `[Supabase] Initializing: URL=${url ? "✓" : "✗"}, Key=${key ? "✓" : "✗"}`,
  );

  if (!url) throw new Error("SUPABASE_URL env var not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var not set");

  _supabase = createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { apiKey: key } },
  });

  return _supabase;
}

// ── Helper: Get uid from request ─────────────────────────────────────────────
function getUid(req) {
  return req.body?.uid || req.query?.uid || req.headers["x-uid"] || null;
}

// ── POST /api/avatar ───────────────────────────────────────────────────────────
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const uid = getUid(req);

    if (!uid || typeof uid !== "string" || uid.trim() === "") {
      return res.status(400).json({
        code: "MISSING_UID",
        message: "uid is required. Send via body, query, or X-Uid header.",
      });
    }

    // Support both FormData and raw body
    let buffer, mimeType;

    if (req.file) {
      console.log("[Avatar] FormData upload detected");
      buffer = req.file.buffer;
      mimeType = req.file.mimetype;
    } else {
      console.log("[Avatar] Raw body upload detected");
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks);
      mimeType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    }

    // Validate
    if (!ALLOWED_MIME.includes(mimeType)) {
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: "Only JPEG, PNG or WebP photos are allowed.",
      });
    }

    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({
        code: "FILE_TOO_LARGE",
        message: "Photo must be under 5 MB.",
      });
    }

    const ext = mimeType.split("/")[1] ?? "jpg";
    const safeUid = uid.trim().replace(/[^a-zA-Z0-9_-]/g, "");
    const filePath = `${safeUid}/avatar.${ext}`;

    console.log(
      `[Avatar] Upload params: uid=${safeUid}, path=${filePath}, mime=${mimeType}, size=${buffer.length}`,
    );

    const supabase = getSupabase();

    // 🔥 DEBUG: Test Supabase connection first
    console.log("[Avatar] Testing Supabase connection...");
    const { buckets, error: bucketsError } =
      await supabase.storage.listBuckets();
    if (bucketsError) {
      console.error("[Avatar] Supabase connection failed:", bucketsError);
      return res.status(500).json({
        code: "SUPABASE_CONNECTION_ERROR",
        message: bucketsError.message,
      });
    }
    console.log(
      "[Avatar] Available buckets:",
      buckets?.map((b) => b.name),
    );

    // 🔥 DEBUG: Check if avatars bucket exists and is accessible
    const hasAvatars = buckets?.some((b) => b.name === "avatars");
    if (!hasAvatars) {
      console.error("[Avatar] 'avatars' bucket not found!");
      return res.status(500).json({
        code: "BUCKET_NOT_FOUND",
        message: "Supabase 'avatars' bucket does not exist",
      });
    }

    // ── Upload to Supabase Storage ───────────────────────────────────────────
    console.log(`[Avatar] Attempting upload to path: ${filePath}`);

    const uploadResult = await supabase.storage
      .from("avatars")
      .upload(filePath, buffer, {
        contentType: mimeType,
        upsert: true,
        cacheControl: "3600",
      });

    console.log(
      "[Avatar] Upload result:",
      JSON.stringify(uploadResult, null, 2),
    );

    const { uploadData, error: uploadError } = uploadResult;

    if (uploadError) {
      console.error("[Avatar] Supabase upload error:", {
        message: uploadError.message,
        name: uploadError.name,
        statusCode: uploadError.statusCode,
        error: uploadError,
      });
      return res.status(500).json({
        code: "UPLOAD_FAILED",
        message: uploadError.message || "Supabase upload failed",
        debug: process.env.NODE_ENV === "development" ? uploadError : undefined,
      });
    }

    if (!uploadData) {
      console.error("[Avatar] Upload succeeded but uploadData is undefined!");
      return res.status(500).json({
        code: "UPLOAD_NO_DATA",
        message: "Upload completed but no data returned",
      });
    }

    console.log(`[Avatar] Upload successful:`, uploadData);

    // ── Get public URL ───────────────────────────────────────────────────────
    console.log(`[Avatar] Getting public URL for: ${filePath}`);

    const publicUrlResult = supabase.storage
      .from("avatars")
      .getPublicUrl(filePath);

    console.log(
      "[Avatar] getPublicUrl result:",
      JSON.stringify(publicUrlResult, null, 2),
    );

    const { publicUrl } = publicUrlResult;

    if (!publicUrl) {
      console.error(
        "[Avatar] getPublicUrl returned no publicUrl:",
        publicUrlResult,
      );
      return res.status(500).json({
        code: "URL_GENERATION_FAILED",
        message: "Could not generate public URL for avatar",
        debug:
          process.env.NODE_ENV === "development" ? publicUrlResult : undefined,
      });
    }

    console.log(`[Avatar] ✅ Success: uid=${safeUid}, url=${publicUrl}`);
    res.status(201).json({ avatarUrl: publicUrl });
  } catch (err) {
    console.error("[Avatar] Unexpected error:", {
      message: err.message,
      name: err.name,
      stack: err.stack,
    });

    if (err.message === "INVALID_TYPE") {
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: "Only JPEG, PNG or WebP photos are allowed.",
      });
    }

    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Sorry, this is on our side. Please try again later.",
      debug: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

module.exports = router;
