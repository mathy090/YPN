// server.js
"use strict";
require("dotenv").config();

const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
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
const avatarRoutes = require("./src/routes/avatarRoutes");

// 🔥 NEW: Import sign-out routes
const {
  router: signoutRoutes,
  init: initSignoutStore,
} = require("./src/routes/signoutRoutes");

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
// ✅ REMOVED AUTH: Avatar routes are now public
app.use(
  "/api/avatar",
  express.raw({ type: ["image/*", "application/octet-stream"], limit: "5mb" }),
);

// Apply JSON parsing to all other routes
app.use(express.json());

// ── 🔥 Rate Limiting Configuration ──────────────────────────────────────────
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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { status: 429, message: "Too many authentication attempts." },
  skipSuccessfulRequests: true,
});

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
      clockTolerance: 30,
      algorithms: ["HS256"],
    },
    (err, decoded) => {
      if (err) {
        if (err.name === "TokenExpiredError") {
          return res.status(401).json({
            message: "Token expired. Please sign in again.",
            code: "TOKEN_EXPIRED",
          });
        }
        if (err.name === "JsonWebTokenError") {
          return res.status(403).json({
            message: "Invalid token signature or format.",
            code: "INVALID_TOKEN",
          });
        }
        if (err.name === "NotBeforeError") {
          return res.status(401).json({
            message: "Token not yet valid.",
            code: "TOKEN_NOT_YET_VALID",
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
    initSignoutStore(db);

    registerRoutes();
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

// ── Route Definitions ────────────────────────────────────────────────────────
function registerRoutes() {
  // ── POST /api/auth/status (Heartbeat/Presence) ────────────────────
  app.post("/api/auth/status", verifyBackendToken, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { status } = req.body;

      await db.collection("users").updateOne(
        { uid: userId },
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

      // Upsert user document - simplified schema: uid, email, username, avatarUrl
      await db.collection("users").updateOne(
        { uid },
        {
          $set: { uid, email: userRecord.email, updatedAt: new Date() },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );

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

  // ── POST /api/auth/refresh (Hybrid Auth) ───────────────────────────────
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

      const userProfile = await db.collection("users").findOne(
        { uid },
        {
          projection: {
            username: 1,
          },
        },
      );

      let expiresInValue;
      const expiryConfig = process.env.BACKEND_JWT_EXPIRY || "7d";

      if (typeof expiryConfig === "string" && expiryConfig.includes("d")) {
        expiresInValue = parseInt(expiryConfig) * 24 * 60 * 60;
      } else {
        expiresInValue = parseInt(expiryConfig) || 7 * 24 * 60 * 60;
      }

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
          expiresIn: expiresInValue,
          issuer: "ypn-backend",
          audience: "ypn-app",
          algorithm: "HS256",
        },
      );

      res.json({
        backend_jwt: backendJwt,
        expires_in: expiresInValue,
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

  // ── GET /api/auth/check-username ────────────────────────────────
  // 🔥 NEW: Check username availability with ownership verification
  app.get("/api/auth/check-username", verifyFirebaseToken, async (req, res) => {
    try {
      const { uid } = req.user; // Firebase UID from token
      const requestedUsername = (req.query.username ?? "")
        .toString()
        .trim()
        .toLowerCase();

      if (!requestedUsername || !/^[a-z0-9_]{3,20}$/.test(requestedUsername)) {
        return res.status(400).json({
          available: false,
          message:
            "Username must be 3-20 chars: letters, numbers, underscores only.",
        });
      }

      // 🔍 Check if username exists in DB
      const existingUser = await db
        .collection("users")
        .findOne({ username: requestedUsername }, { projection: { uid: 1 } });

      if (!existingUser) {
        // ✅ Username doesn't exist → available for anyone
        return res.json({ available: true, message: "Username available." });
      }

      // 🔐 Username exists - check if it belongs to current user
      if (existingUser.uid === uid) {
        return res.json({ available: true, message: "This is your username." });
      } else {
        // ❌ Username taken by another account
        return res.status(409).json({
          available: false,
          message: "Username already taken.",
          code: "USERNAME_TAKEN",
        });
      }
    } catch (err) {
      console.error("[/api/auth/check-username] Error:", err);
      res.status(500).json({ message: "Internal server error." });
    }
  });

  // ── POST /api/users/profile ─────────────────────────────────────
  // 🔥 Simplified: username (required), email (from token), avatarUrl (optional)
  app.post("/api/users/profile", verifyFirebaseToken, async (req, res) => {
    try {
      const { uid, email: firebaseEmail } = req.user; // From Firebase token
      const { username: rawUsername, avatarUrl } = req.body ?? {};

      // 🔥 Validate username format
      const cleanUsername = (rawUsername ?? "").toString().trim().toLowerCase();
      if (!cleanUsername || !/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
        return res.status(400).json({
          code: "INVALID_USERNAME",
          message:
            "Username: 3–20 chars, lowercase letters/numbers/underscores only.",
        });
      }

      // 🔥 Email comes from Firebase token (trusted), not request body
      const updatePayload = {
        email: firebaseEmail,
        updatedAt: new Date(),
      };

      // ✅ Avatar is optional - only update if provided
      if (avatarUrl !== undefined && avatarUrl !== null) {
        updatePayload.avatarUrl = avatarUrl.toString().trim();
      }

      const currentUser = await db.collection("users").findOne({ uid });

      // 🔥 First-time profile setup: set username
      if (!currentUser?.username) {
        // Attempt atomic update with username uniqueness check
        const result = await db.collection("users").findOneAndUpdate(
          {
            uid,
            $or: [{ username: { $exists: false } }, { username: null }],
          },
          {
            $set: {
              ...updatePayload,
              username: cleanUsername,
            },
          },
          {
            returnDocument: "after",
            projection: { username: 1, email: 1, avatarUrl: 1, uid: 1 },
          },
        );

        if (!result?.value) {
          // 🔥 Race condition: check if username was taken by someone else
          const conflict = await db
            .collection("users")
            .findOne(
              { username: cleanUsername, uid: { $ne: uid } },
              { projection: { uid: 1 } },
            );
          if (conflict) {
            return res.status(409).json({
              code: "USERNAME_TAKEN",
              message: "Username already taken by another account.",
            });
          }
          return res
            .status(500)
            .json({
              code: "UPDATE_FAILED",
              message: "Could not create profile.",
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

      // 🔥 Profile already exists - username is locked (cannot be changed)
      if (rawUsername && rawUsername.toLowerCase() !== currentUser.username) {
        return res.status(409).json({
          code: "USERNAME_LOCKED",
          message: "Username cannot be changed after initial setup.",
        });
      }

      // ✅ Update only avatar (if provided) and metadata
      await db.collection("users").updateOne({ uid }, { $set: updatePayload });

      res.json({
        success: true,
        user: {
          uid,
          username: currentUser.username,
          email: firebaseEmail,
          avatarUrl: updatePayload.avatarUrl || currentUser.avatarUrl,
        },
      });
    } catch (err) {
      console.error("[POST /api/users/profile] Error:", err);
      if (err.code === 11000) {
        return res.status(409).json({
          code: "USERNAME_TAKEN",
          message: "Username already exists in database.",
        });
      }
      res
        .status(500)
        .json({ code: "SERVER_ERROR", message: "Internal server error." });
    }
  });

  // ── GET /api/users/profile ─────────────────────────────────────
  // 🔥 Simplified projection: only uid, username, email, avatarUrl
  app.get("/api/users/profile", verifyBackendToken, async (req, res) => {
    try {
      const user = await db.collection("users").findOne(
        { uid: req.user.sub },
        {
          projection: {
            _id: 0,
            uid: 1,
            username: 1,
            email: 1,
            avatarUrl: 1, // ✅ Optional field
          },
        },
      );

      if (!user) {
        return res.status(404).json({ message: "Profile not found" });
      }

      res.json(user);
    } catch (e) {
      console.error("[GET /api/users/profile] Error:", e);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── GET /api/users/search ─────────────────────────────────────
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

  // ── GET /api/users/:username ──────────────────────────────────
  // 🔥 NEW: Get public profile by username
  app.get("/api/users/:username", async (req, res) => {
    try {
      const username = req.params.username.toString().trim().toLowerCase();

      if (!username || !/^[a-z0-9_]{3,20}$/.test(username)) {
        return res.status(400).json({ message: "Invalid username format" });
      }

      const user = await db.collection("users").findOne(
        { username },
        {
          projection: {
            _id: 0,
            uid: 1,
            username: 1,
            avatarUrl: 1,
          },
        },
      );

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json(user);
    } catch (e) {
      console.error("[GET /api/users/:username] Error:", e);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // 🔥 NEW: Mount Sign-Out Routes (protected with backend token)
  app.use("/api/auth", verifyBackendToken, signoutRoutes);

  // ── Mount External Routes ──────────────────────────────────────────────────
  // ✅ REMOVED AUTH: Avatar routes are now public (no verifyBackendToken)
  app.use("/api/avatar", avatarRoutes);

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

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("🛑 Shutting down gracefully...");
  await client.close();
  process.exit(0);
});
