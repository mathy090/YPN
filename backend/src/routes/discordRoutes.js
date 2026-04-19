// backend/src/routes/discordRoutes.js
"use strict";

const express = require("express");
const multer = require("multer");
const { getChannels, getChannel } = require("../models/DiscordChannels");

const router = express.Router();

// ✅ Configure multer to store in memory (for Supabase upload)
const upload = multer({
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
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
    return res
      .status(503)
      .json({
        message: "Chat service unavailable",
        code: "SUPABASE_UNAVAILABLE",
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
// GET /api/discord/messages/:channelId - PUBLIC
// ────────────────────────────────────────────────────────────────────────────
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
// POST /api/discord/upload-media - PUBLIC (FIXED)
// ────────────────────────────────────────────────────────────────────────────
router.post("/upload-media", upload.single("file"), async (req, res) => {
  const supabase = getSupabase(req);

  if (!supabase) {
    console.error("[Upload] Supabase client not available");
    return res
      .status(503)
      .json({
        message: "Storage service unavailable",
        code: "SUPABASE_UNAVAILABLE",
      });
  }

  if (!req.file) {
    console.error("[Upload] No file in request");
    return res
      .status(400)
      .json({ message: "No file provided", code: "NO_FILE" });
  }

  try {
    console.log("[Upload] File received:", {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      buffer: req.file.buffer ? `${req.file.buffer.length} bytes` : "no buffer",
    });

    const fileName = `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fileExt =
      req.file.originalname.split(".").pop() ||
      req.file.mimetype.split("/")[1] ||
      "bin";
    const fullFileName = `${fileName}.${fileExt}`;

    console.log("[Upload] Uploading to Supabase:", fullFileName);

    const { data, error } = await supabase.storage
      .from("media")
      .upload(fullFileName, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: "3600",
        upsert: false,
      });

    if (error) {
      console.error("[Supabase] Upload error:", error);
      throw error;
    }

    console.log("[Upload] Supabase upload success:", data);

    // ✅ FIXED: Correct destructuring
    const { data: urlData } = supabase.storage
      .from("media")
      .getPublicUrl(fullFileName);

    if (!urlData || !urlData.publicUrl) {
      console.error("[Upload] No public URL returned:", urlData);
      throw new Error("Failed to get public URL");
    }

    const type = req.file.mimetype.startsWith("image")
      ? "image"
      : req.file.mimetype.startsWith("video")
        ? "video"
        : "audio";

    console.log("[Upload] Success:", { url: urlData.publicUrl, type });

    res.json({ url: urlData.publicUrl, type });
  } catch (err) {
    console.error("[Discord] Upload error:", err);
    res.status(500).json({
      message: "Upload failed",
      code: "UPLOAD_FAILED",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

module.exports = router;
