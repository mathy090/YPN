// backend/server.js
const express = require('express');
const { MongoClient, GridFSBucket } = require('mongodb');
const cors = require('cors');
const multer = require('multer');
const { GridFsStorage } = require('multer-gridfs-storage');

const app = express();

/* =====================
   Middleware
===================== */
app.use(cors());
app.use(express.json());

/* =====================
   Health Check (REQUIRED)
===================== */
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'YPN Backend',
    time: new Date().toISOString(),
  });
});

/* =====================
   MongoDB
===================== */
const uri =
  'mongodb+srv://tafadzwarunowanda_db_user:mathews%23%23%24090@ypn.owiuemn.mongodb.net/?appName=YPN';

const client = new MongoClient(uri);

let db;
let bucket;

async function connectDB() {
  await client.connect();
  db = client.db('ypn_users'); // 🔥 must be Db object
  bucket = new GridFSBucket(db, { bucketName: 'photos' });
  console.log('✅ Connected to MongoDB with GridFSBucket');
}

connectDB().catch(err => {
  console.error('Mongo failed:', err);
});

/* =====================
   Multer GridFS
===================== */
const storage = new GridFsStorage({
  db: db, // pass Db object, not client
  file: (req, file) => ({
    bucketName: 'photos',
    filename: `${req.body.uid || 'user'}_${Date.now()}`,
  }),
});

const upload = multer({ storage });

/* =====================
   AI CHAT ENDPOINT (FIXED)
===================== */
app.post('/ai-response', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // 🔹 TEMP SAFE AI RESPONSE
    res.status(200).json({
      reply: `YPN Team received: ${message}`,
    });
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({
      error: 'AI failed',
    });
  }
});

/* =====================
   Profile Upload
===================== */
app.post('/api/users', upload.single('photo'), async (req, res) => {
  try {
    const { uid, name, email } = req.body;

    const user = {
      uid,
      name,
      email,
      photoPath: req.file ? `/photos/${req.file.filename}` : null,
      createdAt: new Date(),
    };

    const result = await db.collection('profiles').insertOne(user);
    res.json({ success: true, id: result.insertedId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =====================
   Serve Photos (GridFSBucket)
===================== */
app.get('/photos/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    const files = await db.collection('photos.files').find({ filename }).toArray();
    if (!files.length) return res.status(404).send('Not found');

    bucket.openDownloadStreamByName(filename).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =====================
   Start Server
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});
