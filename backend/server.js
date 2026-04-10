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

// ─ Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
const jsonBody = express.json();

// ── Firebase token middleware ────────────────────────────────────────────────
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

  // Unique sparse index on username
  await db
    .collection("users")
    .createIndex({ username: 1 }, { unique: true, sparse: true });

  // Index on email for fast lookup
  await db.collection("users").createIndex({ email: 1 }, { sparse: true });

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
  // ── POST /api/auth/login (NEW) ─────────────────────────────────────────────
  // Handles email/password login via Firebase Admin
  app.post("/api/auth/login", jsonBody, async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required." });
    }

    try {
      // 1. Verify credentials using Firebase REST API (since Admin SDK doesn't have verifyPassword)
      // We use the Web API Key for this specific step
      const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;

      if (!FIREBASE_WEB_API_KEY) {
        console.error("FIREBASE_WEB_API_KEY missing in env");
        return res.status(500).json({ message: "Server configuration error." });
      }

      const restUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`;

      const restResponse = await fetch(restUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      });

      const restData = await restResponse.json();

      if (!restResponse.ok) {
        // Map Firebase errors to our custom codes
        if (restData.error?.message === "EMAIL_NOT_FOUND") {
          return res.status(404).json({
            message: "Account not found.",
            code: "ACCOUNT_NOT_FOUND",
          });
        }
        if (restData.error?.message === "INVALID_PASSWORD") {
          return res.status(401).json({
            message: "Invalid password.",
            code: "INVALID_CREDENTIALS",
          });
        }
        if (restData.error?.message === "USER_DISABLED") {
          return res.status(403).json({
            message: "Account disabled.",
            code: "USER_DISABLED",
          });
        }
        // Default to invalid credentials for other auth errors
        return res.status(401).json({
          message: "Invalid email or password.",
          code: "INVALID_CREDENTIALS",
        });
      }

      const idToken = restData.idToken;
      const uid = restData.localId;

      // 2. Get User Record from Admin SDK to check email verification
      const userRecord = await admin.auth().getUser(uid);

      if (!userRecord.emailVerified) {
        return res.status(403).json({
          message: "Email not verified. Please check your inbox.",
          code: "EMAIL_NOT_VERIFIED",
        });
      }

      // 3. Check if user has a complete profile in MongoDB
      const userProfile = await db.collection("users").findOne({ uid });
      const hasProfile = !!userProfile?.username; // Assuming username defines completion

      // 4. Return Token and Status
      res.json({
        token: idToken,
        hasProfile: hasProfile,
        user: { uid, email: userRecord.email },
      });
    } catch (err) {
      console.error("[/api/auth/login] Error:", err);
      res.status(500).json({ message: "Internal server error." });
    }
  });

  // ── POST /api/auth/verify ──────────────────────────────────────────────────
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
        const result = await db.collection("users").findOneAndUpdate(
          { uid },
          {
            $set: { uid, email, updatedAt: new Date() },
            $setOnInsert: { createdAt: new Date(), hasProfile: false },
          },
          { upsert: true, returnDocument: "after" },
        );
        res.json({ uid, email, hasProfile: !!result?.username });
      } catch (err) {
        console.error("/api/auth/verify error:", err);
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ── GET /api/auth/check-username ───────────────────────────────────────────
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

  // ── POST /api/users/profile ────────────────────────────────────────────────
  app.post(
    "/api/users/profile",
    verifyFirebaseToken,
    jsonBody,
    async (req, res) => {
      try {
        const { uid, email } = req.user;

        // FIX: Removed duplicate 'username' declaration. Extract all needed fields at once.
        const { name, username: rawUsername, avatarFileId } = req.body ?? {};

        if (!name?.trim()) {
          return res
            .status(400)
            .json({ code: "MISSING_NAME", message: "Name is required." });
        }

        const cleanUsername = (rawUsername ?? "")
          .toString()
          .trim()
          .toLowerCase();

        if (!cleanUsername || !/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
          return res.status(400).json({
            code: "INVALID_USERNAME",
            message: "3–20 characters. Letters, numbers and underscores only.",
          });
        }

        // Final race-condition safety check at write time
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

        await db.collection("users").updateOne(
          { uid },
          {
            $set: {
              username: cleanUsername,
              name: name.trim(), // Save the name too
              email,
              ...(avatarFileId ? { avatarFileId } : {}),
              hasProfile: true,
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        );

        res.json({ success: true });
      } catch (err) {
        console.error("/api/users/profile error:", err);
        // Duplicate key from MongoDB (race condition)
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

  // ── GET /api/users/profile ─────────────────────────────────────────────────
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
            username: 1,
            avatarFileId: 1,
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

  // ── GET /api/users/search ──────────────────────────────────────────────────
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
            $or: [
              { name: { $regex: q, $options: "i" } },
              { username: { $regex: q, $options: "i" } },
            ],
            uid: { $ne: req.user.uid },
          },
          {
            projection: {
              _id: 0,
              uid: 1,
              name: 1,
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

  // ─ GET /photos/:filename ──────────────────────────────────────────────────
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

  // ── Routes ─────────────────────────────────────────────────────────────────
  app.use("/api/avatar", verifyFirebaseToken, avatarRoutes);
  app.use("/api/videos/drive", verifyFirebaseToken, driveVideoRoutes);
  app.use("/api/videos", videoRoutes);
  app.use("/api/discord", discordRoutes);
  app.use("/api/news", newsRoutes);
  app.use("/api/keys", verifyFirebaseToken, keyRoutes);
  app.use("/api/media", verifyFirebaseToken, mediaRoutes);

  app.use((_req, res) => res.status(404).json({ message: "Not found" }));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
connectDB().catch((err) => {
  console.error("MongoDB connection failed:", err.message);
  process.exit(1);
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => console.log(`YPN backend running on port ${PORT}`));
