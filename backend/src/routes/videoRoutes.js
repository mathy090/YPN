// backend/src/routes/videoRoutes.js
"use strict";
const express = require("express");
const {
  searchChannelsByKeyword,
  fetchVideosFromChannel,
  enrichWithStats,
} = require("../utils/youtubeAPI");
const { addWatchedVideo, getWatchedVideos } = require("../models/UserVideos");
const {
  saveFeedCache,
  loadFeedCache,
  clearFeedCache,
} = require("../models/VideoCache");

const router = express.Router();

// ── Two-layer cache ───────────────────────────────────────────────────────────
// L1 in-memory  : zero latency, lost on restart / Render cold start
// L2 MongoDB    : ~5ms latency, survives restarts, auto-expires (TTL index)
//
// Request → L1 hit → serve immediately
//         → L1 miss, L2 hit → hydrate L1, serve
//         → both miss → call YouTube API, write L2 + L1, serve

let l1Cache = null;
let l1CachedAt = 0;
const L1_TTL = 60 * 60 * 1000; // 1 hour

// Build lock so concurrent cold-start requests don't fire multiple API builds
let building = false;
const buildQueue = [];

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
  if (building) {
    // Queue this request — resolve when the in-flight build finishes
    return new Promise((resolve) => buildQueue.push(resolve));
  }
  building = true;
  console.log("🎬 Building video feed from YouTube API…");

  try {
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

    // Enrich with real stats (1 quota unit per 50 videos — batch call)
    await enrichWithStats(videos);

    // Shuffle
    videos = videos.sort(() => 0.5 - Math.random());
    console.log(`✅ Feed built: ${videos.length} videos`);

    // Write L2
    await saveFeedCache(videos);

    // Write L1
    l1Cache = videos;
    l1CachedAt = Date.now();

    return videos;
  } finally {
    building = false;
    // Drain queue — all waiting requests get the freshly built feed
    buildQueue.splice(0).forEach((resolve) => resolve(l1Cache));
  }
}

async function getFeed() {
  // L1 check
  if (l1Cache && Date.now() - l1CachedAt < L1_TTL) {
    return l1Cache;
  }
  // L2 check
  const cached = await loadFeedCache();
  if (cached && cached.length > 0) {
    console.log(`📦 Feed from MongoDB cache (${cached.length} videos)`);
    l1Cache = cached;
    l1CachedAt = Date.now();
    return cached;
  }
  // Cache miss — build from YouTube
  return buildFeed();
}

// GET /api/videos/foryou
router.get("/foryou", async (req, res) => {
  try {
    const uid = req.headers["x-user-uid"];
    if (!uid) return res.status(401).json({ message: "Missing user UID" });

    const feed = await getFeed();
    const watched = await getWatchedVideos(uid);
    let unseen = feed.filter((v) => !watched.includes(v.videoId));
    if (unseen.length === 0) unseen = feed; // reset when all watched

    res.json(unseen.slice(0, 20));
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

// DELETE /api/videos/cache — admin: force full rebuild
router.delete("/cache", async (_req, res) => {
  l1Cache = null;
  l1CachedAt = 0;
  await clearFeedCache();
  res.json({ message: "Both cache layers cleared. Next request rebuilds." });
});

// GET /api/videos/cache/status — admin: inspect cache state
router.get("/cache/status", async (_req, res) => {
  const l2 = await loadFeedCache();
  res.json({
    l1: {
      hit: !!l1Cache,
      videos: l1Cache?.length ?? 0,
      ageSeconds: l1Cache ? Math.floor((Date.now() - l1CachedAt) / 1000) : null,
    },
    l2: { hit: !!l2, videos: l2?.length ?? 0 },
  });
});

module.exports = router;
