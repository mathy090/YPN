// backend/server.js
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const multer = require('multer');
const { GridFsStorage } = require('multer-gridfs-storage');
const Grid = require('gridfs-stream');

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB connection with encoded password
const uri = "mongodb+srv://tafadzwarunowanda_db_user:mathews%23%23%24090@ypn.owiuemn.mongodb.net/?appName=YPN";
const client = new MongoClient(uri);

let db;
let gfs;

async function connectDB() {
  await client.connect();
  db = client.db('ypn_users');
  gfs = Grid(db, client);
  gfs.collection('photos');
  console.log('Connected to MongoDB');
}

connectDB();

// Multer setup for GridFS
const storage = new GridFsStorage({
  client: client,
  db: 'ypn_users',
  options: {
    bucketName: 'photos'
  },
  filename: (req, file) => {
    return `${req.body.uid}_${Date.now()}`;
  }
});

const upload = multer({ storage });

// Save user profile endpoint
app.post('/api/users', upload.single('photo'), async (req, res) => {
  try {
    const { uid, name, email } = req.body;
    const photoPath = req.file ? `/photos/${req.file.filename}` : null;

    const userData = {
      uid,
      name,
      email,
      photoPath,
      createdAt: new Date()
    };

    const result = await db.collection('profiles').insertOne(userData);
    res.json({ success: true, id: result.insertedId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve photos
app.get('/photos/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const file = await gfs.findOne({ filename });

    if (!file) return res.status(404).send('File not found');

    const readStream = gfs.createReadStream(file.filename);
    readStream.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});