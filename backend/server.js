// backend/server.js
const express = require('express');
const { MongoClient, GridFSBucket } = require('mongodb');
const cors = require('cors');
const multer = require('multer');
const { GridFsStorage } = require('multer-gridfs-storage');

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB URI (encoded password is correct ✅)
const uri =
  "mongodb+srv://tafadzwarunowanda_db_user:mathews%23%23%24090@ypn.owiuemn.mongodb.net/ypn_users?retryWrites=true&w=majority";

const client = new MongoClient(uri);

let db;
let gfsBucket;

/* =========================
   CONNECT ONCE
========================= */
async function connectDB() {
  await client.connect();

  db = client.db(); // ✅ native Db
  gfsBucket = new GridFSBucket(db, { bucketName: 'photos' });

  console.log('✅ MongoDB connected with GridFSBucket');
}

connectDB();

/* =========================
   MULTER GRIDFS STORAGE
========================= */
const storage = new GridFsStorage({
  url: uri,
  file: (req, file) => {
    return {
      bucketName: 'photos',
      filename: `${req.body.uid}_${Date.now()}_${file.originalname}`,
    };
  },
});

const upload = multer({ storage });

/* =========================
   SAVE USER PROFILE
========================= */
app.post('/api/users', upload.single('photo'), async (req, res) => {
  try {
    const { uid, name, email } = req.body;

    const photoPath = req.file
      ? `/photos/${req.file.filename}`
      : null;

    const userData = {
      uid,
      name,
      email,
      photoPath,
      createdAt: new Date(),
    };

    const result = await db.collection('profiles').insertOne(userData);

    res.json({
      success: true,
      id: result.insertedId,
      photoPath,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   STREAM PHOTO
========================= */
app.get('/photos/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    const files = await db
      .collection('photos.files')
      .findOne({ filename });

    if (!files) {
      return res.status(404).send('File not found');
    }

    const readStream = gfsBucket.openDownloadStreamByName(filename);
    readStream.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

