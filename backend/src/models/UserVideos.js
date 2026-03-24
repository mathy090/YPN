"use strict";
const { MongoClient } = require("mongodb");
const client = new MongoClient(process.env.MONGO_URI);

let db;
async function getDB() {
  if (!db) {
    await client.connect();
    db = client.db("ypn_users");
  }
  return db;
}

async function addWatchedVideo(uid, videoId) {
  const database = await getDB();
  await database
    .collection("users")
    .updateOne(
      { uid },
      { $addToSet: { watchedVideos: videoId } },
      { upsert: true },
    );
}

async function getWatchedVideos(uid) {
  const database = await getDB();
  const user = await database
    .collection("users")
    .findOne({ uid }, { projection: { _id: 0, watchedVideos: 1 } });
  return user?.watchedVideos || [];
}

module.exports = { addWatchedVideo, getWatchedVideos };
