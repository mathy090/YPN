// server.js - FIXED & CLARIFIED
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
app.set("trust proxy", 1);
app.use(cors());

// 🔥 Avatar routes: PUBLIC (no auth middleware) - raw body parser MUST come before json()
app.use(
  "/api/avatar",
  express.raw({ type: ["image/*", "application/octet-stream"], limit: "5mb" }),
);
app.use(express.json());

// ── Rate Limiting ───────────────────────────────────────────────────────────
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
app.use("/api/", generalLimiter);

// ── Middleware: Verify Firebase ID Token (for auth-protected endpoints) ─────
// ✅ Used by: POST /api/users/profile, GET /api/auth/check-username
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;

  // 🔥 FIX: Explicitly check for missing/malformed header
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "No authentication token provided",
      code: "NO_TOKEN",
      hint: "Include header: Authorization: Bearer <firebase_id_token>",
    });
  }

  const idToken = authHeader.split("Bearer ")[1];

  // 🔥 FIX: Check for empty token
  if (!idToken || idToken.trim() === "") {
    return res.status(401).json({
      message: "Empty authentication token",
      code: "EMPTY_TOKEN",
    });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken.trim());
    req.user = decodedToken; // { uid, email, name, picture, ... }
    next();
  } catch (err) {
    console.warn("[verifyFirebaseToken] Error:", {
      code: err.code,
      message: err.message,
      tokenPreview: idToken?.substring(0, 30) + "...",
    });

    // 🔥 FIX: Distinguish between expired vs invalid tokens
    if (err.code === "auth/id-token-expired") {
      return res.status(401).json({
        message: "Authentication token expired",
        code: "TOKEN_EXPIRED",
        action: "refresh",
      });
    }

    if (err.code === "auth/argument-error") {
      return res.status(401).json({
        message: "Invalid token format",
        code: "INVALID_TOKEN_FORMAT",
        hint: "Token must be a valid Firebase ID token",
      });
    }

    // Generic invalid token
    return res.status(401).json({
      message: "Invalid authentication token",
      code: "INVALID_TOKEN",
    });
  }
}

// ── Middleware: Verify Backend JWT (for session-protected endpoints) ────────
// ✅ Used by: GET /api/users/profile, POST /api/auth/status
function verifyBackendToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "No session token provided",
      code: "NO_TOKEN",
      hint: "Include header: Authorization: Bearer <backend_jwt>",
    });
  }

  const token = authHeader.split("Bearer ")[1];

  if (!token || token.trim() === "") {
    return res.status(401).json({
      message: "Empty session token",
      code: "EMPTY_TOKEN",
    });
  }

  jwt.verify(
    token.trim(),
    process.env.BACKEND_JWT_SECRET,
    {
      issuer: "ypn-backend",
      audience: "ypn-app",
      clockTolerance: 30,
      algorithms: ["HS256"],
    },
    (err, decoded) => {
      if (err) {
        console.warn("[verifyBackendToken] Error:", {
          name: err.name,
          message: err.message,
        });

        if (err.name === "TokenExpiredError") {
          return res.status(401).json({
            message: "Session token expired",
            code: "TOKEN_EXPIRED",
            action: "refresh",
          });
        }
        if (err.name === "JsonWebTokenError") {
          return res.status(403).json({
            message: "Invalid session token signature",
            code: "INVALID_TOKEN",
          });
        }
        if (err.name === "NotBeforeError") {
          return res.status(401).json({
            message: "Session token not yet valid",
            code: "TOKEN_NOT_YET_VALID",
          });
        }
        return res.status(403).json({
          message: "Invalid session token",
          code: "INVALID_TOKEN",
        });
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
  // ── POST /api/auth/status ─────────────────────────────────────────
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

  // ── POST /api/auth/login ──────────────────────────────────────────
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
        const errorCode = restData.error?.message;
        if (errorCode === "EMAIL_NOT_FOUND") {
          return res
            .status(404)
            .json({ message: "Account not found.", code: "ACCOUNT_NOT_FOUND" });
        }
        if (errorCode === "INVALID_PASSWORD") {
          return res
            .status(401)
            .json({
              message: "Invalid password.",
              code: "INVALID_CREDENTIALS",
            });
        }
        if (errorCode === "USER_DISABLED") {
          return res
            .status(403)
            .json({ message: "Account disabled.", code: "USER_DISABLED" });
        }
        return res
          .status(401)
          .json({
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
      res.status(500).json({ message: "Internal server error." });
    }
  });

  // ── POST /api/auth/refresh ────────────────────────────────────────
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

      let expiresInValue;
      const expiryConfig = process.env.BACKEND_JWT_EXPIRY || "7d";
      expiresInValue =
        typeof expiryConfig === "string" && expiryConfig.includes("d")
          ? parseInt(expiryConfig) * 24 * 60 * 60
          : parseInt(expiryConfig) || 7 * 24 * 60 * 60;

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
  // ✅ AUTH: Firebase ID Token (verifyFirebaseToken)
  app.get("/api/auth/check-username", verifyFirebaseToken, async (req, res) => {
    try {
      const { uid } = req.user;
      const requestedUsername = (req.query.username ?? "")
        .toString()
        .trim()
        .toLowerCase();

      if (!requestedUsername || !/^[a-z0-9_]{3,20}$/.test(requestedUsername)) {
        return res.status(400).json({
          available: false,
          message:
            "Username must be 3-20 chars: letters, numbers, underscores only.",
          code: "INVALID_FORMAT",
        });
      }

      const existingUser = await db
        .collection("users")
        .findOne({ username: requestedUsername }, { projection: { uid: 1 } });

      if (!existingUser) {
        return res.json({ available: true, message: "Username available." });
      }

      if (existingUser.uid === uid) {
        return res.json({ available: true, message: "This is your username." });
      }

      return res.status(409).json({
        available: false,
        message: "Username already taken.",
        code: "USERNAME_TAKEN",
      });
    } catch (err) {
      console.error("[/api/auth/check-username] Error:", err);
      res
        .status(500)
        .json({ message: "Internal server error.", code: "SERVER_ERROR" });
    }
  });

  // ── POST /api/users/profile ─────────────────────────────────────
  // ✅ AUTH: Firebase ID Token (verifyFirebaseToken)
  // 🔥 Key endpoint for profile setup: username (required), avatarUrl (optional)
  app.post("/api/users/profile", verifyFirebaseToken, async (req, res) => {
    try {
      const { uid, email: firebaseEmail } = req.user;
      const { username: rawUsername, avatarUrl } = req.body ?? {};

      const cleanUsername = (rawUsername ?? "").toString().trim().toLowerCase();
      if (!cleanUsername || !/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
        return res.status(400).json({
          code: "INVALID_USERNAME",
          message:
            "Username: 3–20 chars, lowercase letters/numbers/underscores only.",
        });
      }

      const updatePayload = { email: firebaseEmail, updatedAt: new Date() };
      if (avatarUrl !== undefined && avatarUrl !== null) {
        updatePayload.avatarUrl = avatarUrl.toString().trim();
      }

      const currentUser = await db.collection("users").findOne({ uid });

      // First-time profile setup
      if (!currentUser?.username) {
        const result = await db
          .collection("users")
          .findOneAndUpdate(
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

      // Profile exists - username locked
      if (rawUsername && rawUsername.toLowerCase() !== currentUser.username) {
        return res.status(409).json({
          code: "USERNAME_LOCKED",
          message: "Username cannot be changed after initial setup.",
        });
      }

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
  // ✅ AUTH: Backend JWT (verifyBackendToken)
  app.get("/api/users/profile", verifyBackendToken, async (req, res) => {
    try {
      const user = await db
        .collection("users")
        .findOne(
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

  // ── GET /api/users/:username (PUBLIC) ─────────────────────────
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

  // ── Mount Routes ──────────────────────────────────────────────────
  app.use("/api/auth", verifyBackendToken, signoutRoutes);

  // ✅ Avatar routes: PUBLIC (no auth middleware)
  app.use("/api/avatar", avatarRoutes);

  app.use("/api/videos/drive", driveVideoRoutes);
  app.use("/api/videos", videoRoutes);
  app.use("/api/discord", discordRoutes);
  app.use("/api/news", newsRoutes);
  app.use("/api/keys", verifyBackendToken, keyRoutes);
  app.use("/api/media", verifyBackendToken, mediaRoutes);

  // 404 Handler
  app.use((_req, res) =>
    res.status(404).json({ message: "Not found", code: "NOT_FOUND" }),
  );
}

// ── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;

connectDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 YPN Backend running on port ${PORT}`);
    console.log(`🔐 Auth endpoints use Firebase ID tokens`);
    console.log(`🔐 Session endpoints use Backend JWT tokens`);
    console.log(`🌐 Avatar endpoint is PUBLIC (no auth)`);
  });
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("🛑 Shutting down gracefully...");
  await client.close();
  process.exit(0);
});
