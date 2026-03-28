// backend/src/routes/newsRoutes.js
//
// Zero-key news feed using Google News RSS + direct outlet RSS feeds.
// Two-layer cache: L1 in-memory (20 min) → L2 MongoDB TTL (20 min).
// Never crashes — always returns something usable.
"use strict";

const express = require("express");
const https = require("https");
const {
  saveNewsCache,
  loadNewsCache,
  clearNewsCache,
} = require("../models/NewsCache");

const router = express.Router();

// ─── News sources ─────────────────────────────────────────────────────────────
// Google News RSS requires no API key and is highly reliable.
// Direct outlet feeds are tried first; Google News fills gaps.
const SOURCES = [
  // ── Google News RSS queries (most reliable, no key) ───────────────────────
  {
    key: "gnews-zim",
    name: "Zimbabwe News",
    color: "#1DB954",
    url: "https://news.google.com/rss/search?q=Zimbabwe+youth&hl=en-ZW&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-africa",
    name: "Africa Youth",
    color: "#FEE75C",
    url: "https://news.google.com/rss/search?q=Zimbabwe+youth+empowerment&hl=en&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-health",
    name: "Health & Wellness",
    color: "#57F287",
    url: "https://news.google.com/rss/search?q=mental+health+Zimbabwe&hl=en&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-jobs",
    name: "Jobs & Economy",
    color: "#5865F2",
    url: "https://news.google.com/rss/search?q=Zimbabwe+jobs+employment+youth&hl=en&gl=ZW&ceid=ZW:en",
  },

  // ── Direct outlet feeds (best-effort, fallback gracefully) ────────────────
  // Herald — sometimes blocks bots; we set a browser UA
  {
    key: "herald",
    name: "Herald",
    color: "#C0392B",
    url: "https://www.herald.co.zw/feed/",
  },
  // NewsDay — generally accessible
  {
    key: "newsday",
    name: "NewsDay",
    color: "#2980B9",
    url: "https://www.newsday.co.zw/feed/",
  },
  // 263Chat — youth-focused, usually works
  {
    key: "263chat",
    name: "263Chat",
    color: "#27AE60",
    url: "https://263chat.com/feed/",
  },
  // ZimLive
  {
    key: "zimlive",
    name: "ZimLive",
    color: "#8E44AD",
    url: "https://www.zimlive.com/feed/",
  },
  // Chronicle
  {
    key: "chronicle",
    name: "Chronicle",
    color: "#E67E22",
    url: "https://www.chronicle.co.zw/feed/",
  },
];

// ─── L1 in-memory cache ───────────────────────────────────────────────────────
let l1Cache = null;
let l1CachedAt = 0;
const L1_TTL = 20 * 60 * 1000; // 20 minutes
let building = false;

// ─── HTTP helper — browser UA so outlets don't block us ──────────────────────
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function httpsGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept:
            "application/rss+xml,application/xml,text/xml,application/atom+xml,*/*",
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
    .replace(/<[^>]+>/g, "") // strip HTML tags
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Thumbnail extractor ─────────────────────────────────────────────────────
function extractThumbnail(block) {
  // media:content
  let m = block.match(/media:content[^>]*url=["']([^"']+)["']/i);
  if (m) return m[1];
  // media:thumbnail
  m = block.match(/media:thumbnail[^>]*url=["']([^"']+)["']/i);
  if (m) return m[1];
  // enclosure image
  m = block.match(
    /<enclosure[^>]*type=["']image[^"']*["'][^>]*url=["']([^"']+)["']/i,
  );
  if (m) return m[1];
  // img tag inside description/content
  m = block.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && m[1].startsWith("http")) return m[1];
  return null;
}

// ─── RSS parser ───────────────────────────────────────────────────────────────
function parseRSS(xml, source) {
  const articles = [];
  const itemRx = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRx.exec(xml)) !== null) {
    const block = match[1];

    // Title
    const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleM) continue;
    const title = decodeEntities(titleM[1]);
    if (!title) continue;

    // Link — try <link> text content first, then href attribute
    const linkTextM = block.match(/<link[^>]*>\s*(https?[^<]+?)\s*<\/link>/i);
    const linkAttrM = block.match(/<link[^>]*href=["'](https?[^"']+)["']/i);
    // Google News RSS wraps the real URL — use it as-is
    const link = linkTextM
      ? linkTextM[1].trim()
      : linkAttrM
        ? linkAttrM[1].trim()
        : "";
    if (!link) continue;

    // Publication date
    const pubM = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const pub = pubM ? pubM[1].trim() : "";
    const ts = pub ? new Date(pub).getTime() : Date.now();

    // Description — first 300 chars
    const descM = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const desc = descM ? decodeEntities(descM[1]).slice(0, 300) : "";

    articles.push({
      id: `${source.key}-${Buffer.from(link).toString("base64").slice(0, 20)}`,
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
    // Log but don't crash — other sources fill the gap
    console.warn(`[News] ✗ ${source.name}: ${err.message}`);
    return [];
  }
}

// ─── Build full feed ──────────────────────────────────────────────────────────
async function buildNews() {
  if (building) {
    // Wait for in-progress build rather than spawning a second one
    await new Promise((r) => setTimeout(r, 2000));
    return l1Cache ?? [];
  }

  building = true;
  console.log("📰 Building news feed…");

  try {
    const results = await Promise.allSettled(SOURCES.map(fetchSource));

    let articles = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter(Boolean);

    // Deduplicate by ID
    const seen = new Set();
    articles = articles.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });

    // Sort newest first
    articles.sort((a, b) => b.pubDate - a.pubDate);

    console.log(`✅ News ready: ${articles.length} articles`);

    if (articles.length > 0) {
      await saveNewsCache(articles).catch((e) =>
        console.warn("[News] Cache save failed:", e.message),
      );
      l1Cache = articles;
      l1CachedAt = Date.now();
    }

    return articles;
  } finally {
    building = false;
  }
}

// ─── Get news: L1 → L2 → build ───────────────────────────────────────────────
async function getNews() {
  // L1 hit
  if (l1Cache && l1Cache.length > 0 && Date.now() - l1CachedAt < L1_TTL) {
    return l1Cache;
  }

  // L2 hit (MongoDB TTL cache)
  try {
    const cached = await loadNewsCache();
    if (cached && cached.length > 0) {
      console.log(`📦 News from MongoDB (${cached.length} articles)`);
      l1Cache = cached;
      l1CachedAt = Date.now();
      return cached;
    }
  } catch (e) {
    console.warn("[News] L2 cache load failed:", e.message);
  }

  // Build fresh
  return buildNews();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get("/", async (_req, res) => {
  try {
    const articles = await getNews();
    // Always return 200 — even an empty array is better than a crash on the client
    res.json(articles);
  } catch (e) {
    console.error("[News] GET / error:", e.message);
    res.status(500).json({ message: "Failed to load news", articles: [] });
  }
});

router.delete("/cache", async (_req, res) => {
  l1Cache = null;
  l1CachedAt = 0;
  try {
    await clearNewsCache();
  } catch {}
  res.json({ message: "News cache cleared. Next request rebuilds from RSS." });
});

router.get("/cache/status", async (_req, res) => {
  let l2 = null;
  try {
    l2 = await loadNewsCache();
  } catch {}
  res.json({
    l1: {
      hit: !!l1Cache,
      articles: l1Cache?.length ?? 0,
      ageSeconds: l1Cache ? Math.floor((Date.now() - l1CachedAt) / 1000) : null,
    },
    l2: { hit: !!l2, articles: l2?.length ?? 0 },
    sources: SOURCES.map((s) => s.name),
  });
});

module.exports = router;
