// backend/src/routes/discordRoutes.js
"use strict";

const express = require("express");
const multer = require("multer");
const { getChannels, getChannel } = require("../models/DiscordChannels");

const router = express.Router();
const upload = multer({
  limits: { fileSize: 30 * 1024 * 1024 },
  storage: multer.memoryStorage(),
});

// ✅ Safe helper: returns null if Supabase not injected
const getSupabase = (req) => {
  const client = req.app?.get?.("supabase");
  if (!client) {
    console.warn("[Discord] Supabase client not available");
  }
  return client;
};

// ────────────────────────────────────────────────────────────────────────────
// GET /api/discord/channels
// ────────────────────────────────────────────────────────────────────────────
router.get("/channels", async (_req, res) => {
  try {
    const channels = await getChannels();
    res.json(channels);
  } catch (e) {
    console.error("[Discord] GET channels:", e.message);
    res.status(500).json({ message: "Failed to load channels" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/discord/channels/:id
// ────────────────────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────────────────────
// GET /api/discord/profile/:uid - PUBLIC
// ────────────────────────────────────────────────────────────────────────────
router.get("/profile/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid)
      return res
        .status(400)
        .json({ message: "UID required", code: "MISSING_UID" });

    const db = req.app.get("db");
    if (!db) {
      console.error("[Discord] MongoDB not available");
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

    if (!user)
      return res
        .status(404)
        .json({ message: "User not found", code: "USER_NOT_FOUND" });

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

// ────────────────────────────────────────────────────────────────────────────
// POST /api/discord/messages - PUBLIC
// ────────────────────────────────────────────────────────────────────────────
router.post("/messages", async (req, res) => {
  const supabase = getSupabase(req);
  if (!supabase) {
    return res.status(503).json({
      message: "Chat service unavailable",
      code: "SUPABASE_UNAVAILABLE",
      hint: "Check server logs for Supabase setup",
    });
  }

  const { channelId, username, avatarUrl, content, mediaType, mediaUrl } =
    req.body;

  if (!channelId)
    return res
      .status(400)
      .json({ message: "channelId required", code: "MISSING_CHANNEL" });
  if (!content && !mediaUrl)
    return res
      .status(400)
      .json({
        message: "Message must contain text or media",
        code: "EMPTY_MESSAGE",
      });

  const cleanUsername = (username || "Guest").trim().slice(0, 30);
  const senderId = `user_${cleanUsername.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;

  try {
    const { data, error } = await supabase
      .from("messages")
      .insert([
        {
          channel_id: channelId,
          sender_id: senderId,
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

// ────────────────────────────────────────────────────────────────────────────
// GET /api/discord/messages/:channelId - PUBLIC (Incremental sync)
// ────────────────────────────────────────────────────────────────────────────
router.get("/messages/:channelId", async (req, res) => {
  const supabase = getSupabase(req);
  if (!supabase) {
    return res.status(503).json({
      message: "Chat service unavailable",
      code: "SUPABASE_UNAVAILABLE",
    });
  }

  const { channelId } = req.params;
  const { after, before, limit = 50 } = req.query;

  if (!channelId)
    return res
      .status(400)
      .json({ message: "channelId required", code: "MISSING_CHANNEL" });

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

    const { messages, error } = await query;
    if (error) throw error;

    const enriched = (messages || []).map((msg) => ({
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

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/discord/messages/:messageId - PUBLIC
// ────────────────────────────────────────────────────────────────────────────
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
  if (!messageId)
    return res
      .status(400)
      .json({ message: "messageId required", code: "MISSING_ID" });

  try {
    const { error: delErr } = await supabase
      .from("messages")
      .delete()
      .eq("id", messageId);
    if (delErr) throw delErr;
    res.json({ success: true });
  } catch (err) {
    console.error("[Discord] DELETE error:", err);
    res
      .status(500)
      .json({ message: "Failed to delete message", code: "DELETE_FAILED" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/discord/upload-media - PUBLIC
// ────────────────────────────────────────────────────────────────────────────
router.post("/upload-media", upload.single("file"), async (req, res) => {
  const supabase = getSupabase(req);
  if (!supabase) {
    return res
      .status(503)
      .json({
        message: "Chat service unavailable",
        code: "SUPABASE_UNAVAILABLE",
      });
  }

  if (!req.file)
    return res
      .status(400)
      .json({ message: "No file provided", code: "NO_FILE" });

  try {
    const fileName = `${Date.now()}-${req.file.originalname.replace(/\s/g, "_")}`;
    const { data, error } = await supabase.storage
      .from("media")
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

    if (error) throw error;

    const { urlData } = supabase.storage.from("media").getPublicUrl(fileName);
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
