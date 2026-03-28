// backend/src/routes/mediaRoutes.js
//
// Google Drive media proxy — the backend acts as a thin authenticated
// proxy so the mobile app never holds a Google service-account key.
//
// Flow:
//   1. POST /api/media/upload  — app sends encrypted blob; server streams
//      it to a shared Google Drive folder and returns the file ID.
//   2. GET  /api/media/:fileId — server fetches the encrypted blob from
//      Drive and streams it back; app decrypts in memory.
//   3. DELETE /api/media/:fileId — server permanently deletes the Drive
//      file (called after recipient marks message as seen).
//
// Security properties:
//   • Server holds a service-account key for Drive access.
//   • Server NEVER sees plaintext — it only stores/retrieves ciphertext.
//   • The AES media key is encrypted by the channel key on the device and
//     stored in Firestore; the server never touches it.
//   • All endpoints require a valid Firebase ID token.

"use strict";

const express = require("express");
const { google } = require("googleapis");
const stream = require("stream");

const router = express.Router();

// ── Google Drive service-account auth ─────────────────────────
// Store the full service-account JSON in GOOGLE_SERVICE_ACCOUNT_KEY
// (same pattern as FIREBASE_ADMIN_KEY — paste the JSON string).
let drive; // googleapis Drive v3 client, initialised lazily

function getDrive() {
  if (drive) return drive;

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var is not set");
  }

  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  drive = google.drive({ version: "v3", auth });
  return drive;
}

// ── Shared Drive folder ────────────────────────────────────────
// Create one folder in your Drive, share it with the service-account
// email (Editor), and paste its ID here (or in env var).
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// ── POST /api/media/upload ─────────────────────────────────────
// Receives a raw encrypted blob (application/octet-stream) from the
// device, streams it directly to Google Drive, returns { fileId }.
//
// The device must set these headers:
//   Content-Type: application/octet-stream
//   X-Media-Mime-Type: <original mime, e.g. image/jpeg>   (optional hint)
//   X-Media-Name: <filename>                              (optional)
router.post("/upload", async (req, res) => {
  try {
    const driveClient = getDrive();
    const uid = req.user.uid;
    const mimeHint =
      req.headers["x-media-mime-type"] ?? "application/octet-stream";
    const nameHint = req.headers["x-media-name"] ?? `${uid}_${Date.now()}.enc`;

    // Pipe the raw request body (encrypted bytes) straight to Drive
    const fileMetadata = {
      name: nameHint,
      parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : [],
    };

    // googleapis expects a readable stream for media.body
    const passThrough = new stream.PassThrough();
    req.pipe(passThrough);

    const response = await driveClient.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: mimeHint,
        body: passThrough,
      },
      fields: "id",
    });

    const fileId = response.data.id;
    console.log(`[Drive] Uploaded encrypted file: ${fileId} for uid=${uid}`);
    res.status(201).json({ fileId });
  } catch (err) {
    console.error("[Drive] /upload error:", err.message);
    res
      .status(500)
      .json({ message: "Upload to Google Drive failed", detail: err.message });
  }
});

// ── GET /api/media/:fileId ─────────────────────────────────────
// Downloads the encrypted blob from Drive and streams it to the device.
// The device decrypts in memory — this endpoint serves ciphertext only.
router.get("/:fileId", async (req, res) => {
  try {
    const driveClient = getDrive();
    const { fileId } = req.params;

    // First fetch file metadata to get the original mime type
    const meta = await driveClient.files.get({
      fileId,
      fields: "id, name, mimeType, size",
    });

    res.setHeader(
      "Content-Type",
      meta.data.mimeType ?? "application/octet-stream",
    );
    if (meta.data.size) res.setHeader("Content-Length", meta.data.size);

    // Stream the encrypted bytes straight to the response
    const fileStream = await driveClient.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" },
    );

    fileStream.data.pipe(res);
  } catch (err) {
    console.error("[Drive] /download error:", err.message);

    // Drive returns 404 for already-deleted ephemeral files — surface cleanly
    if (err.code === 404 || err.status === 404) {
      return res
        .status(404)
        .json({ message: "File not found or already deleted" });
    }
    res.status(500).json({ message: "Download from Google Drive failed" });
  }
});

// ── DELETE /api/media/:fileId ──────────────────────────────────
// Permanently deletes the Drive file.
// Called by the recipient's device immediately after the message is seen
// (ephemeral delete). Also callable by the sender to revoke media.
router.delete("/:fileId", async (req, res) => {
  try {
    const driveClient = getDrive();
    const { fileId } = req.params;

    await driveClient.files.delete({ fileId });

    console.log(`[Drive] Deleted file: ${fileId} by uid=${req.user.uid}`);
    res.json({ deleted: true, fileId });
  } catch (err) {
    console.error("[Drive] /delete error:", err.message);

    // Treat already-gone as success — idempotent delete
    if (err.code === 404 || err.status === 404) {
      return res.json({
        deleted: true,
        fileId: req.params.fileId,
        alreadyGone: true,
      });
    }
    res.status(500).json({ message: "Delete from Google Drive failed" });
  }
});

module.exports = router;
