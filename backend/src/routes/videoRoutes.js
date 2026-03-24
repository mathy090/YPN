// backend/src/routes/videoRoutes.js
"use strict";
const express = require("express");
const { getVideosForFeed } = require("../utils/youtubeAPI");
const { addWatchedVideo, getWatchedVideos } = require("../models/UserVideos");

const router = express.Router();

router.get("/foryou", async (req, res) => {
  try {
    const uid = req.headers["x-user-uid"];
    if (!uid)
      return res.status(401).json({ message: "Missing x-user-uid header" });

    const [allVideos, watched] = await Promise.all([
      getVideosForFeed(),
      getWatchedVideos(uid).catch(() => []),
    ]);

    const watchedSet = new Set(watched);
    const unseen = allVideos.filter((v) => !watchedSet.has(v.videoId));
    const feed = (unseen.length > 5 ? unseen : allVideos)
      .sort(() => 0.5 - Math.random())
      .slice(0, 50);

    res.json(feed);
  } catch (err) {
    console.error("[/api/videos/foryou]", err.message);
    if (err.message?.includes("quota")) {
      return res.status(503).json({
        message:
          "Video feed temporarily unavailable (API quota). Try again later.",
        code: "QUOTA_EXCEEDED",
      });
    }
    res.status(500).json({ message: err.message || "Internal server error" });
  }
});

router.post("/watched", async (req, res) => {
  try {
    const uid = req.headers["x-user-uid"];
    const { videoId } = req.body;
    if (!uid || !videoId)
      return res.status(400).json({ message: "Missing uid or videoId" });
    await addWatchedVideo(uid, videoId);
    res.json({ success: true });
  } catch (err) {
    console.error("[/api/videos/watched]", err.message);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
