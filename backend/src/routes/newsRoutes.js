// backend/src/routes/newsRoutes.js
//
// Zero-key news feed using Google News RSS + direct outlet RSS feeds.
// Two-layer cache: L1 in-memory (20 min) → L2 MongoDB (accumulates over time).
//
// Key improvements:
//   • No date filtering — all articles kept regardless of age
//   • MongoDB accumulates articles over time (growing historical archive)
//   • Expanded sources covering Zimbabwe youth, health, jobs, education
//   • Direct outlet RSS feeds with browser UA to avoid bot blocking
//   • Deduplication by URL fingerprint across fetches

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

// ─── L1 in-memory cache ───────────────────────────────────────────────────────
let l1Cache = null;
let l1CachedAt = 0;
const L1_TTL = 20 * 60 * 1000; // 20 min
let building = false;

// ─── MongoDB accumulation ─────────────────────────────────────────────────────
// We import lazily to avoid circular dep issues
let _db = null;

function initNewsArchive(db) {
  _db = db;
  // Create index on id for deduplication, and on pubDate for sorting
  db.collection("news_archive")
    .createIndex({ id: 1 }, { unique: true })
    .catch(() => {});
  db.collection("news_archive")
    .createIndex({ pubDate: -1 })
    .catch(() => {});
  console.log("[News] Archive store initialised");
}

// Upsert new articles into the archive — never deletes, accumulates over time
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
    console.warn("[News] Archive write error:", err.message);
  }
}

// Load from archive — sorted newest first, no date limit
async function loadFromArchive(limit = 200) {
  if (!_db) return null;
  try {
    const docs = await _db
      .collection("news_archive")
      .find({}, { projection: { _id: 0 } })
      .sort({ pubDate: -1 })
      .limit(limit)
      .toArray();
    return docs.length > 0 ? docs : null;
  } catch {
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
    const link = linkTextM
      ? linkTextM[1].trim()
      : linkAttrM
        ? linkAttrM[1].trim()
        : "";
    if (!link) continue;

    // Parse pub date — keep all, no minimum date requirement
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

// ─── Fetch one source (never throws) ─────────────────────────────────────────
async function fetchSource(source) {
  try {
    const xml = await httpsGet(source.url, 12000);
    const items = parseRSS(xml, source);
    console.log(`[News] ✓ ${source.name}: ${items.length} articles`);
    return items;
  } catch (err) {
    console.warn(`[News] ✗ ${source.name}: ${err.message}`);
    return [];
  }
}

// ─── Build fresh news batch + merge with archive ──────────────────────────────
async function buildNews() {
  if (building) {
    await new Promise((r) => setTimeout(r, 2000));
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

    // 3. Archive new articles in MongoDB (accumulates over time)
    await archiveArticles(freshArticles);

    // 4. Load full archive (sorted newest first, no date limit)
    const archived = await loadFromArchive(200);
    const allArticles = archived ?? freshArticles;

    // 5. Sort newest first
    allArticles.sort((a, b) => b.pubDate - a.pubDate);

    console.log(`✅ News ready: ${allArticles.length} total articles`);

    l1Cache = allArticles;
    l1CachedAt = Date.now();

    return allArticles;
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

  // Try archive first (has historical articles)
  const archived = await loadFromArchive(200);
  if (archived && archived.length > 0) {
    console.log(`📦 News from archive (${archived.length} articles)`);
    l1Cache = archived;
    l1CachedAt = Date.now();
    // Background refresh to add new articles
    buildNews().catch((e) =>
      console.warn("[News] Background build:", e.message),
    );
    return archived;
  }

  // Build fresh
  return buildNews();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get("/", async (_req, res) => {
  try {
    const articles = await getNews();
    res.json(articles);
  } catch (e) {
    console.error("[News] GET / error:", e.message);
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
  const archived = await loadFromArchive(1).catch(() => null);
  const count = _db
    ? await _db
        .collection("news_archive")
        .countDocuments()
        .catch(() => 0)
    : 0;

  res.json({
    l1: {
      hit: !!l1Cache,
      articles: l1Cache?.length ?? 0,
      ageSeconds: l1Cache ? Math.floor((Date.now() - l1CachedAt) / 1000) : null,
    },
    archive: {
      totalArticles: count,
      hasData: !!archived,
    },
    sources: SOURCES.map((s) => ({ name: s.name, key: s.key })),
  });
});

module.exports = { router, initNewsArchive };
s;
