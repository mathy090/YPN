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
const getDb = (req) => req.app.get("db");

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

    const db = getDb(req);
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
  const db = getDb(req);

  // ✅ FIX A: Use UID as identity everywhere
  const { channelId, uid, username, avatarUrl, content, mediaType, mediaUrl } =
    req.body;

  if (!channelId || !uid) {
    return res
      .status(400)
      .json({ message: "channelId + uid required", code: "MISSING_FIELDS" });
  }

  if (!content && !mediaUrl) {
    return res.status(400).json({
      message: "Message must contain text or media",
      code: "EMPTY_MESSAGE",
    });
  }

  const cleanUsername = (username || "Guest").trim().slice(0, 30);

  // ✅ FIX A: ALWAYS store sender_id as uid
  const messagePayload = {
    channel_id: channelId,
    sender_id: uid, // 🔥 stable identity
    username: cleanUsername,
    avatar_url: avatarUrl || null,
    content: content || null,
    media_type: mediaType || null,
    media_url: mediaUrl || null,
    created_at: new Date().toISOString(),
  };

  try {
    let insertedData = null;

    // Primary Write: Supabase
    if (supabase) {
      const { data, error } = await supabase
        .from("messages")
        .insert([messagePayload])
        .select()
        .single();

      if (error) {
        console.error("[Supabase] Insert error:", error);
        throw error;
      }
      insertedData = data;
    } else {
      console.warn("Supabase offline → using Mongo only");
    }

    // ✅ FIX C: Fallback Write: MongoDB (for reliability/offline safety)
    if (db) {
      // We insert a copy to Mongo so we have a backup if Supabase goes down completely later
      // Note: We don't wait for this to respond to keep latency low
      db.collection("messages")
        .insertOne(messagePayload)
        .catch((err) => {
          console.error("[Mongo] Fallback insert failed:", err);
        });
    }

    // Return the data (prefer Supabase response as it has the real ID)
    res.status(201).json(insertedData || messagePayload);
  } catch (err) {
    console.error("[Discord] POST message error:", err);

    // If Supabase failed but we have Mongo, we could optionally return success
    // but for now, we report the error to ensure frontend knows it didn't sync to realtime DB
    res
      .status(500)
      .json({ message: "Failed to send message", code: "SEND_FAILED" });
  }
});

// ── GET /api/discord/messages/:channelId ─────────────────────────────────────
router.get("/messages/:channelId", async (req, res) => {
  const supabase = getSupabase(req);

  // ✅ FIX B: NEVER block chat if Supabase fails
  if (!supabase) {
    console.warn("Supabase offline → attempting Mongo fallback for history");
    const db = getDb(req);
    if (!db) {
      return res.status(503).json({
        message: "Chat service unavailable",
        code: "SUPABASE_UNAVAILABLE",
      });
    }

    // Fallback to Mongo if Supabase is down
    try {
      const { channelId } = req.params;
      const { after, before, limit = 50 } = req.query;

      let query = { channel_id: channelId };
      let sort = { created_at: 1 }; // ascending

      if (after) {
        query.created_at = { $gt: after };
      } else if (before) {
        query.created_at = { $lt: before };
        sort = { created_at: -1 }; // descending for "before" pagination
      }

      const msgs = await db
        .collection("messages")
        .find(query)
        .sort(sort)
        .limit(parseInt(limit))
        .toArray();

      // If we fetched "before", we need to reverse to show chronologically
      if (before) msgs.reverse();

      return res.json(msgs);
    } catch (e) {
      return res
        .status(500)
        .json({ message: "Fallback fetch failed", code: "MONGO_ERROR" });
    }
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
    return res.status(503).json({
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

    // Optional: Delete from Mongo fallback too
    const db = getDb(req);
    if (db) {
      db.collection("messages")
        .deleteOne({ id: messageId })
        .catch(() => {});
    }

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
    return res.status(503).json({
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
