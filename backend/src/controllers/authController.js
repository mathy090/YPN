// src/controllers/authController.js
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin"); // Initialized in server.js
const { generateOTP } = require("../utils/otp");

// ── Legacy Phone/OTP Logic ──────────────────────────────────────────────────

exports.sendOTP = async (req, res) => {
  const { phone } = req.body;
  try {
    let user = await User.findOne({ phone });
    if (!user) user = await User.create({ phone });

    const otp = generateOTP();
    user.otp = otp;
    user.otpExpires = new Date(Date.now() + 5 * 60 * 1000);
    await user.save();

    console.log("YPN OTP for", phone, "is", otp); // TEMP for testing
    res.json({ message: "OTP sent" });
  } catch (err) {
    console.error("[sendOTP] Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.verifyOTP = async (req, res) => {
  const { phone, otp } = req.body;
  try {
    const user = await User.findOne({ phone });

    if (!user || user.otp !== otp || user.otpExpires < Date.now()) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    user.isVerified = true;
    user.otp = null;
    user.otpExpires = null;
    await user.save();

    // Issue Legacy JWT (for backward compatibility with old flows)
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });
    const isNewUser = !user.username;

    res.json({ token, isNewUser, user: { uid: user.uid, email: user.email } });
  } catch (err) {
    console.error("[verifyOTP] Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.setUsername = async (req, res) => {
  const { username } = req.body;
  const userId = req.user.id; // From Middleware

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.username = username.toLowerCase().trim();
    await user.save();

    res.json({ message: "Username set", username: user.username });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Username already taken" });
    }
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.setBackupEmail = async (req, res) => {
  const { email } = req.body;
  const userId = req.user.id; // From Middleware

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.emailBackup = email;
    await user.save();

    res.json({ message: "Backup email set" });
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
};

// ── Hybrid Auth: Firebase ID Token → Backend JWT ────────────────────────────

exports.refreshWithFirebase = async (req, res) => {
  const { firebase_id_token } = req.body;

  if (!firebase_id_token) {
    return res.status(400).json({
      message: "Missing firebase_id_token",
      code: "MISSING_TOKEN",
    });
  }

  try {
    // 1. Verify Firebase ID Token
    const decoded = await admin.auth().verifyIdToken(firebase_id_token);
    const { uid, email, name, picture } = decoded;

    // 2. Find or Create User in MongoDB
    let user = await User.findOne({ uid });

    if (!user) {
      // Create new user record linked to Firebase UID
      user = await User.create({
        uid,
        email,
        name: name || "",
        isVerified: true, // Firebase handles verification
        status: "online",
        lastSeen: new Date(),
      });
    } else {
      // Update existing user info if changed in Firebase
      const updates = {};
      if (user.email !== email) updates.email = email;
      if (user.name !== name) updates.name = name || "";

      if (Object.keys(updates).length > 0) {
        await User.findByIdAndUpdate(user._id, { $set: updates });
      }
    }

    // Check for bans
    if (user.isBanned) {
      return res.status(403).json({
        message: "Account suspended",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    // 3. Issue Custom Backend JWT
    const backendJwt = jwt.sign(
      {
        sub: uid, // Firebase UID
        id: user._id.toString(), // MongoDB ID (stringified for consistency)
        email,
        name: name || "",
        picture: picture || "",
        role: user.role || "user",
        hasProfile: !!user.username, // True if username is set
      },
      process.env.BACKEND_JWT_SECRET,
      {
        expiresIn: process.env.BACKEND_JWT_EXPIRY || "1h",
        issuer: "ypn-backend",
        audience: "ypn-app",
      },
    );

    const expiresIn = parseInt(process.env.BACKEND_JWT_EXPIRY) || 3600;

    res.json({
      backend_jwt: backendJwt,
      expires_in: expiresIn,
      user: {
        uid,
        email,
        name: name || "",
        role: user.role || "user",
        hasProfile: !!user.username,
      },
    });
  } catch (err) {
    console.error("[refreshWithFirebase] Error:", err);

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
};

// ── Status / Heartbeat ──────────────────────────────────────────────────────

exports.updateStatus = async (req, res) => {
  try {
    // req.user is populated by verifyBackendToken middleware
    const userId = req.user.id;
    const { status } = req.body; // Optional: 'online', 'idle', 'busy'

    const updateData = {
      lastSeen: new Date(),
      status: status || "online",
    };

    await User.findByIdAndUpdate(userId, { $set: updateData });

    res.json({
      success: true,
      status: updateData.status,
      lastSeen: updateData.lastSeen,
    });
  } catch (err) {
    console.error("[updateStatus] Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
