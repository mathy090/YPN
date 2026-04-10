// backend/src/routes/avatarRoutes.js
"use strict";

const express = require("express");
const { google } = require("googleapis");
const stream = require("stream");

const router = express.Router();

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

let _drive = null;

function getDrive() {
  if (_drive) return _drive;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY)
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");

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
  _drive = google.drive({ version: "v3", auth });
  return _drive;
}

// POST /api/avatar
// Headers: Content-Type: image/jpeg|png|webp, Authorization: Bearer <token>
// Body: raw image bytes
// Returns: { avatarUrl: string }
router.post("/", async (req, res) => {
  try {
    const { uid } = req.user;
    const mimeType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);

    if (!ALLOWED_MIME.includes(mimeType)) {
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: "Only JPEG, PNG or WebP photos are allowed.",
      });
    }

    if (contentLength > MAX_BYTES) {
      return res.status(400).json({
        code: "FILE_TOO_LARGE",
        message: "Photo must be under 5 MB.",
      });
    }

    const folderId = process.env.GOOGLE_DRIVE_AVATAR_FOLDER_ID;
    if (!folderId) throw new Error("GOOGLE_DRIVE_AVATAR_FOLDER_ID not set");

    const drive = getDrive();
    const ext = mimeType.split("/")[1] ?? "jpg";
    const filename = `avatar_${uid}_${Date.now()}.${ext}`;

    const passThrough = new stream.PassThrough();
    req.pipe(passThrough);

    const uploaded = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType, body: passThrough },
      fields: "id",
    });

    const fileId = uploaded.data.id;

    // Make publicly readable so the URL works without auth
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    const avatarUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;

    console.log(`[Avatar] uid=${uid} uploaded fileId=${fileId}`);
    res.status(201).json({ avatarUrl });
  } catch (err) {
    console.error("[Avatar] upload error:", err.message);
    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Sorry, this is on our side. Please try again later.",
    });
  }
});

module.exports = router;
