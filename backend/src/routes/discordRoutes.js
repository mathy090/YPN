// backend/src/routes/discordRoutes.js
"use strict";

const express = require("express");
const { getChannels, getChannel } = require("../models/DiscordChannels");
const multer = require("multer"); // For handling multipart/form-data if uploading directly to backend first
const upload = multer({ limits: { fileSize: 30 * 1024 * 1024 } }); // 30MB Limit

const router = express.Router();

// Helper to get Supabase client from request
const getSupabase = (req) => req.app.get("supabase");

// GET /api/discord/channels (Existing)
router.get("/channels", async (_req, res) => {
  try {
    const channels = await getChannels();
    res.json(channels);
  } catch (e) {
    console.error("[Discord] GET channels:", e.message);
    res.status(500).json({ message: e.message });
  }
});

// ✅ NEW: POST /api/discord/messages (Unprotected - Simple Hook)
// Body: { channelId, senderUid, content, mediaType?, mediaUrl? }
router.post("/messages", async (req, res) => {
  const supabase = getSupabase(req);
  const { channelId, senderUid, content, mediaType, mediaUrl } = req.body;

  if (!channelId || !senderUid) {
    return res.status(400).json({ message: "channelId and senderUid are required" });
  }

  try {
    // 1. Fetch Username from MongoDB (since profiles are there)
    const db = req.app.get("db");
    const user = await db.collection("users").findOne(
      { uid: senderUid }, 
      { projection: { username: 1, avatarUrl: 1 } }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 2. Insert into Supabase Messages Table
    // Note: We store the MongoDB UID as sender_id. 
    // In a pure Supabase app, this would be auth.uid(), but here we mix them.
    const { data, error } = await supabase
      .from('messages')
      .insert([
        {
          channel_id: channelId,
          sender_id: senderUid, // Storing Firebase/Mongo UID
          content: content || null,
          media_type: mediaType || null,
          media_url: mediaUrl || null,
          created_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) throw error;

    // 3. Return message with embedded user info for immediate frontend display
    res.status(201).json({
      ...data,
      profiles: {
        username: user.username,
        avatar_url: user.avatarUrl
      }
    });

  } catch (err) {
    console.error("[Discord] POST message error:", err);
    res.status(500).json({ message: "Failed to send message", error: err.message });
  }
});

// ✅ NEW: GET /api/discord/messages/:channelId
router.get("/messages/:channelId", async (req, res) => {
  const supabase = getSupabase(req);
  const { channelId } = req.params;
  const { limit = 50 } = req.query;

  try {
    // 1. Fetch Messages from Supabase
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    // 2. Enrich with Usernames from MongoDB
    const db = req.app.get("db");
    const uniqueUids = [...new Set(messages.map(m => m.sender_id))];
    
    const users = await db.collection("users")
      .find({ uid: { $in: uniqueUids } })
      .project({ uid: 1, username: 1, avatarUrl: 1 })
      .toArray();

    const userMap = {};
    users.forEach(u => {
      userMap[u.uid] = { username: u.username, avatar_url: u.avatarUrl };
    });

    // 3. Combine Data
    const enrichedMessages = messages.map(msg => ({
      ...msg,
      profiles: userMap[msg.sender_id] || { username: "Unknown", avatar_url: null }
    })).reverse(); // Reverse back to ascending order for chat display

    res.json(enrichedMessages);

  } catch (err) {
    console.error("[Discord] GET messages error:", err);
    res.status(500).json({ message: "Failed to fetch messages" });
  }
});

// ✅ NEW: POST /api/discord/upload-media (Optional Helper)
// If you want the backend to handle the file and push to Supabase Storage
router.post("/upload-media", upload.single('file'), async (req, res) => {
  const supabase = getSupabase(req);
  
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }

  try {
    const file = req.file;
    const fileName = `${Date.now()}-${file.originalname}`;
    
    // Upload to Supabase Storage bucket 'media'
    const { data, error } = await supabase.storage
      .from('media')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (error) throw error;

    // Get Public URL
    const { data: urlData } = supabase.storage.from('media').getPublicUrl(fileName);

    res.json({
      url: urlData.publicUrl,
      type: file.mimetype.startsWith('image') ? 'image' : 
            file.mimetype.startsWith('video') ? 'video' : 'audio'
    });

  } catch (err) {
    console.error("[Discord] Upload error:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

module.exports = router;