"use strict";
const express = require("express");
const {
  searchChannelsByKeyword,
  fetchVideosFromChannel,
} = require("../utils/youtubeAPI");
const { addWatchedVideo, getWatchedVideos } = require("../models/UserVideos");
const router = express.Router();

// Keywords for dynamic categories
const categories = [
  "Motivation Hub",
  "DIY",
  "Youth Empowerment",
  "Mental Health",
  "BBC News Africa",
  "YPN Zimbabwe",
  "Education",
];

// GET /api/videos/foryou
router.get("/foryou", async (req, res) => {
  try {
    const uid = req.headers["x-user-uid"];
    if (!uid) return res.status(401).json({ message: "Missing user UID" });

    const watched = await getWatchedVideos(uid);
    let feed = [];

    // For each category, fetch 2–3 random channels dynamically
    for (const keyword of categories) {
      const channels = await searchChannelsByKeyword(keyword, 3);

      // Fetch 2 latest videos per channel
      for (const ch of channels) {
        const videos = await fetchVideosFromChannel(ch.channelId, 2);
        feed.push(...videos);
      }
    }

    // Exclude already watched videos
    feed = feed.filter((v) => !watched.includes(v.videoId));

    // Shuffle feed
    feed = feed.sort(() => 0.5 - Math.random());

    // Return top 10 videos
    res.json(feed.slice(0, 10));
  } catch (e) {
    console.error("/api/videos/foryou error:", e.message);
    res.status(500).json({ message: e.message });
  }
});

// POST /api/videos/watched
router.post("/watched", async (req, res) => {
  try {
    const uid = req.headers["x-user-uid"];
    const { videoId } = req.body;
    if (!uid || !videoId)
      return res.status(400).json({ message: "Missing uid or videoId" });

    await addWatchedVideo(uid, videoId);
    res.json({ message: "Video saved as watched" });
  } catch (e) {
    console.error("/api/videos/watched error:", e.message);
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
