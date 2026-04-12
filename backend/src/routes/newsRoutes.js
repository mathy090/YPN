// backend/src/routes/newsRoutes.js
//
// Zero-key news feed using Google News RSS + direct outlet RSS feeds.
// Two-layer cache: L1 in-memory (10 min) → L2 MongoDB (accumulates over time).
//
// Fixes applied:
//   1. Relaxed deduplication: URL + date + source, not just ID
//   2. Smart merge: combine archive + fresh without losing diversity
//   3. Shorter L1 TTL: 20 min → 10 min for fresher feeds
//   4. Force-refresh param: ?refresh=true bypasses cache for testing

"use strict";

const express = require("express");
const https = require("https");

const router = express.Router();

// ─── News sources ─────────────────────────────────────────────────────────────
const SOURCES = [
  // ── Google News RSS ──────────────────────────────────────────────────────
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

  // ── Direct Zimbabwe outlet feeds ────────────────────────────────────────
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
const L1_TTL = 10 * 60 * 1000; // ✅ FIX 3: 10 min (was 20 min)

// ─── L1 in-memory cache ───────────────────────────────────────────────────────
let l1Cache = null;
let l1CachedAt = 0;
let building = false;

// ─── MongoDB accumulation ─────────────────────────────────────────────────────
let _db = null;

function initNewsArchive(db) {
  _db = db;

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
    console.error("[News] Archive write error:", err.message, err.stack);
  }
}

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
    console.error("[News] Archive read error:", err.message);
    return null;
  }
}

// ─── Browser UA ────────────────────────────────────────────────────────────────
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

// ─── Decode Google News redirect URLs ────────────────────────────────────────
function decodeGoogleNewsUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  if (!rawUrl.includes("news.google.com")) return rawUrl;

  try {
    const pathMatch = rawUrl.match(/\/articles\/([^?]+)/);
    if (pathMatch) {
      const encoded = pathMatch[1];
      const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "==".slice(0, (4 - (base64.length % 4)) % 4);
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      const urlMatch = decoded.match(/https?:\/\/[^\s"'<>]+/);
      if (urlMatch) return urlMatch[0];
    }
  } catch {
    console.warn(
      "[News] Failed to decode Google News URL:",
      rawUrl.slice(0, 80),
    );
  }
  return rawUrl;
}

// ─── RSS parser ──────────────────────────────────────────────────────────────
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

    const link = decodeGoogleNewsUrl(rawLink);

    const pubM = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const pub = pubM ? pubM[1].trim() : "";
    const ts = pub ? new Date(pub).getTime() : Date.now();

    const descM = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const desc = descM ? decodeEntities(descM[1]).slice(0, 300) : "";

    // ✅ FIX 1: Create ID from URL + source + date (not just URL)
    // This allows same URL from different sources/dates to coexist
    const urlFp = Buffer.from(link).toString("base64").slice(0, 16);
    const dateKey = new Date(ts).toISOString().split("T")[0]; // YYYY-MM-DD
    const id = `${source.key}-${urlFp}-${dateKey}`;

    articles.push({
      id,
      title,
      link,
      pubDate: isNaN(ts) ? Date.now() : ts,
      source: source.name,
      sourceColor: source.color,
      thumbnail: extractThumbnail(block),
      description: desc,
      // ✅ Store raw URL fingerprint for secondary dedupe if needed
      _urlFp: urlFp,
    });
  }

  return articles;
}

async function fetchSource(source) {
  try {
    const xml = await httpsGet(source.url, 12000);
    const items = parseRSS(xml, source);
    console.log(`[News] ✓ ${source.name}: ${items.length} articles`);
    return items;
  } catch (err) {
    console.warn(`[News] ✗ ${source.name} (${source.key}): ${err.message}`);
    return [];
  }
}

// ✅ FIX 1: Relaxed deduplication - allows same story from different sources/dates
function dedupeArticles(articles) {
  const seen = new Map();

  return articles.filter((article) => {
    // Create a key from URL fingerprint + date + source
    // This allows: same URL from different sources, or same URL on different days
    const key = `${article._urlFp}_${new Date(article.pubDate).toISOString().split("T")[0]}_${article.source}`;

    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

// ✅ FIX 2: Smart merge - combine archive + fresh without losing diversity
function mergeArticles(archived, fresh) {
  if (!archived?.length) return fresh || [];
  if (!fresh?.length) return archived;

  // Create a set of archived article IDs for quick lookup
  const archivedIds = new Set(archived.map((a) => a.id));

  // Add fresh articles that aren't already in archive
  const merged = [...archived];
  for (const article of fresh) {
    if (!archivedIds.has(article.id)) {
      merged.push(article);
    }
  }

  // Sort by date (newest first) and limit
  merged.sort((a, b) => b.pubDate - a.pubDate);
  return merged.slice(0, MAX_ARTICLES);
}

// ─── Build fresh news batch + merge with archive ──────────────────────────────
async function buildNews() {
  if (building) {
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

    // ✅ FIX 1: Relaxed deduplication on fresh batch
    freshArticles = dedupeArticles(freshArticles);
    console.log(
      `[News] ${freshArticles.length} unique articles after relaxed dedupe`,
    );

    if (freshArticles.length > 0) {
      // 2. Archive new articles
      await archiveArticles(freshArticles);

      // 3. Load archive
      const archived = await loadFromArchive(MAX_ARTICLES);

      // ✅ FIX 2: Smart merge instead of replace
      const allArticles = mergeArticles(archived, freshArticles);

      console.log(
        `✅ News ready: ${allArticles.length} total articles (merged)`,
      );

      l1Cache = allArticles;
      l1CachedAt = Date.now();
      return allArticles;
    } else {
      console.warn(
        "[News] All RSS sources returned no articles — using archive fallback",
      );
      const archived = await loadFromArchive(MAX_ARTICLES);
      if (archived && archived.length > 0) {
        l1Cache = archived;
        l1CachedAt = Date.now();
        return archived;
      }
      return l1Cache ?? [];
    }
  } catch (err) {
    console.error("[News] buildNews fatal error:", err.message, err.stack);
    return l1Cache ?? [];
  } finally {
    building = false;
  }
}

// ─── Get news: L1 → archive → build ─────────────────────────────────────────
async function getNews(forceRefresh = false) {
  // ✅ FIX 4: Allow force refresh via param
  if (
    !forceRefresh &&
    l1Cache &&
    l1Cache.length > 0 &&
    Date.now() - l1CachedAt < L1_TTL
  ) {
    return l1Cache;
  }

  const archived = await loadFromArchive(MAX_ARTICLES);
  if (archived && archived.length > 0 && !forceRefresh) {
    console.log(`📦 News from archive (${archived.length} articles)`);
    l1Cache = archived;
    l1CachedAt = Date.now();
    buildNews().catch((e) =>
      console.error("[News] Background build error:", e.message),
    );
    return archived;
  }

  return buildNews();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    // ✅ FIX 4: Support ?refresh=true to bypass cache
    const forceRefresh = req.query.refresh === "true";
    const articles = await getNews(forceRefresh);

    if (!articles.length) {
      return res.status(503).json({
        message: "News temporarily unavailable. Please try again shortly.",
        articles: [],
      });
    }

    res.json(articles.slice(0, MAX_ARTICLES));
  } catch (e) {
    console.error("[News] GET / error:", e.message, e.stack);
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
