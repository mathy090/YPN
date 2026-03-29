// backend/src/routes/videoRoutes.js
//
// Zero-quota video feed — YouTube public RSS only, no API key required.
//   1. YouTube public RSS  — fetches videoId/title/thumbnail, no API key
//   2. oEmbed filter       — removes non-embeddable videos (kills Error 153/150)
//   3. Two-layer cache     — L1 in-memory + L2 MongoDB TTL
//   4. No date filtering   — keep all content including older videos from 2018+
//
// Expanded channel list covering Zimbabwe youth, empowerment, mental health,
// education, and African development — all sourced via RSS, no API key.

"use strict";

const express = require("express");
const https = require("https");
const { XMLParser } = require("fast-xml-parser");
const { addWatchedVideo, getWatchedVideos } = require("../models/UserVideos");
const {
  saveFeedCache,
  loadFeedCache,
  clearFeedCache,
} = require("../models/VideoCache");

const router = express.Router();

// ─── Expanded channel list — no API key, RSS only ─────────────────────────────
// All channels curated for Zimbabwe youth, empowerment, mental health, education.
// Override any via YOUTUBE_CHANNEL_1 … YOUTUBE_CHANNEL_N env vars.
const CHANNELS = [
  // ── Zimbabwe / Africa youth & empowerment ─────────────────────────────────
  {
    channelId: process.env.YOUTUBE_CHANNEL_1 || "UCBcRF18a7Qf58cCRy5xuWwQ",
    label: "Nhaka Foundation",
  },
  {
    channelId: process.env.YOUTUBE_CHANNEL_2 || "UCo3bkMITWpAgdGUsKFpNMxg",
    label: "SAfAIDS",
  },
  {
    channelId: process.env.YOUTUBE_CHANNEL_3 || "UCVq1UNDkEp0bMnXlWV_3q9A",
    label: "Africa Youth",
  },
  // ── Education & always-embeddable ────────────────────────────────────────
  {
    channelId: process.env.YOUTUBE_CHANNEL_4 || "UCsooa4yRKGN_zEE8iknghZA",
    label: "TED-Ed",
  },
  {
    channelId: process.env.YOUTUBE_CHANNEL_5 || "UC295-Dw4tztRkEE_LfzEKIg",
    label: "TED",
  },
  // ── Mental health & wellbeing ─────────────────────────────────────────────
  {
    channelId: process.env.YOUTUBE_CHANNEL_6 || "UCddiUEpeqJcYeBxX1IVBKvQ",
    label: "Psych2Go",
  },
  {
    channelId: process.env.YOUTUBE_CHANNEL_7 || "UCGabB74NyWTQKfBbhFSvRsg",
    label: "Kati Morton",
  },
  // ── Skills & career development ───────────────────────────────────────────
  {
    channelId: process.env.YOUTUBE_CHANNEL_8 || "UCV0qA-eDDICsRR9rPcnG7tw",
    label: "GCFLearnFree",
  },
  {
    channelId: process.env.YOUTUBE_CHANNEL_9 || "UCXv0mdzvzJMbfnkoPjfOzGQ",
    label: "Khan Academy",
  },
  // ── African leadership & entrepreneurship ─────────────────────────────────
  {
    channelId: process.env.YOUTUBE_CHANNEL_10 || "UCEVDkJO20QqHZM7TYBwkyoA",
    label: "Tony Elumelu Foundation",
  },
  {
    channelId: process.env.YOUTUBE_CHANNEL_11 || "UCBt3B0DOrBKD6b1_-zQEjgQ",
    label: "African Leadership Academy",
  },
  // ── General youth motivation ──────────────────────────────────────────────
  {
    channelId: process.env.YOUTUBE_CHANNEL_12 || "UCWX3yGbODI3HMCMBdlT5-sw",
    label: "Goalcast",
  },
];

// ─── L1 in-memory cache ───────────────────────────────────────────────────────
let l1Cache = null;
let l1CachedAt = 0;
const L1_TTL = 60 * 60 * 1000; // 1 hour

let building = false;
const buildQueue = [];

// ─── Low-level HTTPS GET ───────────────────────────────────────────────────────
function httpsGet(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; YPN-RSS-Bot/1.0; +https://ypn.app)",
          Accept: "application/rss+xml,application/xml,text/xml,*/*",
        },
      },
      (res) => {
        // Follow single redirect
        if (
          res.statusCode >= 301 &&
          res.statusCode <= 308 &&
          res.headers.location
        ) {
          res.resume();
          return httpsGet(res.headers.location, timeoutMs)
            .then(resolve)
            .catch(reject);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
        }

        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });
  });
}

// ─── RSS feed parser ──────────────────────────────────────────────────────────
// No date filtering — keep all content regardless of age (2018+ included)
async function fetchChannelRSS(channelId, label, limit = 10) {
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
      const rawTitle =
        entry.title || entry["media:group"]?.["media:title"] || "Untitled";
      const title = typeof rawTitle === "string" ? rawTitle : String(rawTitle);
      const thumbnail =
        entry["media:group"]?.["media:thumbnail"]?.["@_url"] ||
        `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

      // Parse publish date — no filtering, just store it
      const published = entry.published || entry.updated || "";
      const pubDate = published ? new Date(published).getTime() : Date.now();

      return {
        videoId,
        title,
        channelTitle: label,
        thumbnail,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        pubDate,
        // Stats not available via RSS — shown as "—" on frontend
        viewCount: null,
        likeCount: null,
        commentCount: null,
      };
    });
  } catch (err) {
    console.error(`[RSS] ${label} (${channelId}):`, err.message);
    return [];
  }
}

// ─── oEmbed embeddability filter ──────────────────────────────────────────────
const OEMBED_BASE = "https://www.youtube.com/oembed?format=json&url=";
const OEMBED_BATCH = 10;

function isEmbeddable(videoId) {
  return new Promise((resolve) => {
    const url =
      OEMBED_BASE +
      encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const req = https.get(url, { timeout: 8000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function filterEmbeddable(videos) {
  const kept = [];
  for (let i = 0; i < videos.length; i += OEMBED_BATCH) {
    const batch = videos.slice(i, i + OEMBED_BATCH);
    const checks = await Promise.all(batch.map((v) => isEmbeddable(v.videoId)));
    batch.forEach((v, idx) => {
      if (checks[idx]) {
        kept.push(v);
      } else {
        console.log(
          `[oEmbed] ✗ blocked ${v.videoId} — "${v.title.slice(0, 50)}"`,
        );
      }
    });
  }
  return kept;
}

// ─── Build feed ───────────────────────────────────────────────────────────────
async function buildFeed() {
  if (building) {
    return new Promise((resolve) => buildQueue.push(resolve));
  }
  building = true;
  console.log(
    `🎬 Building feed from ${CHANNELS.length} channels via RSS + oEmbed filter…`,
  );

  try {
    // Fetch RSS from all channels in parallel
    const settled = await Promise.allSettled(
      CHANNELS.map((ch) => fetchChannelRSS(ch.channelId, ch.label, 10)),
    );
    let videos = settled
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

    console.log(
      `[RSS] Fetched ${videos.length} unique videos across ${CHANNELS.length} channels`,
    );

    // oEmbed filter — drop non-embeddable (Error 153/150)
    console.log(`[oEmbed] Checking ${videos.length} videos…`);
    videos = await filterEmbeddable(videos);
    console.log(`[oEmbed] ${videos.length} embeddable videos passed`);

    // Shuffle for variety — mix channels
    videos = videos.sort(() => 0.5 - Math.random());

    // Persist to L2 MongoDB (TTL 1 hour)
    if (videos.length > 0) await saveFeedCache(videos);

    // Hydrate L1
    l1Cache = videos;
    l1CachedAt = Date.now();

    console.log(`✅ Feed ready: ${videos.length} embeddable videos`);
    return videos;
  } finally {
    building = false;
    buildQueue.splice(0).forEach((resolve) => resolve(l1Cache));
  }
}

// ─── getFeed: L1 → L2 → build ─────────────────────────────────────────────────
async function getFeed() {
  if (l1Cache && l1Cache.length > 0 && Date.now() - l1CachedAt < L1_TTL) {
    return l1Cache;
  }
  const cached = await loadFeedCache();
  if (cached && cached.length > 0) {
    console.log(`📦 Feed from MongoDB (${cached.length} videos)`);
    l1Cache = cached;
    l1CachedAt = Date.now();
    return cached;
  }
  return buildFeed();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/foryou", async (req, res) => {
  try {
    const uid = req.headers["x-user-uid"];
    if (!uid) return res.status(401).json({ message: "Missing user UID" });

    const feed = await getFeed();
    const watched = await getWatchedVideos(uid);
    let unseen = feed.filter((v) => !watched.includes(v.videoId));
    // Reset when all watched — show full feed again
    if (unseen.length === 0) unseen = feed;

    res.json(unseen.slice(0, 20));
  } catch (e) {
    console.error("/api/videos/foryou:", e.message);
    res.status(500).json({ message: e.message });
  }
});

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

// Admin: force full rebuild
router.delete("/cache", async (_req, res) => {
  l1Cache = null;
  l1CachedAt = 0;
  await clearFeedCache();
  res.json({
    message:
      "Cache cleared. Next /foryou request will rebuild from RSS + oEmbed.",
  });
});

router.get("/cache/status", async (_req, res) => {
  const l2 = await loadFeedCache();
  res.json({
    source: "youtube-rss-no-api-key",
    channels: CHANNELS.length,
    channelList: CHANNELS.map((c) => c.label),
    l1: {
      hit: !!l1Cache && l1Cache.length > 0,
      videos: l1Cache?.length ?? 0,
      ageSeconds: l1Cache ? Math.floor((Date.now() - l1CachedAt) / 1000) : null,
    },
    l2: { hit: !!l2, videos: l2?.length ?? 0 },
  });
});

module.exports = router;
