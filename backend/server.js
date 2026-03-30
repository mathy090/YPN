// backend/server.js — updated to use newsRoutes with archive init
"use strict";
require("dotenv").config();

const express = require("express");
const { MongoClient, GridFSBucket } = require("mongodb");
const cors = require("cors");
const multer = require("multer");
const { GridFsStorage } = require("multer-gridfs-storage");
const admin = require("firebase-admin");

const {
  router: keyRoutes,
  init: initKeyStore,
} = require("./src/routes/keyRoutes");
const { init: initUserVideos } = require("./src/models/UserVideos");
const { init: initDiscordChannels } = require("./src/models/DiscordChannels");
const videoRoutes = require("./src/routes/videoRoutes");
const discordRoutes = require("./src/routes/discordRoutes");
const {
  router: driveVideoRoutes,
  initDriveVideos,
} = require("./src/routes/driveVideoRoutes");

const {
  router: newsRoutes,
  initNewsArchive,
} = require("./src/routes/newsRoutes");
const mediaRoutes = require("./src/routes/mediaRoutes");

// ── Firebase Admin ──────────────────────────────────────────────
if (!process.env.FIREBASE_ADMIN_KEY) {
  console.error("❌  FIREBASE_ADMIN_KEY env var is not set. Exiting.");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
} catch {
  console.error("❌  FIREBASE_ADMIN_KEY is not valid JSON. Exiting.");
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ── Express ─────────────────────────────────────────────────────
const app = express();
app.use(cors());
const jsonBody = express.json();

// ── Firebase token middleware ────────────────────────────────────
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "Unauthorized: No token provided", code: "NO_TOKEN" });
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    req.user = await admin.auth().verifyIdToken(idToken);
    next();
  } catch (err) {
    console.error("Token verification failed:", err.code, err.message);
    if (err.code === "auth/id-token-expired") {
      return res.status(401).json({
        message: "Token expired. Please sign in again.",
        code: "TOKEN_EXPIRED",
      });
    }
    return res
      .status(401)
      .json({ message: "Unauthorized: Invalid token", code: "INVALID_TOKEN" });
  }
}

// ── Health check ─────────────────────────────────────────────────
app.get("/", (_req, res) =>
  res.status(200).json({
    status: "ok",
    service: "YPN Backend",
    time: new Date().toISOString(),
  }),
);
app.head("/", (_req, res) => res.status(200).end());

// ── MongoDB ──────────────────────────────────────────────────────
const client = new MongoClient(process.env.MONGO_URI);
let db;
let bucket;
let upload;

async function connectDB() {
  await client.connect();
  db = client.db("ypn_users");

  // Initialise all models
  initUserVideos(db);
  initDiscordChannels(db);
  initKeyStore(db);
  initNewsArchive(db); // ← news archive for historical accumulation

  bucket = new GridFSBucket(db, { bucketName: "photos" });
  console.log("✅ Connected to MongoDB");

  const storage = new GridFsStorage({
    db,
    file: (req) => ({
      bucketName: "photos",
      filename: `${req.user?.uid ?? "user"}_${Date.now()}`,
    }),
  });
  upload = multer({ storage });

  registerRoutes();
}

function registerRoutes() {
  // ── POST /api/auth/verify ──────────────────────────────────────
  app.post(
    "/api/auth/verify",
    jsonBody,
    verifyFirebaseToken,
    async (req, res) => {
      try {
        const { uid, email, email_verified, name } = req.user;
        if (!email_verified) {
          return res.status(403).json({
            message: "Please verify your email before signing in.",
            code: "EMAIL_NOT_VERIFIED",
          });
        }
        const result = await db.collection("users").findOneAndUpdate(
          { uid },
          {
            $set: { uid, email, updatedAt: new Date() },
            $setOnInsert: {
              createdAt: new Date(),
              name: name ?? "",
              hasProfile: false,
            },
          },
          { upsert: true, returnDocument: "after" },
        );
        res.json({ uid, email, hasProfile: !!result?.name?.trim() });
      } catch (err) {
        console.error("/api/auth/verify error:", err);
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ── POST /api/users/profile ────────────────────────────────────
  app.post("/api/users/profile", verifyFirebaseToken, (req, res) => {
    if (!upload)
      return res
        .status(503)
        .json({ message: "Server still starting, try again shortly." });
    upload.single("photo")(req, res, async (err) => {
      if (err) return res.status(500).json({ message: err.message });
      try {
        const { uid } = req.user;
        const { name } = req.body;
        if (!name?.trim())
          return res.status(400).json({ message: "name is required" });
        await db.collection("users").updateOne(
          { uid },
          {
            $set: {
              name: name.trim(),
              hasProfile: true,
              updatedAt: new Date(),
              ...(req.file
                ? { photoPath: `/photos/${req.file.filename}` }
                : {}),
            },
          },
          { upsert: true },
        );
        res.json({ success: true });
      } catch (e) {
        console.error("/api/users/profile POST error:", e);
        res.status(500).json({ message: e.message });
      }
    });
  });

  // ── GET /api/users/profile ─────────────────────────────────────
  app.get("/api/users/profile", verifyFirebaseToken, async (req, res) => {
    try {
      const user = await db.collection("users").findOne(
        { uid: req.user.uid },
        {
          projection: {
            _id: 0,
            uid: 1,
            email: 1,
            name: 1,
            photoPath: 1,
            hasProfile: 1,
          },
        },
      );
      if (!user) return res.status(404).json({ message: "Profile not found" });
      res.json(user);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── GET /photos/:filename ──────────────────────────────────────
  app.get("/photos/:filename", async (req, res) => {
    try {
      const files = await db
        .collection("photos.files")
        .find({ filename: req.params.filename })
        .toArray();
      if (!files.length) return res.status(404).send("File not found");
      bucket.openDownloadStreamByName(req.params.filename).pipe(res);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Feature route groups ───────────────────────────────────────
  app.use("/api/videos", videoRoutes);
  app.use("/api/discord", discordRoutes);
  app.use("/api/news", newsRoutes); // now uses { router: newsRoutes }

  // E2E public key server
  app.use("/api/keys", verifyFirebaseToken, keyRoutes);

  // Google Drive encrypted media proxy
  app.use("/api/media", verifyFirebaseToken, mediaRoutes);

  // 404 catch-all
  app.use((_req, res) => res.status(404).json({ message: "Not found" }));
}

connectDB().catch((err) => {
  console.error("❌ MongoDB connection failed:", err.message);
  process.exit(1);
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => console.log(`🚀 YPN backend running on port ${PORT}`));
