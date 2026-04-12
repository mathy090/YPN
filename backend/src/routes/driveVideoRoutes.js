// backend/src/routes/driveVideoRoutes.js
"use strict";

const express = require("express");
const { google } = require("googleapis");
const { PassThrough } = require("stream");
const router = express.Router();

// ── Google Drive Client ──────────────────────────────────────────────────────
let _drive = null;
function getDrive() {
  if (_drive) return _drive;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY)
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY missing");

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  _drive = google.drive({ version: "v3", auth });
  return _drive;
}

// ── Caching Layers ───────────────────────────────────────────────────────────
let _db = null;
const COL = "drive_video_cache";
const MKEY = "foryou_drive";
const L2_TTL_SEC = 3600;

// L1 In-Memory Manifest Cache
let _l1Manifest = null;
let _l1ManifestAt = 0;
const L1_TTL = 60 * 60 * 1000; // 1 hour

function initDriveVideos(db) {
  _db = db;
  // Ensure TTL index exists for auto-cleanup
  _db
    .collection(COL)
    .createIndex({ cachedAt: 1 }, { expireAfterSeconds: L2_TTL_SEC })
    .catch((e) => console.warn("[DriveVideos] Index error:", e.message));
  console.log("✅ Drive Video Routes Initialized");
}

async function saveMongo(manifest) {
  if (!_db) return;
  try {
    await _db
      .collection(COL)
      .replaceOne(
        { key: MKEY },
        { key: MKEY, manifest, cachedAt: new Date() },
        { upsert: true },
      );
  } catch (e) {
    console.warn("[DriveVideos] Mongo save failed:", e.message);
  }
}

async function loadMongo() {
  if (!_db) return null;
  try {
    const doc = await _db.collection(COL).findOne({ key: MKEY });
    return doc ? doc.manifest : null;
  } catch {
    return null;
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function listDriveVideos() {
  const drive = getDrive();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID missing");

  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'video/' and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, size, thumbnailLink, createdTime)",
      pageSize: 200,
      pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files.map((f) => ({
    fileId: f.id,
    name: f.name,
    mimeType: f.mimeType || "video/mp4",
    size: f.size ? parseInt(f.size, 10) : null,
    thumbnail: f.thumbnailLink?.replace("s220", "s640") || null, // Request higher res thumb
    createdTime: f.createdTime || null,
  }));
}

async function getManifest() {
  if (_l1Manifest && Date.now() - _l1ManifestAt < L1_TTL) return _l1Manifest;

  const l2 = await loadMongo();
  if (l2 && l2.length > 0) {
    _l1Manifest = l2;
    _l1ManifestAt = Date.now();
    // Background refresh
    buildManifest().catch((e) =>
      console.warn("[DriveVideos] BG refresh failed:", e.message),
    );
    return _l1Manifest;
  }
  return buildManifest();
}

let _building = false;
async function buildManifest() {
  if (_building) return _l1Manifest || [];
  _building = true;
  try {
    console.log("🎬 Building fresh Drive manifest...");
    const files = await listDriveVideos();
    const manifest = shuffle(files);
    _l1Manifest = manifest;
    _l1ManifestAt = Date.now();
    await saveMongo(manifest);
    console.log(`✅ Manifest built: ${manifest.length} videos`);
    return manifest;
  } finally {
    _building = false;
  }
}

// ── GET /feed ────────────────────────────────────────────────────────────────
router.get("/feed", async (_req, res) => {
  try {
    const manifest = await getManifest();
    res.json(shuffle(manifest)); // Re-shuffle for variety on each feed load
  } catch (e) {
    console.error("[Feed] Error:", e.message);
    res.status(500).json({ message: e.message });
  }
});

// ── GET /stream/:fileId (OPTIMIZED FOR STREAMING) ───────────────────────────
router.get("/stream/:fileId", async (req, res) => {
  const { fileId } = req.params;
  const drive = getDrive();

  try {
    // 1. Get Metadata First (Fast)
    const meta = await drive.files.get({
      fileId,
      fields: "id,mimeType,size",
    });

    const mimeType = meta.data.mimeType || "video/mp4";
    const fileSize = meta.data.size ? parseInt(meta.data.size, 10) : 0;
    const rangeHeader = req.headers.range;

    // 2. Handle Range Requests (Crucial for Seeking & iOS)
    if (rangeHeader && fileSize > 0) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": mimeType,
        // Aggressive Caching: Tell phone to cache this chunk for 1 year
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      });

      // 3. Stream with High Water Mark for Buffering
      const stream = await drive.files.get(
        { fileId, alt: "media" },
        {
          responseType: "stream",
          headers: { Range: `bytes=${start}-${end}` },
        },
      );

      // Pipe through a PassThrough to manage backpressure smoothly
      const pass = new PassThrough({ highWaterMark: 1024 * 1024 }); // 1MB buffer
      stream.data.pipe(pass);
      pass.pipe(res);
    } else {
      // Full File Request (Initial Load)
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Content-Length": fileSize,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      });

      const stream = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" },
      );

      const pass = new PassThrough({ highWaterMark: 1024 * 1024 });
      stream.data.pipe(pass);
      pass.pipe(res);
    }
  } catch (e) {
    console.error(`[Stream] Error for ${fileId}:`, e.message);
    if (!res.headersSent) {
      res
        .status(e.status === 404 ? 404 : 500)
        .json({ message: "Stream failed" });
    } else {
      res.end();
    }
  }
});

// ── Cache Management ─────────────────────────────────────────────────────────
router.delete("/cache", async (_req, res) => {
  _l1Manifest = null;
  _l1ManifestAt = 0;
  if (_db) await _db.collection(COL).deleteOne({ key: MKEY });
  res.json({ cleared: true });
});

module.exports = { router, initDriveVideos };
