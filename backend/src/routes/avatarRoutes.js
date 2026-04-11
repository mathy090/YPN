"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { MongoClient } = require("mongodb");

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

// ── DB Client (lazy singleton) ───────────────────────────────────────────────
// We need this to update the user's profile with the new avatar URL or null
let _db = null;
async function getDB() {
  if (_db) return _db;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  _db = client.db("ypn_users");
  return _db;
}

// ── POST /api/avatar ───────────────────────────────────────────────────────────
// Uploads image to Supabase, then updates MongoDB with the public URL.
router.post("/", async (req, res) => {
  try {
    const { uid } = req.user;
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
    // One file per user — always overwrite
    const filePath = `${uid}/avatar.${ext}`;

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

    // Get permanent public URL
    const { data: urlData } = supabase.storage
      .from("avatars")
      .getPublicUrl(filePath);

    const avatarUrl = urlData.publicUrl;

    // Update MongoDB with the new URL
    const db = await getDB();
    await db
      .collection("users")
      .updateOne({ uid }, { $set: { avatarUrl, updatedAt: new Date() } });

    console.log(`[Avatar] uid=${uid} uploaded: ${avatarUrl}`);
    res.status(201).json({ avatarUrl });
  } catch (err) {
    console.error("[Avatar] upload error:", err.message);
    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Sorry, this is on our side. Please try again later.",
    });
  }
});

// ── DELETE /api/avatar ─────────────────────────────────────────────────────────
// Deletes image from Supabase and clears URL in MongoDB.
router.delete("/", async (req, res) => {
  try {
    const { uid } = req.user;
    const supabase = getSupabase();

    // We don't know the extension, so we try to list files or just attempt deletion of common ones
    // Better approach: Fetch current user profile to get the URL, extract path, then delete.
    // But since we enforce a standard path format `${uid}/avatar.ext`, we can try to delete generically.
    // Supabase doesn't support wildcards in remove easily without listing.
    // Strategy: List files in folder `${uid}/`, find the one starting with `avatar.`, delete it.

    const { data: files, error: listError } = await supabase.storage
      .from("avatars")
      .list(uid, { limit: 10, search: "avatar." });

    if (listError) {
      console.error("[Avatar] List error:", listError.message);
      // Non-fatal, we proceed to clear DB anyway
    }

    if (files && files.length > 0) {
      const filesToDelete = files.map((f) => `${uid}/${f.name}`);
      const { error: removeError } = await supabase.storage
        .from("avatars")
        .remove(filesToDelete);

      if (removeError) {
        console.error("[Avatar] Remove error:", removeError.message);
      }
    }

    // Clear URL in MongoDB regardless of storage success (idempotent)
    const db = await getDB();
    await db
      .collection("users")
      .updateOne(
        { uid },
        { $unset: { avatarUrl: "" }, $set: { updatedAt: new Date() } },
      );

    console.log(`[Avatar] uid=${uid} removed avatar.`);
    res.json({ success: true });
  } catch (err) {
    console.error("[Avatar] delete error:", err.message);
    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Sorry, this is on our side. Please try again later.",
    });
  }
});

module.exports = router;
