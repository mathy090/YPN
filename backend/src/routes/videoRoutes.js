// backend/src/routes/videoRoutes.js
//
// Zero-quota video feed via YouTube public RSS feeds.
//
// YouTube exposes a free, unauthenticated RSS feed per channel:
//   https://www.youtube.com/feeds/videos.xml?channel_id=UC...
// No API key. No quota. Updates whenever YouTube updates the channel.
//
// Cache architecture (unchanged from previous version):
//   L1  in-memory   — zero latency, lost on restart
//   L2  MongoDB     — survives restarts, TTL-indexed auto-expiry at 1 hour
//
// Stats (views/likes/comments) are NOT available via RSS.
// They are returned as null — the frontend already handles this with fmt()
// showing "—". Stats will auto-appear again if you restore a Data API key
// by un-commenting enrichWithStats() at the bottom of buildFeed().

"use strict";

const express = require("express");
const https = require("https");
// fast-xml-parser is a transitive dep via @google-cloud/storage → firebase-admin.
// If "Cannot find module 'fast-xml-parser'" run:  npm install fast-xml-parser
const { XMLParser } = require("fast-xml-parser");
const { addWatchedVideo, getWatchedVideos } = require("../models/UserVideos");
const {
  saveFeedCache,
  loadFeedCache,
  clearFeedCache,
} = require("../models/VideoCache");

const router = express.Router();

// ─── Channel list ─────────────────────────────────────────────────────────────
// Add / remove channel IDs here or override via env vars.
// Format: { channelId: "UC...", label: "human name for logs" }
//
// How to find a channel ID:
//   1. Open the channel on YouTube in a browser
//   2. View page source → search for `"externalId"`  OR
//   3. Use https://ytpeek.com/tools/channel-id-finder (paste channel URL)
//
// Current channels (embeddable, public, relevant to YPN):
//   • Nhaka Africa        – mental health / youth empowerment Africa
//   • Maverick Citizen    – youth issues South Africa / broader Africa
//   • WHO AFRO            – health Africa (fallback content)
//   • Gringo Africa       – youth culture / empowerment Zimbabwe area
//
// Override any ID via env vars:  YOUTUBE_CHANNEL_1, YOUTUBE_CHANNEL_2, etc.
const CHANNELS = [
  {
    // Nhaka Foundation — mental health Africa
    channelId: process.env.YOUTUBE_CHANNEL_1 || "UCBcRF18a7Qf58cCRy5xuWwQ",
    label: "Nhaka Foundation",
  },
  {
    // SAfAIDS — sexual health / HIV youth Africa (Zimbabwe-based NGO)
    channelId: process.env.YOUTUBE_CHANNEL_2 || "UCo3bkMITWpAgdGUsKFpNMxg",
    label: "SAfAIDS",
  },
  {
    // Youth Empowerment Africa general
    channelId: process.env.YOUTUBE_CHANNEL_3 || "UCVq1UNDkEp0bMnXlWV_3q9A",
    label: "Africa Youth",
  },
  {
    // TED-Ed — broadly educational, always embeddable
    channelId: process.env.YOUTUBE_CHANNEL_4 || "UCsooa4yRKGN_zEE8iknghZA",
    label: "TED-Ed",
  },
];

// ─── L1 cache ─────────────────────────────────────────────────────────────────
let l1Cache = null;
let l1CachedAt = 0;
const L1_TTL = 60 * 60 * 1000; // 1 hour

let building = false;
const buildQueue = [];

// ─── RSS helpers ──────────────────────────────────────────────────────────────

/**
 * Fetch raw text from a URL using Node's built-in https module.
 * No external deps — avoids any axios/node-fetch version conflicts.
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

/**
 * Fetch and parse a YouTube channel RSS feed.
 * Returns up to `limit` VideoItem objects (no stats — all null).
 */
async function fetchChannelRSS(channelId, label, limit = 8) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const xml = await httpsGet(url);

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
    });
    const doc = parser.parse(xml);

    const feed = doc?.feed;
    if (!feed) return [];

    const entries = Array.isArray(feed.entry)
      ? feed.entry
      : feed.entry
        ? [feed.entry]
        : [];

    return entries.slice(0, limit).map((entry) => {
      const videoId =
        entry["yt:videoId"] || (entry.id || "").replace("yt:video:", "");

      const title =
        entry.title || entry["media:group"]?.["media:title"] || "Untitled";

      // RSS thumbnail: media:group > media:thumbnail @url
      const thumbnail =
        entry["media:group"]?.["media:thumbnail"]?.["@_url"] ||
        `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

      return {
        videoId,
        title: typeof title === "string" ? title : String(title),
        channelTitle: label,
        thumbnail,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        // Stats not available via RSS — frontend shows "—"
        viewCount: null,
        likeCount: null,
        commentCount: null,
      };
    });
  } catch (err) {
    console.error(
      `[RSS] Failed to fetch channel ${label} (${channelId}):`,
      err.message,
    );
    return [];
  }
}

// ─── Build feed ───────────────────────────────────────────────────────────────
async function buildFeed() {
  if (building) {
    return new Promise((resolve) => buildQueue.push(resolve));
  }
  building = true;
  console.log("🎬 Building video feed from YouTube RSS…");

  try {
    // Fetch all channels in parallel
    const results = await Promise.allSettled(
      CHANNELS.map((ch) => fetchChannelRSS(ch.channelId, ch.label, 8)),
    );

    let videos = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter(Boolean);

    // Deduplicate by videoId
    const seen = new Set();
    videos = videos.filter((v) => {
      if (!v.videoId || seen.has(v.videoId)) return false;
      seen.add(v.videoId);
      return true;
    });

    // Shuffle for variety
    videos = videos.sort(() => 0.5 - Math.random());

    console.log(`✅ RSS feed built: ${videos.length} videos`);

    // Persist to L2
    if (videos.length > 0) {
      await saveFeedCache(videos);
    }

    // Hydrate L1
    l1Cache = videos;
    l1CachedAt = Date.now();

    return videos;
  } finally {
    building = false;
    buildQueue.splice(0).forEach((resolve) => resolve(l1Cache));
  }
}

// ─── Get feed (L1 → L2 → build) ──────────────────────────────────────────────
async function getFeed() {
  // L1 hit
  if (l1Cache && l1Cache.length > 0 && Date.now() - l1CachedAt < L1_TTL) {
    return l1Cache;
  }
  // L2 hit
  const cached = await loadFeedCache();
  if (cached && cached.length > 0) {
    console.log(`📦 Feed from MongoDB cache (${cached.length} videos)`);
    l1Cache = cached;
    l1CachedAt = Date.now();
    return cached;
  }
  // Miss — build from RSS
  return buildFeed();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

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

// DELETE /api/videos/cache — force full RSS rebuild
router.delete("/cache", async (_req, res) => {
  l1Cache = null;
  l1CachedAt = 0;
  await clearFeedCache();
  res.json({ message: "Cache cleared. Next request rebuilds from RSS." });
});

// GET /api/videos/cache/status
router.get("/cache/status", async (_req, res) => {
  const l2 = await loadFeedCache();
  res.json({
    source: "rss",
    l1: {
      hit: !!l1Cache && l1Cache.length > 0,
      videos: l1Cache?.length ?? 0,
      ageSeconds: l1Cache ? Math.floor((Date.now() - l1CachedAt) / 1000) : null,
    },
    l2: { hit: !!l2, videos: l2?.length ?? 0 },
    channels: CHANNELS.map((c) => c.label),
  });
});

module.exports = router;
