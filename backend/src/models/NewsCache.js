// backend/src/models/NewsCache.js
"use strict";
const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URI);
let db;

async function getDB() {
  if (!db) {
    await client.connect();
    db = client.db("ypn_users");
    // TTL: MongoDB auto-deletes after 20 minutes
    await db
      .collection("news_cache")
      .createIndex({ cachedAt: 1 }, { expireAfterSeconds: 1200 });
  }
  return db;
}

async function saveNewsCache(articles) {
  const database = await getDB();
  await database
    .collection("news_cache")
    .replaceOne(
      { key: "zw_news" },
      { key: "zw_news", articles, cachedAt: new Date() },
      { upsert: true },
    );
}

async function loadNewsCache() {
  try {
    const database = await getDB();
    const doc = await database
      .collection("news_cache")
      .findOne({ key: "zw_news" });
    return doc ? doc.articles : null;
  } catch {
    return null;
  }
}

async function clearNewsCache() {
  const database = await getDB();
  await database.collection("news_cache").deleteOne({ key: "zw_news" });
}

module.exports = { saveNewsCache, loadNewsCache, clearNewsCache };
