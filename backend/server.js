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
   Health Check
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
let upload; // multer upload will be initialized after DB connects

async function connectDB() {
  await client.connect();
  db = client.db('ypn_users');
  bucket = new GridFSBucket(db, { bucketName: 'photos' });

  console.log('✅ Connected to MongoDB with GridFSBucket');

  // Initialize multer-gridfs-storage AFTER db is ready
  const storage = new GridFsStorage({
    db: db,
    file: (req, file) => ({
      bucketName: 'photos',
      filename: `${req.body.uid || 'user'}_${Date.now()}`,
    }),
  });

  upload = multer({ storage });
}

connectDB().catch(err => console.error('Mongo failed:', err));

/* =====================
   AI CHAT ENDPOINT
===================== */
app.post('/ai-response', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    res.status(200).json({
      reply: `YPN Team received: ${message}`,
    });
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'AI failed' });
  }
});

/* =====================
   Profile Upload
===================== */
app.post('/api/users', async (req, res) => {
  if (!upload) return res.status(503).send('Server still starting, try again');

  upload.single('photo')(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message });

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
      res.json({ success: true, id: result.insertedId, filename: req.file?.filename || null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

/* =====================
   Serve Photos
===================== */
app.get('/photos/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    const files = await db.collection('photos.files').find({ filename }).toArray();
    if (!files.length) return res.status(404).send('File not found');

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
  console.log(`🚀 Server running on port ${PORT}`);
});

