// server.js
"use strict";
require("dotenv").config();

const express = require("express");
const { MongoClient } = require("mongodb");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

// Route imports
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
  SOURCES, // ✅ Expose sources list for health checks
} = require("./src/routes/newsRoutes");
const mediaRoutes = require("./src/routes/mediaRoutes");
const avatarRoutes = require("./src/routes/avatarRoutes");
const updateAvatarRoutes = require("./src/routes/updateAvatarRoutes");
const {
  router: signoutRoutes,
  init: initSignoutStore,
} = require("./src/routes/signoutRoutes");

// ── Firebase Admin Setup ─────────────────────────────────────────────────────
if (!process.env.FIREBASE_ADMIN_KEY) {
  console.error("❌ FIREBASE_ADMIN_KEY not set");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
} catch (err) {
  console.error("❌ FIREBASE_ADMIN_KEY invalid JSON:", err.message);
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ── Express Setup ───────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

// ── Global DB Injection Middleware ──────────────────────────────────────────
let db;

app.use((req, _res, next) => {
  if (db) req.app.set("db", db);
  next();
});

// ── Rate Limiting ───────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { status: 429, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", generalLimiter);

// ── Health Check ────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "YPN Backend",
    time: new Date().toISOString(),
    news: {
      sources: SOURCES?.length ?? 0,
      ttlMinutes: 10, // ✅ Document the 10-min cache TTL
    },
  });
});
app.head("/", (_req, res) => res.status(200).end());

// ── MongoDB Connection ──────────────────────────────────────────────────────
const client = new MongoClient(process.env.MONGO_URI);

async function connectDB() {
  try {
    await client.connect();
    db = client.db("ypn_users");
    console.log("✅ Connected to MongoDB");

    // Initialize all modules with db instance
    initUserVideos(db);
    initDiscordChannels(db);
    initKeyStore(db);
    initNewsArchive(db); // ✅ News archive: 10-min TTL, 30+ sources
    initDriveVideos(db);
    initSignoutStore(db);

    registerRoutes();
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

// ── Route Registration ──────────────────────────────────────────────────────
function registerRoutes() {
  // ── Protected: Auth status ───────────────────────────────────────────────
  app.post("/api/auth/status", verifyBackendToken, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { status } = req.body;
      await db
        .collection("users")
        .updateOne(
          { uid: userId },
          { $set: { lastSeen: new Date(), status: status || "online" } },
        );
      res.json({ success: true, status: status || "online" });
    } catch (err) {
      console.error("[/api/auth/status] Error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Public: Login ─────────────────────────────────────────────────────────
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }
    try {
      const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
      if (!FIREBASE_WEB_API_KEY) {
        console.error("❌ FIREBASE_WEB_API_KEY missing");
        return res.status(500).json({ message: "Server config error" });
      }
      const restUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`;
      const restResponse = await fetch(restUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      const restData = await restResponse.json();
      if (!restResponse.ok) {
        const errorCode = restData.error?.message;
        if (errorCode === "EMAIL_NOT_FOUND") {
          return res
            .status(404)
            .json({ message: "Account not found", code: "ACCOUNT_NOT_FOUND" });
        }
        if (errorCode === "INVALID_PASSWORD") {
          return res
            .status(401)
            .json({ message: "Invalid password", code: "INVALID_CREDENTIALS" });
        }
        if (errorCode === "USER_DISABLED") {
          return res
            .status(403)
            .json({ message: "Account disabled", code: "USER_DISABLED" });
        }
        return res.status(401).json({
          message: "Invalid credentials",
          code: "INVALID_CREDENTIALS",
        });
      }
      const idToken = restData.idToken;
      const uid = restData.localId;
      const userRecord = await admin.auth().getUser(uid);
      if (!userRecord.emailVerified) {
        return res
          .status(403)
          .json({ message: "Email not verified", code: "EMAIL_NOT_VERIFIED" });
      }
      await db.collection("users").updateOne(
        { uid },
        {
          $set: { uid, email: userRecord.email, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
      const userProfile = await db
        .collection("users")
        .findOne({ uid }, { projection: { username: 1 } });
      res.json({
        token: idToken,
        hasProfile: !!userProfile?.username,
        user: { uid, email: userRecord.email },
      });
    } catch (err) {
      console.error("[/api/auth/login] Error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Public: Refresh ───────────────────────────────────────────────────────
  app.post("/api/auth/refresh", async (req, res) => {
    const { firebase_id_token } = req.body;
    if (!firebase_id_token) {
      return res
        .status(400)
        .json({ message: "Missing firebase_id_token", code: "MISSING_TOKEN" });
    }
    try {
      const decoded = await admin.auth().verifyIdToken(firebase_id_token);
      const { uid, email, name, picture } = decoded;
      const userProfile = await db
        .collection("users")
        .findOne({ uid }, { projection: { username: 1 } });
      const EXPIRY_SECONDS = 7 * 24 * 60 * 60;
      const backendJwt = jwt.sign(
        {
          sub: uid,
          email,
          name: name || "",
          picture: picture || "",
          hasProfile: !!userProfile?.username,
        },
        process.env.BACKEND_JWT_SECRET,
        {
          expiresIn: EXPIRY_SECONDS,
          issuer: "ypn-backend",
          audience: "ypn-app",
          algorithm: "HS256",
        },
      );
      res.json({
        backend_jwt: backendJwt,
        expires_in: EXPIRY_SECONDS,
        exp: Math.floor(Date.now() / 1000) + EXPIRY_SECONDS,
        user: {
          uid,
          email,
          name: name || "",
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

  // ── Public: Username check (onboarding) ───────────────────────────────────
  app.get("/api/auth/check-username", async (req, res) => {
    try {
      const requestedUsername = (req.query.username ?? "")
        .toString()
        .trim()
        .toLowerCase();
      if (!requestedUsername || !/^[a-z0-9_]{3,20}$/.test(requestedUsername)) {
        return res.status(400).json({
          available: false,
          message:
            "Username must be 3-20 chars: letters, numbers, underscores only",
          code: "INVALID_FORMAT",
        });
      }
      const existingUser = await db
        .collection("users")
        .findOne({ username: requestedUsername }, { projection: { uid: 1 } });
      if (!existingUser) {
        return res.json({ available: true, message: "Username available" });
      }
      return res.status(409).json({
        available: false,
        message: "Username already taken",
        code: "USERNAME_TAKEN",
      });
    } catch (err) {
      console.error("[/api/auth/check-username] Error:", err);
      res
        .status(500)
        .json({ message: "Internal server error", code: "SERVER_ERROR" });
    }
  });

  // ── Public: Profile creation (onboarding) ─────────────────────────────────
  app.post("/api/users/profile", async (req, res) => {
    try {
      const {
        uid,
        email,
        username: rawUsername,
        avatarUrl,
        name,
      } = req.body ?? {};
      if (!uid || !email) {
        return res.status(400).json({
          code: "MISSING_FIELDS",
          message: "uid and email are required",
        });
      }
      const cleanUsername = (rawUsername ?? "").toString().trim().toLowerCase();
      if (!cleanUsername || !/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
        return res.status(400).json({
          code: "INVALID_USERNAME",
          message:
            "Username: 3–20 chars, lowercase letters/numbers/underscores only",
        });
      }
      const updatePayload = { email, updatedAt: new Date() };
      if (avatarUrl !== undefined && avatarUrl !== null) {
        updatePayload.avatarUrl = avatarUrl.toString().trim();
      }
      if (name) {
        updatePayload.name = name.toString().trim();
      }
      const currentUser = await db.collection("users").findOne({ uid });
      if (!currentUser?.username) {
        const result = await db.collection("users").findOneAndUpdate(
          {
            uid,
            $or: [{ username: { $exists: false } }, { username: null }],
          },
          { $set: { ...updatePayload, username: cleanUsername } },
          {
            returnDocument: "after",
            projection: { username: 1, email: 1, avatarUrl: 1, uid: 1 },
          },
        );
        if (!result?.value) {
          const conflict = await db
            .collection("users")
            .findOne(
              { username: cleanUsername, uid: { $ne: uid } },
              { projection: { uid: 1 } },
            );
          if (conflict) {
            return res.status(409).json({
              code: "USERNAME_TAKEN",
              message: "Username already taken by another account",
            });
          }
          return res.status(500).json({
            code: "UPDATE_FAILED",
            message: "Could not create profile",
          });
        }
        return res.status(201).json({
          success: true,
          user: {
            uid: result.value.uid,
            username: result.value.username,
            email: result.value.email,
            avatarUrl: result.value.avatarUrl,
          },
        });
      }
      if (rawUsername && rawUsername.toLowerCase() !== currentUser.username) {
        return res.status(409).json({
          code: "USERNAME_LOCKED",
          message: "Username cannot be changed after initial setup",
        });
      }
      await db.collection("users").updateOne({ uid }, { $set: updatePayload });
      res.json({
        success: true,
        user: {
          uid,
          username: currentUser.username,
          email,
          avatarUrl: updatePayload.avatarUrl || currentUser.avatarUrl,
        },
      });
    } catch (err) {
      console.error("[POST /api/users/profile] Error:", err);
      if (err.code === 11000) {
        return res.status(409).json({
          code: "USERNAME_TAKEN",
          message: "Username already exists in database",
        });
      }
      res
        .status(500)
        .json({ code: "SERVER_ERROR", message: "Internal server error" });
    }
  });

  // ── Protected: Get profile ────────────────────────────────────────────────
  app.get("/api/users/profile", verifyBackendToken, async (req, res) => {
    try {
      const user = await db.collection("users").findOne(
        { uid: req.user.sub },
        {
          projection: { _id: 0, uid: 1, username: 1, email: 1, avatarUrl: 1 },
        },
      );
      if (!user) {
        return res
          .status(404)
          .json({ message: "Profile not found", code: "PROFILE_NOT_FOUND" });
      }
      res.json(user);
    } catch (e) {
      console.error("[GET /api/users/profile] Error:", e);
      res
        .status(500)
        .json({ message: "Internal server error", code: "SERVER_ERROR" });
    }
  });

  // ── Protected: Search users ───────────────────────────────────────────────
  app.get("/api/users/search", verifyBackendToken, async (req, res) => {
    try {
      const q = (req.query.q ?? "").toString().trim();
      if (!q || q.length < 2)
        return res.status(400).json({ message: "Query too short" });
      const users = await db
        .collection("users")
        .find(
          {
            $or: [{ username: { $regex: q, $options: "i" } }],
            uid: { $ne: req.user.sub },
          },
          {
            projection: { _id: 0, uid: 1, username: 1, email: 1, avatarUrl: 1 },
            limit: 20,
          },
        )
        .toArray();
      res.json(users);
    } catch (e) {
      console.error("[/api/users/search] Error:", e);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Public: Get user by username ──────────────────────────────────────────
  app.get("/api/users/:username", async (req, res) => {
    try {
      const username = req.params.username.toString().trim().toLowerCase();
      if (!username || !/^[a-z0-9_]{3,20}$/.test(username)) {
        return res.status(400).json({ message: "Invalid username format" });
      }
      const user = await db
        .collection("users")
        .findOne(
          { username },
          { projection: { _id: 0, uid: 1, username: 1, avatarUrl: 1 } },
        );
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json(user);
    } catch (e) {
      console.error("[GET /api/users/:username] Error:", e);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Route Mounting ────────────────────────────────────────────────────────
  app.use("/api/auth", verifyBackendToken, signoutRoutes);

  // 🔓 OPEN: Onboarding avatar upload
  app.use("/api/avatar", avatarRoutes);

  // 🔓 OPEN: Settings avatar update
  app.use("/api/users/update-avatar", updateAvatarRoutes);

  // 🔓 OPEN: Video routes
  app.use("/api/videos/drive", driveVideoRoutes);
  app.use("/api/videos", videoRoutes);

  // 🔓 OPEN: Discord routes
  app.use("/api/discord", discordRoutes);

  // 🔓 OPEN: News routes (10-min auto-refresh, 30+ sources)
  app.use("/api/news", newsRoutes);

  // 🔐 Protected: Keys and media
  app.use("/api/keys", verifyBackendToken, keyRoutes);
  app.use("/api/media", verifyBackendToken, mediaRoutes);

  // ── 404 Handler ───────────────────────────────────────────────────────────
  app.use((_req, res) =>
    res.status(404).json({ message: "Not found", code: "NOT_FOUND" }),
  );
}

// ── Auth Middleware ─────────────────────────────────────────────────────────
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token", code: "NO_TOKEN" });
  }
  const idToken = authHeader.split("Bearer ")[1];
  if (!idToken || idToken.trim() === "") {
    return res
      .status(401)
      .json({ message: "Empty token", code: "EMPTY_TOKEN" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(idToken.trim());
    req.user = decoded;
    next();
  } catch (err) {
    console.warn("[verifyFirebaseToken] Error:", err.code, err.message);
    if (err.code === "auth/id-token-expired") {
      return res.status(401).json({
        message: "Token expired",
        code: "TOKEN_EXPIRED",
        action: "refresh",
      });
    }
    return res
      .status(401)
      .json({ message: "Invalid token", code: "INVALID_TOKEN" });
  }
}

function verifyBackendToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "No session token", code: "NO_TOKEN" });
  }
  const token = authHeader.split("Bearer ")[1];
  if (!token || token.trim() === "") {
    return res
      .status(401)
      .json({ message: "Empty token", code: "EMPTY_TOKEN" });
  }
  jwt.verify(
    token.trim(),
    process.env.BACKEND_JWT_SECRET,
    {
      issuer: "ypn-backend",
      audience: "ypn-app",
      clockTolerance: 300,
      algorithms: ["HS256"],
    },
    (err, decoded) => {
      if (err) {
        console.warn("[verifyBackendToken] Error:", err.name, err.message);
        if (err.name === "TokenExpiredError") {
          return res.status(401).json({
            message: "Session expired",
            code: "TOKEN_EXPIRED",
            action: "refresh",
          });
        }
        return res
          .status(403)
          .json({ message: "Invalid token", code: "INVALID_TOKEN" });
      }
      req.user = decoded;
      next();
    },
  );
}

// ── Server Startup ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
connectDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 YPN Backend running on port ${PORT}`);
    console.log(`📰 News: ${SOURCES?.length ?? 0} sources, 10-min cache TTL`);
    console.log(
      `🔐 Protected: /api/auth/status, /api/users/profile (GET), /api/keys, /api/media`,
    );
    console.log(
      `🌐 Public: /api/auth/login, /api/auth/refresh, /api/news, /api/avatar`,
    );
  });
});

// ── Graceful Shutdown ───────────────────────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("🛑 Shutting down gracefully...");
  await client.close();
  process.exit(0);
});
