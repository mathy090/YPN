// backend/src/routes/newsRoutes.js
"use strict";

const express = require("express");
const https = require("https");
const { parseStringPromise } = require("xml2js");

const router = express.Router();

// ─── News sources ─────────────────────────────────────────────────────────────
// ✅ EXPANDED: Added 30+ diverse RSS sources for Zimbabwe & Africa youth news
const SOURCES = [
  // Google News searches (broad coverage)
  {
    key: "gnews-zim-youth",
    name: "Zimbabwe Youth News",
    color: "#1DB954",
    url: "https://news.google.com/rss/search?q=Zimbabwe+youth&hl=en-ZW&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-zim-empowerment",
    name: "Youth Empowerment",
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
  {
    key: "gnews-tech-zim",
    name: "Tech & Innovation",
    color: "#00BCD4",
    url: "https://news.google.com/rss/search?q=Zimbabwe+technology+innovation+youth&hl=en&gl=ZW&ceid=ZW:en",
  },
  {
    key: "gnews-sports-youth",
    name: "Youth Sports",
    color: "#FF5722",
    url: "https://news.google.com/rss/search?q=Zimbabwe+youth+sports+football&hl=en&gl=ZW&ceid=ZW:en",
  },

  // Zimbabwe local news outlets
  {
    key: "herald",
    name: "The Herald",
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
    name: "The Chronicle",
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
    color: "#00ACC1",
    url: "https://nehandaradio.com/feed/",
  },
  {
    key: "bulawayo24",
    name: "Bulawayo24",
    color: "#795548",
    url: "https://bulawayo24.com/index-id-news-sc-national-by-rss.xml",
  },
  {
    key: "zimeye",
    name: "ZimEye",
    color: "#607D8B",
    url: "https://www.zimeye.net/feed/",
  },
  {
    key: "veritas",
    name: "Veritas Zim",
    color: "#3F51B5",
    url: "https://www.veritaszim.net/rss.xml",
  },

  // Regional African sources
  {
    key: "citizen-africa",
    name: "The Citizen Africa",
    color: "#4CAF50",
    url: "https://www.thecitizen.co.tz/rss",
  },
  {
    key: "nation-africa",
    name: "Nation Africa",
    color: "#2196F3",
    url: "https://nation.africa/kenya/rss",
  },
  {
    key: "citizen-sa",
    name: "Citizen SA",
    color: "#FF9800",
    url: "https://citizen.co.za/feed/",
  },
  {
    key: "iol-sa",
    name: "IOL South Africa",
    color: "#9C27B0",
    url: "https://www.iol.co.za/rss",
  },
  {
    key: "mg-sa",
    name: "Mail & Guardian",
    color: "#795548",
    url: "https://mg.co.za/feed/",
  },

  // International youth-focused
  {
    key: "un-youth",
    name: "UN Youth",
    color: "#2196F3",
    url: "https://www.un.org/en/youth/rss.xml",
  },
  {
    key: "africanews",
    name: "Africanews",
    color: "#009688",
    url: "https://www.africanews.com/feed/",
  },
  {
    key: "bbc-africa",
    name: "BBC Africa",
    color: "#B71C1C",
    url: "http://feeds.bbci.co.uk/news/world/africa/rss.xml",
  },
  {
    key: "voa-africa",
    name: "VOA Africa",
    color: "#0D47A1",
    url: "https://www.voanews.com/api/zm",
  },
  {
    key: "aljazeera-africa",
    name: "Al Jazeera Africa",
    color: "#D32F2F",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
  },
];

// ─── Cache config ─────────────────────────────────────────────────────────────
// ✅ CHANGED: 10 minute cache TTL instead of 1 hour
const L1_TTL_MS = 10 * 60 * 1000; // 10 minutes in-memory cache
const L2_ARCHIVE_TTL_SEC = 10 * 60; // 10 minutes MongoDB TTL
const RSS_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // ✅ Refresh RSS every 10 minutes

// ─── L1 in-memory cache ───────────────────────────────────────────────────────
let l1Cache = null;
let l1CachedAt = 0;
let building = false;
let refreshTimer = null;

// ─── MongoDB (L2) ─────────────────────────────────────────────────────────────
let _db = null;

function initNewsArchive(db) {
  _db = db;

  // Ensure indexes exist
  db.collection("news_archive")
    .createIndex({ id: 1 }, { unique: true })
    .catch(() => {});

  db.collection("news_archive")
    .createIndex({ pubDate: -1 })
    .catch(() => {});

  // ✅ TTL index: auto-deletes articles older than 10 minutes
  db.collection("news_archive")
    .createIndex({ archivedAt: 1 }, { expireAfterSeconds: L2_ARCHIVE_TTL_SEC })
    .catch(() => {});

  console.log(
    `[News] Archive initialised with ${L2_ARCHIVE_TTL_SEC / 60}min TTL`,
  );

  // Warm cache on startup
  warmCacheOnStartup();
}

// ─── Startup warm ─────────────────────────────────────────────────────────────
async function warmCacheOnStartup() {
  try {
    const archived = await loadFromArchive(500); // ✅ Increased limit
    if (archived && archived.length > 0) {
      l1Cache = archived;
      l1CachedAt = Date.now();
      console.log(
        `[News] ✅ Warmed L1 from archive (${archived.length} articles)`,
      );
    }
  } catch (e) {
    console.warn("[News] Warm from archive failed:", e.message);
  }

  // Always kick off fresh RSS build
  buildNews().catch((e) =>
    console.warn("[News] Startup RSS build failed:", e.message),
  );

  scheduleRefresh();
}

// ─── 10-minute scheduler ──────────────────────────────────────────────────────
function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    console.log("[News] ⏰ 10-min RSS refresh triggered");
    buildNews().catch((e) =>
      console.warn("[News] Scheduled refresh failed:", e.message),
    );
  }, RSS_REFRESH_INTERVAL_MS);

  if (refreshTimer.unref) refreshTimer.unref();
}

// ─── MongoDB L2 helpers ────────────────────────────────────────────────────────
async function archiveArticles(articles) {
  if (!_db || !articles.length) return;
  try {
    const ops = articles.map((a) => ({
      updateOne: {
        filter: { id: a.id },
        update: { $set: { ...a, archivedAt: new Date() } },
        upsert: true,
      },
    }));
    const result = await _db
      .collection("news_archive")
      .bulkWrite(ops, { ordered: false });

    if (result.upsertedCount > 0) {
      console.log(`[News] 📦 Archived ${result.upsertedCount} new articles`);
    }
  } catch (err) {
    console.warn("[News] Archive write error:", err.message);
  }
}

async function loadFromArchive(limit = 500) {
  // ✅ Increased default limit
  if (!_db) return null;
  try {
    const docs = await _db
      .collection("news_archive")
      .find({}, { projection: { _id: 0 } })
      .sort({ pubDate: -1 })
      .limit(limit)
      .toArray();
    return docs.length > 0 ? docs : null;
  } catch (e) {
    console.warn("[News] Archive read error:", e.message);
    return null;
  }
}

// ─── Browser UA ───────────────────────────────────────────────────────────────
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─── HTTP fetch with redirect follow ─────────────────────────────────────────
function httpsGet(url, timeoutMs = 15000) {
  // ✅ Increased timeout for more sources
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/rss+xml,application/xml,text/xml,*/*",
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

// ─── RSS entity decoder ────────────────────────────────────────────────────────
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

// ─── Thumbnail extractor ───────────────────────────────────────────────────────
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

// ─── ✅ IMPROVED: XML-based RSS parser using xml2js for better extraction ─────
async function parseRSSWithXml2js(xml, source) {
  try {
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
    });

    const items = [];
    const channel = result.rss?.channel || result.feed;
    if (!channel?.item && !channel?.entry) return items;

    const entries = Array.isArray(channel.item || channel.entry)
      ? channel.item || channel.entry
      : [channel.item || channel.entry].filter(Boolean);

    for (const entry of entries) {
      try {
        const title = decodeEntities(entry.title?._ || entry.title || "");
        if (!title) continue;

        const link = entry.link?.href || entry.link?._ || entry.link || "";
        if (!link || !link.startsWith("http")) continue;

        const pubDateRaw =
          entry.pubDate || entry.published || entry.updated || "";
        const pubDate = pubDateRaw
          ? new Date(pubDateRaw).getTime()
          : Date.now();

        const description = decodeEntities(
          entry.description?._ || entry.summary?._ || entry.content?._ || "",
        ).slice(0, 500);

        // ✅ Better ID generation: full URL hash to avoid collisions
        const crypto = require("crypto");
        const urlHash = crypto
          .createHash("md5")
          .update(link)
          .digest("hex")
          .slice(0, 16);
        const id = `${source.key}-${urlHash}`;

        // Extract thumbnail from various RSS formats
        let thumbnail = null;
        if (entry["media:content"]?.url) {
          thumbnail = entry["media:content"].url;
        } else if (entry["media:thumbnail"]?.url) {
          thumbnail = entry["media:thumbnail"].url;
        } else if (entry.enclosure?.url) {
          thumbnail = entry.enclosure.url;
        } else if (entry.content?._) {
          const imgMatch = entry.content._.match(
            /<img[^>]+src=["']([^"']+)["']/i,
          );
          if (imgMatch) thumbnail = imgMatch[1];
        }

        items.push({
          id,
          title,
          link,
          pubDate: isNaN(pubDate) ? Date.now() : pubDate,
          source: source.name,
          sourceColor: source.color,
          sourceKey: source.key,
          thumbnail,
          description,
          fetchedAt: Date.now(),
        });
      } catch (e) {
        console.warn(
          `[News] Parse error for entry in ${source.name}:`,
          e.message,
        );
        continue;
      }
    }

    return items;
  } catch (e) {
    console.warn(`[News] XML parse failed for ${source.name}:`, e.message);
    return [];
  }
}

// ─── Fallback regex parser (if xml2js fails) ──────────────────────────────────
function parseRSSFallback(xml, source) {
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

    const pubM = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const pub = pubM ? pubM[1].trim() : "";
    const ts = pub ? new Date(pub).getTime() : Date.now();

    const descM = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const desc = descM ? decodeEntities(descM[1]).slice(0, 500) : "";

    // ✅ Better ID: full URL hash
    const crypto = require("crypto");
    const urlHash = crypto
      .createHash("md5")
      .update(link)
      .digest("hex")
      .slice(0, 16);
    const id = `${source.key}-${urlHash}`;

    articles.push({
      id,
      title,
      link,
      pubDate: isNaN(ts) ? Date.now() : ts,
      source: source.name,
      sourceColor: source.color,
      sourceKey: source.key,
      thumbnail: extractThumbnail(block),
      description: desc,
      fetchedAt: Date.now(),
    });
  }

  return articles;
}

// ─── Fetch one RSS source ─────────────────────────────────────────────────────
async function fetchSource(source) {
  try {
    const xml = await httpsGet(source.url, 15000);

    // Try xml2js first, fallback to regex
    let items = await parseRSSWithXml2js(xml, source);
    if (items.length === 0) {
      items = parseRSSFallback(xml, source);
    }

    console.log(`[News] ✓ ${source.name}: ${items.length} articles`);
    return items;
  } catch (err) {
    console.warn(`[News] ✗ ${source.name}: ${err.message}`);
    return [];
  }
}

// ─── Build: fetch all RSS → dedupe → archive → update L1 ─────────────────────
async function buildNews() {
  if (building) {
    console.log("[News] Build already in progress, skipping");
    return l1Cache ?? [];
  }

  building = true;
  console.log(`📰 [News] Building RSS feed from ${SOURCES.length} sources…`);
  const startTime = Date.now();

  try {
    // ✅ Fetch in batches to avoid overwhelming servers
    const batchSize = 5;
    const results = [];

    for (let i = 0; i < SOURCES.length; i += batchSize) {
      const batch = SOURCES.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(batch.map(fetchSource));
      results.push(...batchResults);
      // Small delay between batches
      await new Promise((r) => setTimeout(r, 500));
    }

    let freshArticles = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter(Boolean);

    console.log(`[News] Raw fetch: ${freshArticles.length} articles`);

    // ✅ Smarter deduplication: by URL, not just ID
    const urlSeen = new Set();
    freshArticles = freshArticles.filter((a) => {
      if (urlSeen.has(a.link)) return false;
      urlSeen.add(a.link);
      return true;
    });

    console.log(`[News] After dedupe: ${freshArticles.length} unique articles`);

    // L2: Persist fresh articles to MongoDB archive
    await archiveArticles(freshArticles);

    // L2: Load full archive with higher limit
    const archived = await loadFromArchive(500);
    const allArticles = archived ?? freshArticles;

    // Sort newest first
    allArticles.sort((a, b) => b.pubDate - a.pubDate);

    // ✅ Return more articles to frontend (up to 200)
    l1Cache = allArticles.slice(0, 200);
    l1CachedAt = Date.now();

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `✅ [News] Feed ready: ${l1Cache.length} articles in ${duration}s`,
    );
    return l1Cache;
  } finally {
    building = false;
  }
}

// ─── getNews: L1 → L2 → build ─────────────────────────────────────────────────
async function getNews() {
  // L1 hit: in-memory, fresh within 10 minutes
  if (l1Cache && l1Cache.length > 0 && Date.now() - l1CachedAt < L1_TTL_MS) {
    return l1Cache;
  }

  // L2 hit: MongoDB archive
  const archived = await loadFromArchive(500);
  if (archived && archived.length > 0) {
    console.log(`📦 [News] L1 miss → serving ${archived.length} from MongoDB`);
    l1Cache = archived.slice(0, 200);
    l1CachedAt = Date.now();
    // Background RSS refresh
    buildNews().catch((e) =>
      console.warn("[News] Background build:", e.message),
    );
    return l1Cache;
  }

  // Cold start
  console.log("[News] Cold start — blocking RSS build...");
  return buildNews();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/news — main feed
router.get("/", async (_req, res) => {
  try {
    const articles = await getNews();
    res.json({
      success: true,
      count: articles.length,
      cached: Date.now() - l1CachedAt < L1_TTL_MS,
      data: articles,
    });
  } catch (e) {
    console.error("[News] GET / error:", e.message);
    res.status(500).json({
      success: false,
      message: "Failed to load news",
      data: [],
    });
  }
});

// GET /api/news/sources — list available sources (for frontend)
router.get("/sources", (_req, res) => {
  res.json({
    success: true,
    count: SOURCES.length,
    sources: SOURCES.map((s) => ({
      key: s.key,
      name: s.name,
      color: s.color,
    })),
  });
});

// GET /api/news/source/:key — filter by specific source
router.get("/source/:key", async (req, res) => {
  try {
    const { key } = req.params;
    const source = SOURCES.find((s) => s.key === key);

    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Source not found",
      });
    }

    const articles = await getNews();
    const filtered = articles.filter((a) => a.sourceKey === key);

    res.json({
      success: true,
      source: source.name,
      count: filtered.length,
      data: filtered,
    });
  } catch (e) {
    console.error("[News] GET /source/:key error:", e.message);
    res.status(500).json({
      success: false,
      message: "Failed to filter news",
    });
  }
});

// DELETE /api/news/cache — force clear L1 cache
router.delete("/cache", async (_req, res) => {
  l1Cache = null;
  l1CachedAt = 0;
  res.json({
    success: true,
    message: `L1 cache cleared. Next request fetches fresh RSS (10-min TTL).`,
  });
});

// GET /api/news/cache/status — debug info
router.get("/cache/status", async (_req, res) => {
  const count = _db
    ? await _db
        .collection("news_archive")
        .countDocuments()
        .catch(() => 0)
    : 0;

  res.json({
    success: true,
    l1: {
      hit: !!l1Cache && l1Cache.length > 0,
      articles: l1Cache?.length ?? 0,
      ageSeconds: l1Cache ? Math.floor((Date.now() - l1CachedAt) / 1000) : null,
      ttlSeconds: Math.floor(L1_TTL_MS / 1000),
    },
    l2: {
      totalArticles: count,
      ttlMinutes: L2_ARCHIVE_TTL_SEC / 60,
    },
    scheduler: {
      refreshIntervalMinutes: RSS_REFRESH_INTERVAL_MS / 60000,
      building,
      nextRefreshIn: l1CachedAt
        ? Math.max(
            0,
            Math.floor((L1_TTL_MS - (Date.now() - l1CachedAt)) / 1000),
          )
        : 0,
    },
    sources: {
      total: SOURCES.length,
      list: SOURCES.map((s) => ({ name: s.name, key: s.key })),
    },
  });
});

// POST /api/news/refresh — admin force refresh
router.post("/refresh", async (_req, res) => {
  if (building) {
    return res.json({
      success: false,
      message: "Build already in progress",
    });
  }
  buildNews().catch((e) =>
    console.warn("[News] Manual refresh failed:", e.message),
  );
  res.json({
    success: true,
    message: "RSS refresh triggered in background (10-min cycle)",
  });
});

module.exports = { router, initNewsArchive, SOURCES };
