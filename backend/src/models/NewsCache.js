// backend/src/models/NewsCache.js
"use strict";
const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URI);
let db;

// ✅ CHANGED: 10 minute TTL (600 seconds) instead of 20 minutes
const CACHE_TTL_SECONDS = 10 * 60;

async function getDB() {
  if (!db) {
    await client.connect();
    db = client.db("ypn_users");

    // ✅ Create TTL index: auto-delete after 10 minutes
    await db
      .collection("news_cache")
      .createIndex({ cachedAt: 1 }, { expireAfterSeconds: CACHE_TTL_SECONDS });

    // Also index by key for faster lookups
    await db.collection("news_cache").createIndex({ key: 1 }, { unique: true });
  }
  return db;
}

async function saveNewsCache(articles) {
  const database = await getDB();

  // ✅ Update with timestamp for TTL tracking
  await database.collection("news_cache").replaceOne(
    { key: "zw_news" },
    {
      key: "zw_news",
      articles,
      cachedAt: new Date(),
      count: articles.length,
      expiresAt: new Date(Date.now() + CACHE_TTL_SECONDS * 1000),
    },
    { upsert: true },
  );

  console.log(`[NewsCache] ✅ Saved ${articles.length} articles (10-min TTL)`);
}

async function loadNewsCache() {
  try {
    const database = await getDB();
    const doc = await database
      .collection("news_cache")
      .findOne({ key: "zw_news" });

    if (!doc) return null;

    // ✅ Check if cache is still valid (within 10 min)
    const age = Date.now() - doc.cachedAt.getTime();
    if (age > CACHE_TTL_SECONDS * 1000) {
      console.log(
        `[NewsCache] ⏰ Cache expired (${Math.floor(age / 1000)}s old)`,
      );
      return null;
    }

    return doc.articles;
  } catch (e) {
    console.warn("[NewsCache] Load error:", e.message);
    return null;
  }
}

async function clearNewsCache() {
  const database = await getDB();
  const result = await database
    .collection("news_cache")
    .deleteOne({ key: "zw_news" });

  console.log(`[NewsCache] 🗑️ Cleared cache: ${result.deletedCount} doc(s)`);
  return result.deletedCount > 0;
}

// ✅ NEW: Get cache status for monitoring
async function getCacheStatus() {
  try {
    const database = await getDB();
    const doc = await database
      .collection("news_cache")
      .findOne({ key: "zw_news" });

    if (!doc) {
      return { exists: false, ttlMinutes: CACHE_TTL_SECONDS / 60 };
    }

    const age = Date.now() - doc.cachedAt.getTime();
    const remaining = Math.max(0, CACHE_TTL_SECONDS * 1000 - age);

    return {
      exists: true,
      count: doc.count || doc.articles?.length || 0,
      ageSeconds: Math.floor(age / 1000),
      remainingSeconds: Math.floor(remaining / 1000),
      ttlMinutes: CACHE_TTL_SECONDS / 60,
      cachedAt: doc.cachedAt,
      expiresAt: doc.expiresAt,
    };
  } catch (e) {
    console.warn("[NewsCache] Status error:", e.message);
    return { error: e.message, ttlMinutes: CACHE_TTL_SECONDS / 60 };
  }
}

module.exports = {
  saveNewsCache,
  loadNewsCache,
  clearNewsCache,
  getCacheStatus,
  CACHE_TTL_SECONDS,
};
