// server.js
"use strict";
require("dotenv").config();

const express = require("express");
const { MongoClient } = require("mongodb");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

// Import Routes
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

// 🔥 Import avatar routes as a plain router (no init function)
const avatarRoutes = require("./src/routes/avatarRoutes");

// ── Firebase Admin Setup ─────────────────────────────────────────────────────
if (!process.env.FIREBASE_ADMIN_KEY) {
  console.error("❌ FIREBASE_ADMIN_KEY not set in environment variables.");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
} catch (err) {
  console.error("❌ FIREBASE_ADMIN_KEY is not valid JSON:", err.message);
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ── Express App Setup ────────────────────────────────────────────────────────
const app = express();

// 🔥 FIX: Trust Render's Proxy (Fixes X-Forwarded-For error)
app.set("trust proxy", 1);

app.use(cors());

// 🔥 IMPORTANT: Apply raw body parsing ONLY to /api/avatar routes BEFORE json()
// This allows avatarRoutes to read raw image buffers
app.use(
  "/api/avatar",
  express.raw({ type: ["image/*", "application/octet-stream"], limit: "5mb" }),
);

// Apply JSON parsing to all other routes
app.use(express.json());

// ── 🔥 Rate Limiting Configuration ──────────────────────────────────────────

// General API Limiter: 100 requests per 15 minutes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict Auth Limiter: 5 attempts per 15 minutes (Prevent brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { status: 429, message: "Too many authentication attempts." },
  skipSuccessfulRequests: true, // Don't count successful logins
});

// Apply General Limiter to all API routes
app.use("/api/", generalLimiter);

// ── Middleware: Verify Firebase Token ────────────────────────────────────────
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "No token provided", code: "NO_TOKEN" });
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
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

// ── Middleware: Verify Backend JWT (Hybrid Auth) ────────────────────────────
function verifyBackendToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "No token provided", code: "NO_TOKEN" });
  }

  const token = authHeader.split("Bearer ")[1];

  jwt.verify(
    token,
    process.env.BACKEND_JWT_SECRET,
    {
      issuer: "ypn-backend",
      audience: "ypn-app",
    },
    (err, decoded) => {
      if (err) {
        if (err.name === "TokenExpiredError") {
          return res.status(401).json({
            message: "Token expired. Please sign in again.",
            code: "TOKEN_EXPIRED",
          });
        }
        return res
          .status(403)
          .json({ message: "Invalid token", code: "INVALID_TOKEN" });
      }
      req.user = decoded; // { sub: firebase_uid, email, role, hasProfile, ... }
      next();
    },
  );
}

// ── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "YPN Backend",
    time: new Date().toISOString(),
  });
});
app.head("/", (_req, res) => res.status(200).end());

// ── MongoDB Connection ───────────────────────────────────────────────────────
const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("ypn_users");
    console.log("✅ Connected to MongoDB");

    // Initialize all modules with db instance
    initUserVideos(db);
    initDiscordChannels(db);
    initKeyStore(db);
    initNewsArchive(db);
    initDriveVideos(db);

    // 🔥 NO init call for avatarRoutes - it handles DB internally via getDB()

    registerRoutes();
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

// ── Route Definitions ────────────────────────────────────────────────────────
function registerRoutes() {
  // ── 🔥 NEW: POST /api/auth/status (Heartbeat/Presence) ────────────────────
  app.post("/api/auth/status", verifyBackendToken, async (req, res) => {
    try {
      const userId = req.user.id; // MongoDB ID from JWT
      const { status } = req.body; // 'online', 'idle', etc.

      await db.collection("users").updateOne(
        { _id: new require("mongodb").ObjectId(userId) },
        {
          $set: {
            lastSeen: new Date(),
            status: status || "online",
          },
        },
      );

      res.json({ success: true, status: status || "online" });
    } catch (err) {
      console.error("[/api/auth/status] Error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── POST /api/auth/login ───────────────────────────────────────────────────
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required." });
    }

    try {
      const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
      if (!FIREBASE_WEB_API_KEY) {
        console.error("❌ FIREBASE_WEB_API_KEY missing");
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
        if (restData.error?.message === "EMAIL_NOT_FOUND") {
          return res
            .status(404)
            .json({ message: "Account not found.", code: "ACCOUNT_NOT_FOUND" });
        }
        if (restData.error?.message === "INVALID_PASSWORD") {
          return res.status(401).json({
            message: "Invalid password.",
            code: "INVALID_CREDENTIALS",
          });
        }
        if (restData.error?.message === "USER_DISABLED") {
          return res
            .status(403)
            .json({ message: "Account disabled.", code: "USER_DISABLED" });
        }
        return res.status(401).json({
          message: "Invalid email or password.",
          code: "INVALID_CREDENTIALS",
        });
      }

      const idToken = restData.idToken;
      const uid = restData.localId;

      const userRecord = await admin.auth().getUser(uid);
      if (!userRecord.emailVerified) {
        return res.status(403).json({
          message: "Email not verified. Please check your inbox.",
          code: "EMAIL_NOT_VERIFIED",
        });
      }

      // Upsert user document
      await db.collection("users").updateOne(
        { uid },
        {
          $set: { uid, email: userRecord.email, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );

      // Check if user has already set a username (profile complete)
      const userProfile = await db
        .collection("users")
        .findOne({ uid }, { projection: { username: 1 } });
      const hasProfile = !!userProfile?.username;

      res.json({
        token: idToken,
        hasProfile,
        user: { uid, email: userRecord.email },
      });
    } catch (err) {
      console.error("[/api/auth/login] Error:", err);
      res.status(500).json({ message: "Internal server error." });
    }
  });

  // ── 🔥 NEW: POST /api/auth/refresh (Hybrid Auth) ───────────────────────────
  app.post("/api/auth/refresh", async (req, res) => {
    const { firebase_id_token } = req.body;

    if (!firebase_id_token) {
      return res
        .status(400)
        .json({ message: "Missing firebase_id_token", code: "MISSING_TOKEN" });
    }

    try {
      // 1. Verify Firebase ID Token
      const decoded = await admin.auth().verifyIdToken(firebase_id_token);
      const { uid, email, name, picture } = decoded;

      // 2. Check MongoDB for profile/roles
      const userProfile = await db
        .collection("users")
        .findOne(
          { uid },
          { projection: { username: 1, role: 1, isBanned: 1, hasProfile: 1 } },
        );

      if (userProfile?.isBanned) {
        return res
          .status(403)
          .json({ message: "Account suspended", code: "ACCOUNT_SUSPENDED" });
      }

      // 3. Issue custom backend JWT with custom claims + expiry
      const backendJwt = jwt.sign(
        {
          sub: uid,
          email,
          name: name || "",
          picture: picture || "",
          role: userProfile?.role || "user",
          hasProfile: !!userProfile?.username,
        },
        process.env.BACKEND_JWT_SECRET,
        {
          expiresIn: process.env.BACKEND_JWT_EXPIRY || "1h",
          issuer: "ypn-backend",
          audience: "ypn-app",
        },
      );

      const expiresIn = parseInt(process.env.BACKEND_JWT_EXPIRY) || 3600;

      res.json({
        backend_jwt: backendJwt,
        expires_in: expiresIn,
        user: {
          uid,
          email,
          name: name || "",
          role: userProfile?.role || "user",
          hasProfile: !!userProfile?.username,
        },
      });
    } catch (err) {
      console.error("[/api/auth/refresh] Error:", err);
      if (
        err.code === "auth/id-token-expired" ||
        err.code === "auth/argument-error"
      ) {
        return res.status(401).json({
          message: "Firebase token expired",
          code: "FIREBASE_TOKEN_EXPIRED",
        });
      }
      res.status(401).json({
        message: "Invalid Firebase token",
        code: "INVALID_FIREBASE_TOKEN",
      });
    }
  });

  // ── GET /api/auth/verify-username-ownership ────────────────────────────────
  app.get(
    "/api/auth/verify-username-ownership",
    verifyFirebaseToken,
    async (req, res) => {
      try {
        const { uid } = req.user;
        const requestedUsername = (req.query.username ?? "")
          .toString()
          .trim()
          .toLowerCase();

        if (!requestedUsername) {
          return res
            .status(400)
            .json({ message: "Username parameter required." });
        }

        const userWithThisName = await db
          .collection("users")
          .findOne({ username: requestedUsername }, { projection: { uid: 1 } });

        if (!userWithThisName) {
          return res.json({ owned: true, message: "Username available." });
        }

        if (userWithThisName.uid === uid) {
          return res.json({ owned: true, message: "Username verified." });
        } else {
          return res.status(403).json({
            owned: false,
            message: "This username belongs to another account.",
            code: "NOT_OWNER",
          });
        }
      } catch (err) {
        console.error("[verify-ownership]", err);
        res.status(500).json({ message: "Internal server error." });
      }
    },
  );

  // ── POST /api/users/profile ────────────────────────────────────────────────
  app.post("/api/users/profile", verifyFirebaseToken, async (req, res) => {
    try {
      const { uid, email } = req.user;
      const { name, username: rawUsername, avatarUrl } = req.body ?? {};

      if (!name?.trim()) {
        return res
          .status(400)
          .json({ code: "MISSING_NAME", message: "Name is required." });
      }

      const cleanUsername = (rawUsername ?? "").toString().trim().toLowerCase();
      if (!cleanUsername || !/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
        return res.status(400).json({
          code: "INVALID_USERNAME",
          message: "3–20 characters. Letters, numbers, underscores only.",
        });
      }

      const updatePayload = {
        name: name.trim(),
        email,
        updatedAt: new Date(),
      };

      if (avatarUrl !== undefined) {
        updatePayload.avatarUrl = avatarUrl;
      }

      const currentUser = await db.collection("users").findOne({ uid });
      if (!currentUser) {
        return res
          .status(404)
          .json({ code: "USER_NOT_FOUND", message: "User not found." });
      }

      if (!currentUser.username) {
        const result = await db.collection("users").findOneAndUpdate(
          { uid, username: { $exists: false } },
          {
            $set: {
              ...updatePayload,
              username: cleanUsername,
              hasProfile: true,
            },
          },
          { returnDocument: "after" },
        );

        if (!result) {
          return res
            .status(409)
            .json({ code: "USERNAME_TAKEN", message: "Username taken." });
        }
      } else {
        if (rawUsername && rawUsername.toLowerCase() !== currentUser.username) {
          return res.status(409).json({
            code: "USERNAME_LOCKED",
            message: "Username cannot be changed once set.",
          });
        }

        await db
          .collection("users")
          .updateOne({ uid }, { $set: updatePayload });
      }

      res.json({ success: true });
    } catch (err) {
      console.error("/api/users/profile error:", err);
      if (err.code === 11000) {
        return res
          .status(409)
          .json({ code: "USERNAME_TAKEN", message: "Username already taken." });
      }
      res
        .status(500)
        .json({ code: "SERVER_ERROR", message: "Internal server error." });
    }
  });

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
            avatarUrl: 1,
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
      if (!q || q.length < 2)
        return res.status(400).json({ message: "Query too short" });

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
            projection: { _id: 0, uid: 1, name: 1, username: 1, avatarUrl: 1 },
            limit: 20,
          },
        )
        .toArray();

      res.json(users);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Mount External Routes ──────────────────────────────────────────────────
  // 🔥 Avatar routes: protected + raw body parsing already applied above
  app.use("/api/avatar", verifyBackendToken, avatarRoutes);

  app.use("/api/videos/drive", driveVideoRoutes);
  app.use("/api/videos", videoRoutes);
  app.use("/api/discord", discordRoutes);
  app.use("/api/news", newsRoutes);
  app.use("/api/keys", verifyBackendToken, keyRoutes);
  app.use("/api/media", verifyBackendToken, mediaRoutes);

  // 404 Handler
  app.use((_req, res) => res.status(404).json({ message: "Not found" }));
}

// ── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;

connectDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 YPN Backend running on port ${PORT}`);
  });
});
