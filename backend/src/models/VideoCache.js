// backend/src/models/VideoCache.js
"use strict";
const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URI);
let db;

async function getDB() {
  if (!db) {
    await client.connect();
    db = client.db("ypn_users");
    // TTL index: MongoDB auto-deletes documents older than 3600 seconds (1 hour)
    await db
      .collection("video_cache")
      .createIndex({ cachedAt: 1 }, { expireAfterSeconds: 3600 });
  }
  return db;
}

/**
 * Save the built feed to MongoDB.
 * Upserts a single document with key "foryou".
 */
async function saveFeedCache(videos) {
  const database = await getDB();
  await database
    .collection("video_cache")
    .replaceOne(
      { key: "foryou" },
      { key: "foryou", videos, cachedAt: new Date() },
      { upsert: true },
    );
}

/**
 * Load the cached feed from MongoDB.
 * Returns null if expired (MongoDB TTL will have deleted it) or missing.
 */
async function loadFeedCache() {
  try {
    const database = await getDB();
    const doc = await database
      .collection("video_cache")
      .findOne({ key: "foryou" });
    if (!doc) return null;
    return doc.videos;
  } catch {
    return null;
  }
}

/**
 * Force-clear the cache (admin use).
 */
async function clearFeedCache() {
  const database = await getDB();
  await database.collection("video_cache").deleteOne({ key: "foryou" });
}

module.exports = { saveFeedCache, loadFeedCache, clearFeedCache };
