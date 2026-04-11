// backend/src/routes/newsRoutes.js
//
// Zero-key news feed using Google News RSS + direct outlet RSS feeds.
// Two-layer cache: L1 in-memory (20 min) → L2 MongoDB (accumulates over time).
//
// Fixes applied:
//   1. initNewsArchive(db) called at startup (wired in server.js)
//   2. Article return limit capped at 100 to prevent memory issues
//   3. Google News redirect URLs decoded to real article URLs
//   4. Improved error logging — no silent catches
//   5. Fallback returns cached/archive data if RSS fetch fails

"use strict";

const express = require("express");
const https = require("https");

const router = express.Router();

// ─── News sources ─────────────────────────────────────────────────────────────
const SOURCES = [
  // ── Google News RSS — most reliable, no key, broad coverage ──────────────
  {
    key: "gnews-zim-youth",
    name: "Zimbabwe News",
    color: "#1DB954",
    url: "https://news.google.com/rss/search?q=Zimbabwe+youth&hl=en-ZW&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-zim-empowerment",
    name: "Empowerment",
    color: "#57F287",
    url: "https://news.google.com/rss/search?q=Zimbabwe+youth+empowerment+programs&hl=en&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-mental-health",
    name: "Mental Health",
    color: "#5865F2",
    url: "https://news.google.com/rss/search?q=mental+health+Zimbabwe+young+people&hl=en&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-jobs",
    name: "Jobs & Economy",
    color: "#FEE75C",
    url: "https://news.google.com/rss/search?q=Zimbabwe+jobs+employment+youth+2024&hl=en&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-education",
    name: "Education",
    color: "#EB459E",
    url: "https://news.google.com/rss/search?q=Zimbabwe+education+scholarships+students&hl=en&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-africa-youth",
    name: "Africa Youth",
    color: "#FF7043",
    url: "https://news.google.com/rss/search?q=Africa+youth+development+leadership&hl=en&gl=ZA&ceid=ZA:en",
  },
  {
    key: "gnews-counselling",
    name: "Counselling",
    color: "#9C27B0",
    url: "https://news.google.com/rss/search?q=youth+counselling+Africa+mental+wellbeing&hl=en&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-entrepreneurship",
    name: "Entrepreneurship",
    color: "#FF9800",
    url: "https://news.google.com/rss/search?q=Zimbabwe+entrepreneurship+youth+startup&hl=en&gl=ZW&ceid=ZW:en",
  },

  // ── Direct Zimbabwe outlet feeds — best-effort ────────────────────────────
  {
    key: "herald",
    name: "Herald",
    color: "#C0392B",
    url: "https://www.herald.co.zw/feed/",
  },
  {
    key: "newsday",
    name: "NewsDay",
    color: "#2980B9",
    url: "https://www.newsday.co.zw/feed/",
  },
  {
    key: "263chat",
    name: "263Chat",
    color: "#27AE60",
    url: "https://263chat.com/feed/",
  },
  {
    key: "zimlive",
    name: "ZimLive",
    color: "#8E44AD",
    url: "https://www.zimlive.com/feed/",
  },
  {
    key: "chronicle",
    name: "Chronicle",
    color: "#E67E22",
    url: "https://www.chronicle.co.zw/feed/",
  },
  {
    key: "zbc",
    name: "ZBC News",
    color: "#E91E63",
    url: "https://www.zbcnews.co.zw/feed/",
  },
  {
    key: "nehanda",
    name: "Nehanda Radio",
    color: "#00BCD4",
    url: "https://nehandaradio.com/feed/",
  },
];

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_ARTICLES = 100;

// ─── L1 in-memory cache ───────────────────────────────────────────────────────
let l1Cache = null;
let l1CachedAt = 0;
const L1_TTL = 20 * 60 * 1000; // 20 min
let building = false;

// ─── MongoDB accumulation ─────────────────────────────────────────────────────
let _db = null;

// FIX 1: initNewsArchive must be called at startup from server.js
function initNewsArchive(db) {
  _db = db;

  // Create indexes — log errors instead of silently swallowing them
  db.collection("news_archive")
    .createIndex({ id: 1 }, { unique: true })
    .catch((err) =>
      console.error("[News] Failed to create id index:", err.message),
    );

  db.collection("news_archive")
    .createIndex({ pubDate: -1 })
    .catch((err) =>
      console.error("[News] Failed to create pubDate index:", err.message),
    );

  console.log("[News] Archive store initialised");
}

// FIX 4: No silent catches — always log archive errors
async function archiveArticles(articles) {
  if (!_db || !articles.length) return;
  try {
    const ops = articles.map((a) => ({
      updateOne: {
        filter: { id: a.id },
        update: { $setOnInsert: { ...a, archivedAt: new Date() } },
        upsert: true,
      },
    }));
    const result = await _db
      .collection("news_archive")
      .bulkWrite(ops, { ordered: false });
    if (result.upsertedCount > 0) {
      console.log(`[News] Archived ${result.upsertedCount} new articles`);
    }
  } catch (err) {
    // FIX 4: Log with full detail instead of swallowing
    console.error("[News] Archive write error:", err.message, err.stack);
  }
}

// FIX 2: Safety limit — cap at MAX_ARTICLES
async function loadFromArchive(limit = MAX_ARTICLES) {
  if (!_db) return null;
  try {
    const safeLimit = Math.min(limit, MAX_ARTICLES);
    const docs = await _db
      .collection("news_archive")
      .find({}, { projection: { _id: 0 } })
      .sort({ pubDate: -1 })
      .limit(safeLimit)
      .toArray();
    return docs.length > 0 ? docs : null;
  } catch (err) {
    // FIX 4: Log instead of silently returning null
    console.error("[News] Archive read error:", err.message);
    return null;
  }
}

// ─── Browser UA to avoid bot blocking ────────────────────────────────────────
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function httpsGet(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept:
            "application/rss+xml,application/xml,text/xml,application/atom+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
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
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

// ─── HTML entity + CDATA cleaner ─────────────────────────────────────────────
function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Thumbnail extractor ─────────────────────────────────────────────────────
function extractThumbnail(block) {
  let m = block.match(/media:content[^>]*url=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(/media:thumbnail[^>]*url=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(
    /<enclosure[^>]*type=["']image[^"']*["'][^>]*url=["']([^"']+)["']/i,
  );
  if (m) return m[1];
  m = block.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && m[1].startsWith("http")) return m[1];
  return null;
}

// FIX 3: Decode Google News redirect URLs to real article URLs
// Google News RSS wraps article links in: https://news.google.com/rss/articles/...
// The real URL is Base64-encoded in the path. We try to extract it, and if
// extraction fails we fall back to following the redirect via a HEAD request.
function decodeGoogleNewsUrl(rawUrl) {
  if (!rawUrl) return rawUrl;

  // Already a real URL (not a Google News redirect)
  if (!rawUrl.includes("news.google.com")) return rawUrl;

  try {
    // Google News article URLs look like:
    // https://news.google.com/rss/articles/CBMi...?hl=en&gl=ZW&ceid=ZW:en
    // The article ID segment is Base64url-encoded and contains the real URL.
    // Attempt a simple Base64 decode of the path segment after /articles/
    const pathMatch = rawUrl.match(/\/articles\/([^?]+)/);
    if (pathMatch) {
      const encoded = pathMatch[1];
      // Base64url decode
      const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "==".slice(0, (4 - (base64.length % 4)) % 4);
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      // The decoded string contains the real URL embedded in it
      const urlMatch = decoded.match(/https?:\/\/[^\s"'<>]+/);
      if (urlMatch) return urlMatch[0];
    }
  } catch {
    // Decoding failed — log a warning and fall back to original URL
    console.warn(
      "[News] Failed to decode Google News URL:",
      rawUrl.slice(0, 80),
    );
  }

  // Fallback: return the raw Google News URL — frontend can still open it
  return rawUrl;
}

// ─── RSS parser — no date filtering ──────────────────────────────────────────
function parseRSS(xml, source) {
  const articles = [];
  const itemRx = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRx.exec(xml)) !== null) {
    const block = match[1];

    const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleM) continue;
    const title = decodeEntities(titleM[1]);
    if (!title) continue;

    const linkTextM = block.match(/<link[^>]*>\s*(https?[^<]+?)\s*<\/link>/i);
    const linkAttrM = block.match(/<link[^>]*href=["'](https?[^"']+)["']/i);
    const rawLink = linkTextM
      ? linkTextM[1].trim()
      : linkAttrM
        ? linkAttrM[1].trim()
        : "";
    if (!rawLink) continue;

    // FIX 3: Decode Google News redirect to real article URL
    const link = decodeGoogleNewsUrl(rawLink);

    const pubM = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const pub = pubM ? pubM[1].trim() : "";
    const ts = pub ? new Date(pub).getTime() : Date.now();

    const descM = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const desc = descM ? decodeEntities(descM[1]).slice(0, 300) : "";

    // Stable ID from source key + URL fingerprint
    const urlFp = Buffer.from(link).toString("base64").slice(0, 20);
    const id = `${source.key}-${urlFp}`;

    articles.push({
      id,
      title,
      link,
      pubDate: isNaN(ts) ? Date.now() : ts,
      source: source.name,
      sourceColor: source.color,
      thumbnail: extractThumbnail(block),
      description: desc,
    });
  }

  return articles;
}

// ─── Fetch one source (logs failures, never throws) ───────────────────────────
async function fetchSource(source) {
  try {
    const xml = await httpsGet(source.url, 12000);
    const items = parseRSS(xml, source);
    console.log(`[News] ✓ ${source.name}: ${items.length} articles`);
    return items;
  } catch (err) {
    // FIX 4: Always log what went wrong — not a silent catch
    console.warn(`[News] ✗ ${source.name} (${source.key}): ${err.message}`);
    return [];
  }
}

// ─── Build fresh news batch + merge with archive ──────────────────────────────
async function buildNews() {
  if (building) {
    // Wait up to 5 seconds for the in-progress build to finish
    await new Promise((r) => setTimeout(r, 3000));
    return l1Cache ?? [];
  }

  building = true;
  console.log(`📰 Building news feed from ${SOURCES.length} sources…`);

  try {
    // 1. Fetch all sources in parallel
    const results = await Promise.allSettled(SOURCES.map(fetchSource));
    let freshArticles = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter(Boolean);

    // 2. Deduplicate fresh batch by ID
    const seen = new Set();
    freshArticles = freshArticles.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });

    console.log(`[News] ${freshArticles.length} unique articles from RSS`);

    // FIX 5: Only update cache if we actually got articles — never overwrite
    // good cached data with an empty result set from a failed fetch round
    if (freshArticles.length > 0) {
      // 3. Archive new articles in MongoDB (accumulates over time)
      await archiveArticles(freshArticles);

      // 4. Load full archive (sorted newest first, capped at MAX_ARTICLES)
      const archived = await loadFromArchive(MAX_ARTICLES);
      const allArticles = archived ?? freshArticles;

      // 5. Sort newest first
      allArticles.sort((a, b) => b.pubDate - a.pubDate);

      // FIX 2: Enforce safety limit before caching
      const limited = allArticles.slice(0, MAX_ARTICLES);
      console.log(`✅ News ready: ${limited.length} total articles`);

      l1Cache = limited;
      l1CachedAt = Date.now();
      return limited;
    } else {
      // All RSS sources failed — fall back to archive if available
      console.warn(
        "[News] All RSS sources returned no articles — using archive fallback",
      );
      const archived = await loadFromArchive(MAX_ARTICLES);
      if (archived && archived.length > 0) {
        l1Cache = archived;
        l1CachedAt = Date.now();
        return archived;
      }
      // Nothing at all — return whatever is in L1 (may be stale but better than [])
      return l1Cache ?? [];
    }
  } catch (err) {
    // FIX 4: Log the full error, not just a message
    console.error("[News] buildNews fatal error:", err.message, err.stack);
    // FIX 5: Return stale L1 cache instead of empty array
    return l1Cache ?? [];
  } finally {
    building = false;
  }
}

// ─── Get news: L1 → archive → build ─────────────────────────────────────────
async function getNews() {
  // L1 hit
  if (l1Cache && l1Cache.length > 0 && Date.now() - l1CachedAt < L1_TTL) {
    return l1Cache;
  }

  // FIX 5: Try archive first — return it immediately and kick off background refresh
  const archived = await loadFromArchive(MAX_ARTICLES);
  if (archived && archived.length > 0) {
    console.log(`📦 News from archive (${archived.length} articles)`);
    l1Cache = archived;
    l1CachedAt = Date.now();
    // Background refresh to pick up new articles
    buildNews().catch((e) =>
      console.error("[News] Background build error:", e.message),
    );
    return archived;
  }

  // Nothing cached — build fresh (blocking)
  return buildNews();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get("/", async (_req, res) => {
  try {
    const articles = await getNews();

    if (!articles.length) {
      // FIX 5: Return 503 with empty array and a message rather than silent []
      return res.status(503).json({
        message: "News temporarily unavailable. Please try again shortly.",
        articles: [],
      });
    }

    // FIX 2: Always cap the response at MAX_ARTICLES
    res.json(articles.slice(0, MAX_ARTICLES));
  } catch (e) {
    console.error("[News] GET / error:", e.message, e.stack);
    // FIX 5: Attempt to serve stale cache even on unexpected error
    if (l1Cache && l1Cache.length > 0) {
      return res.json(l1Cache.slice(0, MAX_ARTICLES));
    }
    res.status(500).json({ message: "Failed to load news", articles: [] });
  }
});

router.delete("/cache", async (_req, res) => {
  l1Cache = null;
  l1CachedAt = 0;
  res.json({
    message:
      "L1 cache cleared. Archive preserved. Next request rebuilds from RSS + archive.",
  });
});

router.get("/cache/status", async (_req, res) => {
  let totalArticles = 0;
  let archiveHasData = false;

  if (_db) {
    try {
      totalArticles = await _db.collection("news_archive").countDocuments();
      archiveHasData = totalArticles > 0;
    } catch (err) {
      console.error("[News] cache/status count error:", err.message);
    }
  }

  res.json({
    l1: {
      hit: !!l1Cache,
      articles: l1Cache?.length ?? 0,
      ageSeconds: l1Cache ? Math.floor((Date.now() - l1CachedAt) / 1000) : null,
    },
    archive: {
      totalArticles,
      hasData: archiveHasData,
      dbConnected: !!_db,
    },
    config: {
      maxArticles: MAX_ARTICLES,
      l1TtlSeconds: L1_TTL / 1000,
    },
    sources: SOURCES.map((s) => ({ name: s.name, key: s.key })),
  });
});

module.exports = { router, initNewsArchive };
