// src/models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    uid: { type: String, unique: true, sparse: true, index: true }, // Firebase UID
    phone: { type: String, unique: true, sparse: true, index: true }, // Legacy OTP
    email: { type: String, lowercase: true, trim: true, index: true },

    username: {
      type: String,
      lowercase: true,
      trim: true,
      unique: true,
      sparse: true, // Allows null until set
      match: [/^[a-z0-9_]{3,20}$/, "is invalid"],
    },

    name: { type: String, trim: true },
    avatarUrl: { type: String, default: "" },

    // 🔥 New Fields for Presence/Status
    status: {
      type: String,
      enum: ["online", "offline", "idle", "busy"],
      default: "offline",
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },

    isVerified: { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    role: {
      type: String,
      enum: ["user", "admin", "moderator"],
      default: "user",
    },

    // OTP Fields
    otp: { type: String, select: false },
    otpExpires: { type: Date, select: false },
  },
  { timestamps: true },
);

module.exports = mongoose.model("User", userSchema);
