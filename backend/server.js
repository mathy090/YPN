// backend/server.js
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
const avatarRoutes = require("./src/routes/avatarRoutes");

// ── Firebase Admin ────────────────────────────────────────────────────────────
if (!process.env.FIREBASE_ADMIN_KEY) {
  console.error("FIREBASE_ADMIN_KEY not set");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
} catch {
  console.error("FIREBASE_ADMIN_KEY is not valid JSON");
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
const jsonBody = express.json();

// ── Firebase token middleware ─────────────────────────────────────────────────
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "No token provided", code: "NO_TOKEN" });
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    req.user = await admin.auth().verifyIdToken(idToken);
    next();
  } catch (err) {
    if (err.code === "auth/id-token-expired") {
      return res.status(401).json({
        message: "Token expired. Please sign in again.",
        code: "TOKEN_EXPIRED",
      });
    }
    return res
      .status(401)
      .json({ message: "Invalid token", code: "INVALID_TOKEN" });
  }
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) =>
  res.status(200).json({
    status: "ok",
    service: "YPN Backend",
    time: new Date().toISOString(),
  }),
);
app.head("/", (_req, res) => res.status(200).end());

// ── MongoDB ───────────────────────────────────────────────────────────────────
const client = new MongoClient(process.env.MONGO_URI);
let db;
let bucket;
let upload;

async function connectDB() {
  await client.connect();
  db = client.db("ypn_users");

  // Unique sparse index on username — sparse ignores docs without username
  await db
    .collection("users")
    .createIndex({ username: 1 }, { unique: true, sparse: true });

  // Index on email for fast lookup
  await db.collection("users").createIndex({ email: 1 }, { sparse: true });

  // Index on uid for fast lookup
  await db
    .collection("users")
    .createIndex({ uid: 1 }, { unique: true, sparse: true });

  initUserVideos(db);
  initDiscordChannels(db);
  initKeyStore(db);
  initNewsArchive(db);
  initDriveVideos(db);

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
  // ── POST /api/auth/verify ─────────────────────────────────────────────────
  // Called immediately after Firebase sign-in.
  // Returns hasProfile so the client can decide whether to show device.tsx
  // (username setup) or go straight to /tabs/discord.
  // hasProfile is true only when the user already has a username set in MongoDB.
  app.post(
    "/api/auth/verify",
    jsonBody,
    verifyFirebaseToken,
    async (req, res) => {
      try {
        const { uid, email, email_verified } = req.user;

        if (!email_verified) {
          return res.status(403).json({
            message: "Please verify your email before signing in.",
            code: "EMAIL_NOT_VERIFIED",
          });
        }

        // Upsert user doc — create if first time, update timestamp if returning
        const result = await db.collection("users").findOneAndUpdate(
          { uid },
          {
            $set: { uid, email, updatedAt: new Date() },
            $setOnInsert: {
              createdAt: new Date(),
              hasProfile: false,
              username: null,
            },
          },
          { upsert: true, returnDocument: "after" },
        );

        // hasProfile is true only when username has been set
        const hasProfile = !!result?.username;

        res.json({ uid, email, hasProfile });
      } catch (err) {
        console.error("/api/auth/verify error:", err);
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ── GET /api/auth/check-username ──────────────────────────────────────────
  // No auth needed — called before profile is created.
  // Returns { available: boolean, message: string }
  app.get("/api/auth/check-username", async (req, res) => {
    try {
      const raw = (req.query.username ?? "").toString().trim().toLowerCase();

      if (!raw) {
        return res
          .status(400)
          .json({ code: "MISSING", message: "Username required." });
      }

      if (!/^[a-z0-9_]{3,20}$/.test(raw)) {
        return res.status(400).json({
          code: "INVALID_FORMAT",
          message: "3–20 characters. Letters, numbers and underscores only.",
        });
      }

      const existing = await db
        .collection("users")
        .findOne({ username: raw }, { projection: { _id: 1 } });

      if (existing) {
        return res.json({
          available: false,
          message: "Username already taken.",
        });
      }

      res.json({ available: true, message: "Username is available." });
    } catch (err) {
      console.error("[check-username]", err.message);
      res.status(500).json({
        code: "SERVER_ERROR",
        message: "Sorry, this is on our side. Please try again.",
      });
    }
  });

  // ── POST /api/users/profile ───────────────────────────────────────────────
  // Sets username for the first time only. Username is locked after first set.
  // - name field removed entirely
  // - Returns 409 USERNAME_ALREADY_SET if user already has a username
  // - Returns 409 USERNAME_TAKEN if someone else took it (race condition)
  app.post(
    "/api/users/profile",
    verifyFirebaseToken,
    jsonBody,
    async (req, res) => {
      try {
        const { uid } = req.user;

        // ── 1. Check if user already has a username (lock enforcement) ──────
        const existing = await db
          .collection("users")
          .findOne({ uid }, { projection: { username: 1 } });

        if (existing?.username) {
          // Returning user hit this route by mistake — send them to discord
          return res.status(409).json({
            code: "USERNAME_ALREADY_SET",
            message: "Username has already been set and cannot be changed.",
          });
        }

        // ── 2. Destructure and validate body ────────────────────────────────
        const { username, avatarFileId } = req.body ?? {};
        const cleanUsername = (username ?? "").trim().toLowerCase();

        if (!cleanUsername || !/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
          return res.status(400).json({
            code: "INVALID_USERNAME",
            message: "3–20 characters. Letters, numbers and underscores only.",
          });
        }

        // ── 3. Race-condition uniqueness check ──────────────────────────────
        const conflict = await db
          .collection("users")
          .findOne(
            { username: cleanUsername, uid: { $ne: uid } },
            { projection: { _id: 1 } },
          );

        if (conflict) {
          return res.status(409).json({
            code: "USERNAME_TAKEN",
            message: "Username just got taken. Please choose another.",
          });
        }

        // ── 4. Atomic write — username set once, never overwritten ──────────
        await db.collection("users").updateOne(
          { uid },
          {
            $set: {
              username: cleanUsername,
              hasProfile: true,
              updatedAt: new Date(),
              ...(avatarFileId ? { avatarFileId } : {}),
            },
            $setOnInsert: {
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );

        console.log(`[Profile] uid=${uid} username=${cleanUsername} set`);
        res.json({ success: true });
      } catch (err) {
        console.error("/api/users/profile error:", err);

        // MongoDB duplicate key from unique index (race condition)
        if (err.code === 11000) {
          return res.status(409).json({
            code: "USERNAME_TAKEN",
            message: "Username already taken. Please choose another.",
          });
        }

        res.status(500).json({
          code: "SERVER_ERROR",
          message: "Sorry, this is on our side. Please try again later.",
        });
      }
    },
  );

  // ── GET /api/users/profile ────────────────────────────────────────────────
  app.get("/api/users/profile", verifyFirebaseToken, async (req, res) => {
    try {
      const user = await db.collection("users").findOne(
        { uid: req.user.uid },
        {
          projection: {
            _id: 0,
            uid: 1,
            email: 1,
            username: 1,
            avatarFileId: 1,
            hasProfile: 1,
          },
        },
      );

      if (!user) {
        return res.status(404).json({ message: "Profile not found" });
      }

      res.json(user);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/users/search ─────────────────────────────────────────────────
  app.get("/api/users/search", verifyFirebaseToken, async (req, res) => {
    try {
      const q = (req.query.q ?? "").toString().trim();
      if (!q || q.length < 2) {
        return res.status(400).json({ message: "Query too short" });
      }

      const users = await db
        .collection("users")
        .find(
          {
            $or: [{ username: { $regex: q, $options: "i" } }],
            uid: { $ne: req.user.uid },
            hasProfile: true,
          },
          {
            projection: {
              _id: 0,
              uid: 1,
              username: 1,
              avatarFileId: 1,
            },
            limit: 20,
          },
        )
        .toArray();

      res.json(users);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── GET /photos/:filename ─────────────────────────────────────────────────
  app.get("/photos/:filename", async (req, res) => {
    try {
      const files = await db
        .collection("photos.files")
        .find({ filename: req.params.filename })
        .toArray();

      if (!files.length) {
        return res.status(404).send("File not found");
      }

      bucket.openDownloadStreamByName(req.params.filename).pipe(res);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Mounted routers ───────────────────────────────────────────────────────
  app.use("/api/avatar", verifyFirebaseToken, avatarRoutes);
  app.use("/api/videos/drive", verifyFirebaseToken, driveVideoRoutes);
  app.use("/api/videos", videoRoutes);
  app.use("/api/discord", discordRoutes);
  app.use("/api/news", newsRoutes);
  app.use("/api/keys", verifyFirebaseToken, keyRoutes);
  app.use("/api/media", verifyFirebaseToken, mediaRoutes);

  // ── 404 fallback ──────────────────────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ message: "Not found" }));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
connectDB().catch((err) => {
  console.error("MongoDB connection failed:", err.message);
  process.exit(1);
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => console.log(`YPN backend running on port ${PORT}`));
