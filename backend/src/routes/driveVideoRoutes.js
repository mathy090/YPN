// backend/src/routes/driveVideoRoutes.js
"use strict";

const express = require("express");
const { google } = require("googleapis");
const router = express.Router();

// ── Google Drive client (lazy singleton) ──────────────────────────────────────
let _drive = null;

function getDrive() {
  if (_drive) return _drive;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY)
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var not set");
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON");
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  _drive = google.drive({ version: "v3", auth });
  return _drive;
}

// ── L1 in-memory ──────────────────────────────────────────────────────────────
let _l1 = null;
let _l1At = 0;
const L1_TTL = 60 * 60 * 1000; // 1 hour

// ── L2 MongoDB ────────────────────────────────────────────────────────────────
let _db = null;
const COL = "drive_video_cache";
const MKEY = "foryou_drive";
const L2_TTL_SEC = 3600;

function initDriveVideos(db) {
  _db = db;
  db.collection(COL)
    .createIndex({ cachedAt: 1 }, { expireAfterSeconds: L2_TTL_SEC })
    .catch((e) => console.warn("[DriveVideos] TTL index:", e.message));
  console.log("✅ Drive video cache initialised");
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
    console.warn("[DriveVideos] Mongo save:", e.message);
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

// ── Fisher-Yates shuffle ──────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── List all mp4 videos from the Drive folder ─────────────────────────────────
async function listDriveVideos() {
  const drive = getDrive();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID env var not set");

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

  if (!files.length) throw new Error("No videos found in Drive folder");

  return files.map((f) => ({
    fileId: f.id,
    name: f.name,
    mimeType: f.mimeType || "video/mp4",
    size: f.size ? parseInt(f.size, 10) : null,
    thumbnail: f.thumbnailLink || null,
    createdTime: f.createdTime || null,
  }));
}

// ── getManifest: L1 → L2 → Drive API ─────────────────────────────────────────
async function getManifest() {
  // L1 hit
  if (_l1 && Date.now() - _l1At < L1_TTL) return _l1;

  // L2 hit — serve stale, refresh in background
  const l2 = await loadMongo();
  if (l2 && l2.length > 0) {
    console.log(`📦 Drive manifest from MongoDB (${l2.length} videos)`);
    _l1 = l2;
    _l1At = Date.now();
    buildManifest().catch((e) =>
      console.warn("[DriveVideos] bg refresh:", e.message),
    );
    return _l1;
  }

  return buildManifest();
}

let _building = false;
async function buildManifest() {
  if (_building) {
    await new Promise((r) => setTimeout(r, 3000));
    return _l1 ?? [];
  }
  _building = true;
  try {
    console.log("🎬 Building Drive manifest…");
    const files = await listDriveVideos();
    const manifest = shuffle(files);
    _l1 = manifest;
    _l1At = Date.now();
    await saveMongo(manifest);
    console.log(`✅ Drive manifest: ${manifest.length} videos`);
    return manifest;
  } finally {
    _building = false;
  }
}

// ── GET /api/videos/drive/feed ────────────────────────────────────────────────
// Returns shuffled manifest. Auth already verified by middleware in server.js.
router.get("/feed", async (_req, res) => {
  try {
    const manifest = await getManifest();
    res.json(shuffle(manifest)); // fresh shuffle each request
  } catch (e) {
    console.error("[DriveVideos] /feed:", e.message);
    res.status(500).json({ message: e.message });
  }
});

// ── GET /api/videos/drive/stream/:fileId ──────────────────────────────────────
// Proxies raw video bytes with Range support for seeking + iOS.
// Auth already verified by middleware — only authenticated users reach this.
router.get("/stream/:fileId", async (req, res) => {
  const { fileId } = req.params;
  try {
    const drive = getDrive();

    // Fetch file metadata
    const meta = await drive.files.get({
      fileId,
      fields: "id,mimeType,size",
    });

    const mimeType = meta.data.mimeType || "video/mp4";
    const fileSize = meta.data.size ? parseInt(meta.data.size, 10) : null;
    const rangeHeader = req.headers.range;

    if (rangeHeader && fileSize) {
      // Partial content — needed for seeking
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": mimeType,
        "Cache-Control": "private, max-age=3600",
      });

      const stream = await drive.files.get(
        { fileId, alt: "media" },
        {
          responseType: "stream",
          headers: { Range: `bytes=${start}-${end}` },
        },
      );
      stream.data.pipe(res);
    } else {
      // Full file
      const headers = {
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      };
      if (fileSize) headers["Content-Length"] = fileSize;

      res.writeHead(200, headers);

      const stream = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" },
      );
      stream.data.pipe(res);
    }
  } catch (e) {
    console.error(`[DriveVideos] /stream/${fileId}:`, e.message);
    if (!res.headersSent) {
      const status = e.status === 404 ? 404 : 500;
      res.status(status).json({ message: e.message });
    }
  }
});

// ── DELETE /api/videos/drive/cache ───────────────────────────────────────────
router.delete("/cache", async (_req, res) => {
  _l1 = null;
  _l1At = 0;
  if (_db)
    await _db
      .collection(COL)
      .deleteOne({ key: MKEY })
      .catch(() => {});
  res.json({ cleared: true });
});

// ── GET /api/videos/drive/cache/status ───────────────────────────────────────
router.get("/cache/status", async (_req, res) => {
  const l2 = await loadMongo();
  res.json({
    l1: {
      hit: !!_l1,
      videos: _l1?.length ?? 0,
      ageSeconds: _l1 ? Math.floor((Date.now() - _l1At) / 1000) : null,
    },
    l2: { hit: !!l2, videos: l2?.length ?? 0 },
  });
});

module.exports = { router, initDriveVideos };
