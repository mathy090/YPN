// backend/src/routes/avatarRoutes.js
"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
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

let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) throw new Error("SUPABASE_URL env var not set");
  if (!supabaseKey)
    throw new Error("SUPABASE_SERVICE_ROLE_KEY env var not set");

  _supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: { apiKey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    },
  });

  return _supabase;
}

function getUid(req) {
  return req.body?.uid || req.query?.uid || req.headers["x-uid"] || null;
}

router.post("/", upload.single("file"), async (req, res) => {
  try {
    const uid = getUid(req);
    if (!uid || typeof uid !== "string" || uid.trim() === "") {
      return res
        .status(400)
        .json({ code: "MISSING_UID", message: "uid is required" });
    }

    let buffer, mimeType;

    if (req.file) {
      console.log("[Avatar] FormData upload detected");
      buffer = req.file.buffer;
      mimeType = req.file.mimetype;
    } else {
      console.log("[Avatar] Raw body upload detected");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      buffer = Buffer.concat(chunks);
      mimeType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    }

    if (!ALLOWED_MIME.includes(mimeType)) {
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: "Only JPEG, PNG or WebP photos are allowed.",
      });
    }

    if (buffer.length > MAX_BYTES) {
      return res
        .status(400)
        .json({ code: "FILE_TOO_LARGE", message: "Photo must be under 5 MB." });
    }

    const ext = mimeType.split("/")[1] ?? "jpg";
    const safeUid = uid.trim().replace(/[^a-zA-Z0-9_-]/g, "");
    const filePath = `${safeUid}/avatar.${ext}`;

    console.log(
      `[Avatar] Upload: uid=${safeUid}, path=${filePath}, size=${buffer.length}`,
    );

    const supabase = getSupabase();

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, buffer, {
        contentType: mimeType,
        upsert: true,
        cacheControl: "3600",
      });

    if (uploadError) {
      console.error("[Avatar] Upload failed:", uploadError);
      if (uploadError.message.includes("Bucket not found")) {
        return res.status(500).json({
          code: "BUCKET_NOT_FOUND",
          message: "Supabase 'avatars' bucket doesn't exist.",
        });
      }
      if (
        uploadError.message.includes("permission") ||
        uploadError.statusCode === 403
      ) {
        return res.status(500).json({
          code: "PERMISSION_DENIED",
          message: "Service role key doesn't have write access.",
        });
      }
      return res
        .status(500)
        .json({ code: "UPLOAD_FAILED", message: uploadError.message });
    }

    console.log(`[Avatar] ✅ Upload successful to Supabase`);

    // ✅ FIXED: Construct public URL manually instead of using getPublicUrl()
    const supabaseUrl = process.env.SUPABASE_URL;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/avatars/${filePath}`;

    console.log(`[Avatar] Public URL: ${publicUrl}`);
    res.status(201).json({ avatarUrl: publicUrl });
  } catch (err) {
    console.error("[Avatar] Error:", err);
    res
      .status(500)
      .json({ code: "SERVER_ERROR", message: "Internal server error" });
  }
});

module.exports = router;
