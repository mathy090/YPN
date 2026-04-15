// src/routes/signoutRoutes.js
"use strict";

const express = require("express");
const router = express.Router();

// ── Database Client (lazy singleton) ─────────────────────────────────────────
let _db = null;

function getDB() {
  if (!_db) {
    throw new Error(
      "Database not initialized. Call initSignoutStore(db) first.",
    );
  }
  return _db;
}

// ── Initialization ───────────────────────────────────────────────────────────
function initSignoutStore(db) {
  _db = db;
  console.log("[SignoutRoutes] Initialized with MongoDB");
}

// ── POST /api/auth/signout ───────────────────────────────────────────────────
// Invalidates user's JWT by incrementing tokenVersion in database
// Any existing JWT with old version will fail verification on next request
router.post("/signout", async (req, res) => {
  try {
    const { email, firebase_uid } = req.body;

    // Validate input
    if (!email || !firebase_uid) {
      return res.status(400).json({
        message: "Email and firebase_uid are required",
        code: "MISSING_PARAMS",
      });
    }

    const db = getDB();

    // Find user by firebase_uid (primary identifier)
    const user = await db.collection("users").findOne({ uid: firebase_uid });

    if (!user) {
      // Fallback: try lookup by email if uid not found
      const userByEmail = await db.collection("users").findOne({ email });

      if (!userByEmail) {
        return res.status(404).json({
          message: "User not found",
          code: "USER_NOT_FOUND",
        });
      }
      return invalidateToken(res, userByEmail);
    }

    return invalidateToken(res, user);
  } catch (err) {
    console.error("[/api/auth/signout] Error:", err);
    res.status(500).json({
      message: "Internal server error",
      code: "SERVER_ERROR",
    });
  }
});

// ── Helper: Invalidate Token by Incrementing Version ─────────────────────────
async function invalidateToken(res, user) {
  const db = getDB();

  // Increment tokenVersion - this invalidates ALL existing JWTs for this user
  const result = await db.collection("users").updateOne(
    { uid: user.uid },
    {
      $inc: { tokenVersion: 1 }, // ✅ Increment version
      $set: { lastSignOut: new Date() }, // Track sign-out time for audit
    },
  );

  if (result.matchedCount === 0) {
    return res.status(404).json({
      message: "User not found",
      code: "USER_NOT_FOUND",
    });
  }

  const newVersion = (user.tokenVersion ?? 0) + 1;
  console.log(
    `[Signout] ✅ Invalidated tokens for uid=${user.uid}, version: ${user.tokenVersion ?? 0} → ${newVersion}`,
  );

  res.json({
    success: true,
    message: "Successfully signed out. All sessions invalidated.",
    uid: user.uid,
    newTokenVersion: newVersion,
  });
}

// ── GET /api/auth/signout/status (Debug Endpoint - Remove in Production) ─────
// Returns current tokenVersion for debugging sign-out flow
router.get("/signout/status", async (req, res) => {
  try {
    const { uid } = req.query;

    if (!uid) {
      return res.status(400).json({ message: "uid query parameter required" });
    }

    const db = getDB();
    const user = await db
      .collection("users")
      .findOne(
        { uid },
        { projection: { uid: 1, email: 1, tokenVersion: 1, lastSignOut: 1 } },
      );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      uid: user.uid,
      email: user.email,
      tokenVersion: user.tokenVersion ?? 0,
      lastSignOut: user.lastSignOut || null,
      message:
        "Current token version. Any JWT with older version will be rejected.",
    });
  } catch (err) {
    console.error("[/api/auth/signout/status] Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = {
  router,
  init: initSignoutStore,
};
