// backend/server.js
"use strict";
require("dotenv").config();

const express = require("express");
const { MongoClient, GridFSBucket } = require("mongodb");
const cors = require("cors");
const multer = require("multer");
const { GridFsStorage } = require("multer-gridfs-storage");
const admin = require("firebase-admin");

/* =====================
   Firebase Admin SDK
   Credentials live in FIREBASE_ADMIN_KEY env var (JSON string).
   Never commit the key file — use .env locally, Render dashboard in prod.
===================== */
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

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/* =====================
   Express
===================== */
const app = express();
app.use(cors());
app.use(express.json());

/* =====================
   Auth Middleware
   Usage: router.get('/protected', verifyFirebaseToken, handler)
   Sets req.user = decoded Firebase token payload
   { uid, email, email_verified, name, picture, ... }
===================== */
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("Token verification failed:", err.code, err.message);

    if (err.code === "auth/id-token-expired") {
      return res.status(401).json({
        message: "Token expired. Please sign in again.",
        code: "TOKEN_EXPIRED",
      });
    }
    return res.status(401).json({
      message: "Unauthorized: Invalid token",
      code: "INVALID_TOKEN",
    });
  }
}

/* =====================
   Health Check
===================== */
app.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "YPN Backend",
    time: new Date().toISOString(),
  });
});

/* =====================
   MongoDB Setup
===================== */
const client = new MongoClient(process.env.MONGO_URI);
let db;
let bucket;
let upload; // Multer upload initialized after DB connects

async function connectDB() {
  await client.connect();
  db = client.db("ypn_users");
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
}

connectDB().catch((err) => {
  console.error("❌ MongoDB connection failed:", err.message);
  process.exit(1);
});

/* =====================
   POST /api/auth/verify
   ─────────────────────
   Flow:
     1. Client signs in via Firebase SDK → gets ID token
     2. Client POSTs here with  Authorization: Bearer <idToken>
     3. We verify with Admin SDK  (not a JWT library — Admin SDK handles rotation, revocation)
     4. We enforce email_verified
     5. We upsert the user in MongoDB
     6. We return { uid, email, hasProfile }
   
   The client stores the raw Firebase ID token in SecureStore and
   sends it on every subsequent request. No second JWT is needed.
===================== */
app.post("/api/auth/verify", verifyFirebaseToken, async (req, res) => {
  try {
    const { uid, email, email_verified, name } = req.user;

    // Enforce email verification
    if (!email_verified) {
      return res.status(403).json({
        message: "Please verify your email before signing in.",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    // Upsert user document
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

    const user = result; // findOneAndUpdate with returnDocument:'after' returns the doc
    const hasProfile = !!user?.name?.trim();

    res.json({ uid, email, hasProfile });
  } catch (err) {
    console.error("/api/auth/verify error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/* =====================
   POST /api/users/profile
   ─────────────────────
   Create / update the user's display name and optional photo.
   Protected: must send Authorization: Bearer <firebase_id_token>
   
   Body (multipart/form-data):
     name   — string (required)
     photo  — file   (optional)
===================== */
app.post("/api/users/profile", verifyFirebaseToken, (req, res) => {
  if (!upload) {
    return res
      .status(503)
      .json({ message: "Server still starting, try again shortly." });
  }

  upload.single("photo")(req, res, async (err) => {
    if (err) return res.status(500).json({ message: err.message });

    try {
      const { uid } = req.user;
      const { name } = req.body;

      if (!name?.trim()) {
        return res.status(400).json({ message: "name is required" });
      }

      await db.collection("users").updateOne(
        { uid },
        {
          $set: {
            name: name.trim(),
            hasProfile: true,
            updatedAt: new Date(),
            ...(req.file ? { photoPath: `/photos/${req.file.filename}` } : {}),
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

/* =====================
   GET /api/users/profile
   Protected — returns the logged-in user's profile.
===================== */
app.get("/api/users/profile", verifyFirebaseToken, async (req, res) => {
  try {
    const user = await db
      .collection("users")
      .findOne(
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

/* =====================
   GET /photos/:filename
   Stream a GridFS photo.
===================== */
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

/* =====================
   Start Server
===================== */
const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => console.log(`🚀 YPN backend running on port ${PORT}`));
