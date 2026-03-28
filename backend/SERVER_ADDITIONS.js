// ─────────────────────────────────────────────────────────────────────────────
// ADD TO backend/server.js
// These are the additions only — paste into your existing server.js file.
// ─────────────────────────────────────────────────────────────────────────────

// 1. After your existing requires at the top of server.js, add:
const {
  router: keyRoutes,
  init: initKeyStore,
} = require("./src/routes/keyRoutes");

// 2. Inside connectDB(), after initUserVideos(db) and initDiscordChannels(db), add:
//    initKeyStore(db);

// 3. After your existing route mounts (app.use("/api/discord", ...)), add:
//    app.use('/api/keys', verifyFirebaseToken, keyRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE PATCHED connectDB() function — replace yours with this:
// ─────────────────────────────────────────────────────────────────────────────

/*
async function connectDB() {
  await client.connect();
  db = client.db('ypn_users');

  initUserVideos(db);
  initDiscordChannels(db);   // existing
  initKeyStore(db);           // ← NEW: E2E public key store

  bucket = new GridFSBucket(db, { bucketName: 'photos' });
  console.log('✅ Connected to MongoDB');

  const storage = new GridFsStorage({
    db,
    file: (req) => ({
      bucketName: 'photos',
      filename: `${req.user?.uid ?? 'user'}_${Date.now()}`,
    }),
  });
  upload = multer({ storage });
}
*/

// ─────────────────────────────────────────────────────────────────────────────
// FIRESTORE TTL INDEX SETUP
// Run this in Firebase Console → Firestore → Indexes → Single Field
// OR deploy via firebase.json / firestore.indexes.json
// ─────────────────────────────────────────────────────────────────────────────

/*
firestore.indexes.json:

{
  "fieldOverrides": [
    {
      "collectionGroup": "messages",
      "fieldPath": "expireAt",
      "ttl": true,
      "indexes": []
    }
  ]
}

Then run: firebase deploy --only firestore:indexes

This enables Firestore's native TTL deletion on the expireAt field.
Messages are automatically deleted by Firestore — no Cloud Functions needed.
Deletion latency: ~24 hours from expireAt (free tier safe).
For 5-minute messages: client-side deletion on read handles the UX gap.
*/

// ─────────────────────────────────────────────────────────────────────────────
// MONGODB INDEX for key lookups (already in keyRoutes.js init(), shown here for reference)
// ─────────────────────────────────────────────────────────────────────────────

/*
db.collection('e2e_public_keys').createIndex({ uid: 1 }, { unique: true });
*/

// ─────────────────────────────────────────────────────────────────────────────
// FULL ROUTE REGISTRATION BLOCK (add after newsRoutes line in server.js):
// ─────────────────────────────────────────────────────────────────────────────

/*
// E2E Key Server — stores public keys only (private keys never leave device)
const { router: keyRoutes, init: initKeyStore } = require('./src/routes/keyRoutes');
app.use('/api/keys', verifyFirebaseToken, keyRoutes);
// Note: initKeyStore(db) must be called inside connectDB() — see above
*/

// ─────────────────────────────────────────────────────────────────────────────
// ENVIRONMENT VARIABLES — add to .env and Render dashboard:
// ─────────────────────────────────────────────────────────────────────────────

/*
# No new env vars required for the key server.
# It uses the existing:
#   MONGO_URI          — MongoDB connection string
#   FIREBASE_ADMIN_KEY — Firebase Admin SDK JSON
#   JWT_SECRET         — existing JWT secret
#
# Frontend — add to .env.local:
#   EXPO_PUBLIC_API_URL=https://ypn.onrender.com   (already set)
*/

module.exports = {}; // placeholder — this file is documentation, not executable
