// backend/src/routes/discordRoutes.js
"use strict";

const express = require("express");
const multer = require("multer");
const { getChannels, getChannel } = require("../models/DiscordChannels");

const router = express.Router();

const upload = multer({
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype.startsWith("image/") ||
      file.mimetype.startsWith("video/") ||
      file.mimetype.startsWith("audio/")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"), false);
    }
  },
});

const getSupabase = (req) => req.app.get("supabase");

// ── GET /api/discord/channels ────────────────────────────────────────────────
router.get("/channels", async (_req, res) => {
  try {
    const channels = await getChannels();
    res.json(channels);
  } catch (e) {
    console.error("[Discord] GET channels:", e.message);
    res.status(500).json({ message: "Failed to load channels" });
  }
});

// ── GET /api/discord/channels/:id ────────────────────────────────────────────
router.get("/channels/:id", async (req, res) => {
  try {
    const channel = await getChannel(req.params.id);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    res.json(channel);
  } catch (e) {
    console.error("[Discord] GET channel:", e.message);
    res.status(500).json({ message: "Failed to load channel" });
  }
});

// ── GET /api/discord/profile/:uid ────────────────────────────────────────────
router.get("/profile/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) {
      return res
        .status(400)
        .json({ message: "UID required", code: "MISSING_UID" });
    }

    const db = req.app.get("db");
    if (!db) {
      return res
        .status(500)
        .json({ message: "Database unavailable", code: "DB_ERROR" });
    }

    const user = await db
      .collection("users")
      .findOne(
        { uid },
        { projection: { _id: 0, uid: 1, username: 1, avatarUrl: 1 } },
      );

    if (!user) {
      return res
        .status(404)
        .json({ message: "User not found", code: "USER_NOT_FOUND" });
    }

    res.json({
      uid: user.uid,
      username: user.username || "Guest",
      avatarUrl: user.avatarUrl || null,
    });
  } catch (err) {
    console.error("[Discord] GET profile error:", err);
    res
      .status(500)
      .json({ message: "Failed to fetch profile", code: "FETCH_FAILED" });
  }
});

// ── POST /api/discord/messages ───────────────────────────────────────────────
router.post("/messages", async (req, res) => {
  const supabase = getSupabase(req);
  if (!supabase) {
    return res
      .status(503)
      .json({
        message: "Chat service unavailable",
        code: "SUPABASE_UNAVAILABLE",
      });
  }

  const { channelId, username, avatarUrl, content, mediaType, mediaUrl } =
    req.body;

  if (!channelId) {
    return res
      .status(400)
      .json({ message: "channelId required", code: "MISSING_CHANNEL" });
  }
  if (!content && !mediaUrl) {
    return res
      .status(400)
      .json({
        message: "Message must contain text or media",
        code: "EMPTY_MESSAGE",
      });
  }

  const cleanUsername = (username || "Guest").trim().slice(0, 30);
  // Use username as sender_id so isMe checks work reliably on the frontend
  const senderId = cleanUsername.toLowerCase().replace(/[^a-z0-9_]/g, "_");

  try {
    const { data, error } = await supabase
      .from("messages")
      .insert([
        {
          channel_id: channelId,
          sender_id: senderId,
          username: cleanUsername, // ✅ Store username in DB
          content: content || null,
          media_type: mediaType || null,
          media_url: mediaUrl || null,
          avatar_url: avatarUrl || null,
          created_at: new Date().toISOString(),
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("[Supabase] Insert error:", error);
      throw error;
    }

    res.status(201).json({ ...data, username: cleanUsername });
  } catch (err) {
    console.error("[Discord] POST message error:", err);
    res
      .status(500)
      .json({ message: "Failed to send message", code: "SEND_FAILED" });
  }
});

// ── GET /api/discord/messages/:channelId ─────────────────────────────────────
// ✅ FIX: Was destructuring { messages, error } — Supabase returns { data, error }
router.get("/messages/:channelId", async (req, res) => {
  const supabase = getSupabase(req);
  if (!supabase) {
    return res
      .status(503)
      .json({
        message: "Chat service unavailable",
        code: "SUPABASE_UNAVAILABLE",
      });
  }

  const { channelId } = req.params;
  const { after, before, limit = 50 } = req.query;

  if (!channelId) {
    return res
      .status(400)
      .json({ message: "channelId required", code: "MISSING_CHANNEL" });
  }

  try {
    let query = supabase
      .from("messages")
      .select("*")
      .eq("channel_id", channelId)
      .limit(parseInt(limit));

    if (after) {
      query = query
        .gt("created_at", after)
        .order("created_at", { ascending: true });
    } else if (before) {
      query = query
        .lt("created_at", before)
        .order("created_at", { ascending: false });
    } else {
      query = query.order("created_at", { ascending: true });
    }

    // ✅ FIXED: was { messages, error } — Supabase always returns { data, error }
    const { data, error } = await query;

    if (error) throw error;

    // Normalize username field for frontend display
    const enriched = (data || []).map((msg) => ({
      ...msg,
      username:
        msg.username ||
        msg.sender_id?.replace(/^user_/, "").replace(/_/g, " ") ||
        "Guest",
    }));

    res.json(enriched);
  } catch (err) {
    console.error("[Discord] GET messages error:", err);
    res
      .status(500)
      .json({ message: "Failed to fetch messages", code: "FETCH_FAILED" });
  }
});

// ── DELETE /api/discord/messages/:messageId ───────────────────────────────────
router.delete("/messages/:messageId", async (req, res) => {
  const supabase = getSupabase(req);
  if (!supabase) {
    return res
      .status(503)
      .json({
        message: "Chat service unavailable",
        code: "SUPABASE_UNAVAILABLE",
      });
  }

  const { messageId } = req.params;
  if (!messageId) {
    return res
      .status(400)
      .json({ message: "messageId required", code: "MISSING_ID" });
  }

  try {
    const { error } = await supabase
      .from("messages")
      .delete()
      .eq("id", messageId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("[Discord] DELETE error:", err);
    res
      .status(500)
      .json({ message: "Failed to delete message", code: "DELETE_FAILED" });
  }
});

// ── POST /api/discord/upload-media ────────────────────────────────────────────
router.post("/upload-media", upload.single("file"), async (req, res) => {
  const supabase = getSupabase(req);
  if (!supabase) {
    return res
      .status(503)
      .json({
        message: "Storage service unavailable",
        code: "SUPABASE_UNAVAILABLE",
      });
  }
  if (!req.file) {
    return res
      .status(400)
      .json({ message: "No file provided", code: "NO_FILE" });
  }

  try {
    const fileName = `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fileExt =
      req.file.originalname.split(".").pop() ||
      req.file.mimetype.split("/")[1] ||
      "bin";
    const fullFileName = `${fileName}.${fileExt}`;

    const { data, error } = await supabase.storage
      .from("media")
      .upload(fullFileName, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: "3600",
        upsert: false,
      });

    if (error) throw error;

    const { data: urlData } = supabase.storage
      .from("media")
      .getPublicUrl(fullFileName);
    if (!urlData?.publicUrl) throw new Error("Failed to get public URL");

    const type = req.file.mimetype.startsWith("image")
      ? "image"
      : req.file.mimetype.startsWith("video")
        ? "video"
        : "audio";

    res.json({ url: urlData.publicUrl, type });
  } catch (err) {
    console.error("[Discord] Upload error:", err);
    res.status(500).json({ message: "Upload failed", code: "UPLOAD_FAILED" });
  }
});

module.exports = router;
