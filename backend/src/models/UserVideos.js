// backend/src/models/UserVideos.js
"use strict";

let _db = null;

function init(db) {
  _db = db;
}

function getDB() {
  if (!_db) throw new Error("UserVideos not initialised — call init(db) first");
  return _db;
}

async function addWatchedVideo(uid, videoId) {
  await getDB()
    .collection("users")
    .updateOne(
      { uid },
      { $addToSet: { watchedVideos: videoId } },
      { upsert: true },
    );
}

async function getWatchedVideos(uid) {
  const user = await getDB()
    .collection("users")
    .findOne({ uid }, { projection: { _id: 0, watchedVideos: 1 } });
  return user?.watchedVideos ?? [];
}

module.exports = { init, addWatchedVideo, getWatchedVideos };
