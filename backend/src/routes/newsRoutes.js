// backend/src/routes/newsRoutes.js
"use strict";

const express = require("express");
const https = require("https");
const {
  saveNewsCache,
  loadNewsCache,
  clearNewsCache,
} = require("../models/NewsCache");

const router = express.Router();

const SOURCES = [
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
];

// ─── L1 in-memory cache ───────────────────────────────────────────────────────
let l1Cache = null;
let l1CachedAt = 0;
const L1_TTL = 20 * 60 * 1000; // 20 minutes
let building = false;

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: 10000, headers: { "User-Agent": "YPN-App/1.0 (RSS)" } },
      (res) => {
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

// ─── RSS parser ───────────────────────────────────────────────────────────────
function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

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
  if (m) return m[1];
  return null;
}

function parseRSS(xml, source) {
  const articles = [];
  const itemRx = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRx.exec(xml)) !== null) {
    const block = match[1];
    const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkM =
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) ||
      block.match(/<link[^>]*href=["']([^"']+)["']/i);
    const pubM = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const descM = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i);

    const title = titleM ? decodeEntities(titleM[1]) : "";
    const link = linkM ? decodeEntities(linkM[1]) : "";
    if (!title || !link) continue;

    const pub = pubM ? pubM[1].trim() : "";
    const ts = pub ? new Date(pub).getTime() : Date.now();
    const desc = descM ? decodeEntities(descM[1]).slice(0, 250) : "";

    articles.push({
      id: `${source.key}-${link}`,
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

async function fetchSource(source) {
  try {
    const xml = await httpsGet(source.url);
    return parseRSS(xml, source);
  } catch (err) {
    console.error(`[News] ${source.name} failed:`, err.message);
    return [];
  }
}

// ─── Build + cache ────────────────────────────────────────────────────────────
async function buildNews() {
  if (building) return l1Cache || [];
  building = true;
  console.log("📰 Building news feed...");
  try {
    const results = await Promise.allSettled(SOURCES.map(fetchSource));
    const articles = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter(Boolean)
      .filter(
        (item, idx, arr) => arr.findIndex((a) => a.id === item.id) === idx,
      )
      .sort((a, b) => b.pubDate - a.pubDate);

    if (articles.length > 0) {
      await saveNewsCache(articles);
      l1Cache = articles;
      l1CachedAt = Date.now();
      console.log(`✅ News ready: ${articles.length} articles`);
    }
    return articles;
  } finally {
    building = false;
  }
}

async function getNews() {
  if (l1Cache && l1Cache.length > 0 && Date.now() - l1CachedAt < L1_TTL) {
    return l1Cache; // L1 hit
  }
  const cached = await loadNewsCache();
  if (cached && cached.length > 0) {
    console.log(`📦 News from MongoDB (${cached.length} articles)`);
    l1Cache = cached;
    l1CachedAt = Date.now();
    return cached; // L2 hit
  }
  return buildNews(); // rebuild
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get("/", async (_req, res) => {
  try {
    res.json(await getNews());
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.delete("/cache", async (_req, res) => {
  l1Cache = null;
  l1CachedAt = 0;
  await clearNewsCache();
  res.json({ message: "News cache cleared. Next request will rebuild." });
});

router.get("/cache/status", async (_req, res) => {
  const l2 = await loadNewsCache();
  res.json({
    l1: {
      hit: !!l1Cache,
      articles: l1Cache?.length ?? 0,
      ageSeconds: l1Cache ? Math.floor((Date.now() - l1CachedAt) / 1000) : null,
    },
    l2: { hit: !!l2, articles: l2?.length ?? 0 },
  });
});

module.exports = router;
