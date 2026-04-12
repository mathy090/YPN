// backend/src/routes/newsRoutes.js (DIAGNOSTIC VERSION)
// ... [keep all imports and SOURCES array the same] ...

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_ARTICLES = 100;
const L1_TTL = 10 * 60 * 1000; // 10 min

// ─── L1 in-memory cache ───────────────────────────────────────────────────────
let l1Cache = null;
let l1CachedAt = 0;
let building = false;

// ─── MongoDB accumulation ─────────────────────────────────────────────────────
let _db = null;

function initNewsArchive(db) {
  _db = db;
  // ... [keep index creation same] ...
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
      console.log(
        `[News] 🗄️ Archived ${result.upsertedCount} NEW articles to MongoDB`,
      );
    }
  } catch (err) {
    console.error("[News] Archive write error:", err.message);
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
    console.log(
      `[News] 📦 Loaded ${docs.length} articles from MongoDB archive`,
    );
    return docs.length > 0 ? docs : null;
  } catch (err) {
    console.error("[News] Archive read error:", err.message);
    return null;
  }
}

// ... [keep httpsGet, decodeEntities, extractThumbnail, decodeGoogleNewsUrl same] ...

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

    // ✅ Relaxed ID: source + URL fingerprint + full timestamp (not just date)
    const urlFp = Buffer.from(link).toString("base64").slice(0, 16);
    const id = `${source.key}-${urlFp}-${ts}`; // ✅ Use full timestamp, not just date

    articles.push({
      id,
      title,
      link,
      pubDate: isNaN(ts) ? Date.now() : ts,
      source: source.name,
      sourceColor: source.color,
      thumbnail: extractThumbnail(block),
      description: desc,
      _urlFp: urlFp, // Keep for debugging
    });
  }
  return articles;
}

async function fetchSource(source) {
  try {
    const xml = await httpsGet(source.url, 12000);
    const items = parseRSS(xml, source);
    console.log(`[News] ✓ ${source.name}: ${items.length} articles parsed`);
    return items;
  } catch (err) {
    console.warn(`[News] ✗ ${source.name} (${source.key}): ${err.message}`);
    return [];
  }
}

// ✅ Relaxed deduplication: URL + timestamp + source
function dedupeArticles(articles) {
  const seen = new Map();
  return articles.filter((article) => {
    // ✅ Use FULL timestamp (not just date) to allow same story at different times
    const key = `${article._urlFp}_${article.pubDate}_${article.source}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

// ✅ Smart merge: combine archive + fresh without losing diversity
function mergeArticles(archived, fresh) {
  if (!archived?.length) return fresh || [];
  if (!fresh?.length) return archived;

  const archivedIds = new Set(archived.map((a) => a.id));
  const merged = [...archived];

  for (const article of fresh) {
    if (!archivedIds.has(article.id)) {
      merged.push(article);
    }
  }

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
    // 1. Fetch all sources
    const results = await Promise.allSettled(SOURCES.map(fetchSource));
    const rawCounts = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value.length);
    const totalRaw = rawCounts.reduce((a, b) => a + b, 0);

    console.log(`[News] 📊 Raw articles fetched: ${totalRaw}`);

    let freshArticles = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter(Boolean);

    console.log(`[News] 📊 After parsing: ${freshArticles.length} articles`);

    // 2. Relaxed deduplication
    const beforeDedupe = freshArticles.length;
    freshArticles = dedupeArticles(freshArticles);
    console.log(
      `[News] 📊 After relaxed dedupe: ${freshArticles.length} articles (removed ${beforeDedupe - freshArticles.length})`,
    );

    if (freshArticles.length > 0) {
      // 3. Archive new articles
      await archiveArticles(freshArticles);

      // 4. Load archive
      const archived = await loadFromArchive(MAX_ARTICLES);

      // 5. Smart merge
      const beforeMerge = (archived?.length || 0) + freshArticles.length;
      const allArticles = mergeArticles(archived, freshArticles);
      console.log(
        `[News] 📊 After merge: ${allArticles.length} articles (from ${beforeMerge} total)`,
      );

      // 6. Sort and limit
      allArticles.sort((a, b) => b.pubDate - a.pubDate);
      const limited = allArticles.slice(0, MAX_ARTICLES);

      console.log(`✅ News ready: ${limited.length} total articles`);
      console.log(
        `🔍 Sample article IDs: ${limited
          .slice(0, 3)
          .map((a) => a.id)
          .join(", ")}`,
      );

      l1Cache = limited;
      l1CachedAt = Date.now();
      return limited;
    } else {
      console.warn(
        "[News] ⚠️ All RSS sources returned no articles — using archive fallback",
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
  if (
    !forceRefresh &&
    l1Cache &&
    l1Cache.length > 0 &&
    Date.now() - l1CachedAt < L1_TTL
  ) {
    console.log(`[News] 🎯 Serving from L1 cache (${l1Cache.length} articles)`);
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

  console.log(`🔄 Building fresh news (forceRefresh=${forceRefresh})`);
  return buildNews();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    console.log(`[News] GET /api/news (refresh=${forceRefresh})`);

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

// ... [keep delete/cache/status routes same] ...

module.exports = { router, initNewsArchive };
