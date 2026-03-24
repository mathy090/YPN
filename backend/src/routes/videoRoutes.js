// backend/src/routes/videoRoutes.js
"use strict";
const express = require("express");
const {
  searchChannelsByKeyword,
  fetchVideosFromChannel,
  enrichWithStats,
} = require("../utils/youtubeAPI");
const { addWatchedVideo, getWatchedVideos } = require("../models/UserVideos");

const router = express.Router();

// Feed cache — prevents YouTube quota exhaustion.
// YouTube search costs 100 units/call. 7 categories × 2 channels = 1,400 units per build.
// Caching 1 hour limits rebuilds to 24×/day max — safe within 10k free daily quota.
const CACHE_TTL_MS = 60 * 60 * 1000;
let feedCache = null;
let feedCachedAt = 0;

const CATEGORIES = [
  "Motivation youth Africa",
  "DIY skills teens",
  "Youth Empowerment Zimbabwe",
  "Mental Health young people",
  "BBC News Africa",
  "Education Africa youth",
  "Career skills young adults",
];

async function buildFeed() {
  console.log("🎬 Building video feed…");

  const categoryResults = await Promise.allSettled(
    CATEGORIES.map(async (keyword) => {
      const channels = await searchChannelsByKeyword(keyword, 2);
      const videoArrays = await Promise.allSettled(
        channels.map((ch) => fetchVideosFromChannel(ch.channelId, 3)),
      );
      return videoArrays
        .filter((r) => r.status === "fulfilled")
        .flatMap((r) => r.value);
    }),
  );

  let videos = categoryResults
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .filter(Boolean);

  // Deduplicate
  const seen = new Set();
  videos = videos.filter((v) => {
    if (seen.has(v.videoId)) return false;
    seen.add(v.videoId);
    return true;
  });

  // Enrich with real stats — only 1 quota unit per 50 videos (batch call)
  await enrichWithStats(videos);

  videos = videos.sort(() => 0.5 - Math.random());
  console.log(`✅ Feed ready: ${videos.length} videos`);
  return videos;
}

// GET /api/videos/foryou
router.get("/foryou", async (req, res) => {
  try {
    const uid = req.headers["x-user-uid"];
    if (!uid) return res.status(401).json({ message: "Missing user UID" });

    const now = Date.now();
    if (!feedCache || now - feedCachedAt > CACHE_TTL_MS) {
      feedCache = await buildFeed();
      feedCachedAt = now;
    }

    const watched = await getWatchedVideos(uid);
    let feed = feedCache.filter((v) => !watched.includes(v.videoId));
    if (feed.length === 0) feed = feedCache;

    res.json(feed.slice(0, 20));
  } catch (e) {
    console.error("/api/videos/foryou:", e.message);
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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE /api/videos/cache — force rebuild
router.delete("/cache", (_req, res) => {
  feedCache = null;
  feedCachedAt = 0;
  res.json({ message: "Cache cleared." });
});

module.exports = router;
