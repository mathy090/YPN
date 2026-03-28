// backend/src/routes/keyRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// E2E Key Server — stores ONLY public keys. Server never sees private keys or
// plaintext messages. Keys stored in MongoDB with Firebase UID as identifier.
//
// ENDPOINTS:
//   POST   /api/keys/register   — register/update identity public key
//   GET    /api/keys/:uid       — fetch a user's public key bundle
//   DELETE /api/keys/:uid       — delete keys on account deletion
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const router = express.Router();

let _db = null;

/** Called from server.js after MongoDB connects */
function init(db) {
  _db = db;
  // Index on uid for O(1) lookups
  db.collection("e2e_public_keys")
    .createIndex({ uid: 1 }, { unique: true })
    .catch((e) => console.warn("[KeyServer] Index creation:", e.message));
}

function db() {
  if (!_db)
    throw new Error("[KeyServer] Not initialised — call init(db) first");
  return _db;
}

// ─── POST /api/keys/register ──────────────────────────────────────────────────
// Body: { identityPublicKey: string (SPKI base64) }
// Auth: Firebase token (verifyFirebaseToken middleware applied in server.js)
// Stores public key only — private key never sent.

router.post("/register", async (req, res) => {
  try {
    const { uid, email } = req.user; // set by verifyFirebaseToken middleware
    const { identityPublicKey } = req.body;

    if (!identityPublicKey || typeof identityPublicKey !== "string") {
      return res.status(400).json({
        code: "MISSING_KEY",
        message: "identityPublicKey (SPKI base64) is required",
      });
    }

    // Validate it looks like a base64 string (basic sanity check)
    if (!/^[A-Za-z0-9+/=]+$/.test(identityPublicKey)) {
      return res.status(400).json({
        code: "INVALID_KEY_FORMAT",
        message: "identityPublicKey must be valid base64",
      });
    }

    const now = new Date();
    await db()
      .collection("e2e_public_keys")
      .updateOne(
        { uid },
        {
          $set: {
            uid,
            email,
            identityPublicKey,
            updatedAt: now,
          },
          $setOnInsert: { registeredAt: now },
        },
        { upsert: true },
      );

    console.log(`[KeyServer] Registered public key for uid=${uid}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[KeyServer] /register error:", err.message);
    res.status(500).json({ code: "SERVER_ERROR", message: err.message });
  }
});

// ─── GET /api/keys/:uid ───────────────────────────────────────────────────────
// Returns the public key bundle for any user by UID.
// Auth required — prevents enumeration by unauthenticated callers.

router.get("/:uid", async (req, res) => {
  try {
    const { uid: requestorUid } = req.user;
    const targetUid = req.params.uid;

    if (!targetUid) {
      return res
        .status(400)
        .json({ code: "MISSING_UID", message: "UID required" });
    }

    const record = await db()
      .collection("e2e_public_keys")
      .findOne(
        { uid: targetUid },
        {
          projection: {
            _id: 0,
            uid: 1,
            identityPublicKey: 1,
            updatedAt: 1,
          },
        },
      );

    if (!record) {
      return res.status(404).json({
        code: "KEY_NOT_FOUND",
        message: `No public key registered for uid=${targetUid}. User may not have the app.`,
      });
    }

    console.log(
      `[KeyServer] uid=${requestorUid} fetched public key for uid=${targetUid}`,
    );

    res.json(record);
  } catch (err) {
    console.error("[KeyServer] GET /:uid error:", err.message);
    res.status(500).json({ code: "SERVER_ERROR", message: err.message });
  }
});

// ─── DELETE /api/keys/:uid ────────────────────────────────────────────────────
// Removes key record. Only callable by the key owner.

router.delete("/:uid", async (req, res) => {
  try {
    const { uid } = req.user;
    const targetUid = req.params.uid;

    if (uid !== targetUid) {
      return res.status(403).json({
        code: "FORBIDDEN",
        message: "You can only delete your own keys",
      });
    }

    await db().collection("e2e_public_keys").deleteOne({ uid });
    console.log(`[KeyServer] Deleted public key for uid=${uid}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[KeyServer] DELETE /:uid error:", err.message);
    res.status(500).json({ code: "SERVER_ERROR", message: err.message });
  }
});

module.exports = { router, init };
