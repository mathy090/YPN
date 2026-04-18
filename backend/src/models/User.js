// src/models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    // ✅ REQUIRED: Firebase UID (unique identifier)
    uid: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    // ✅ REQUIRED: Email (lowercase, trimmed)
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // ✅ REQUIRED: Username (unique, one per account)
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9_]{3,20}$/, "is invalid"],
      index: true,
    },

    // ✅ OPTIONAL: Avatar URL (can be null/empty)
    avatarUrl: {
      type: String,
      default: null,
      trim: true,
    },

    // ✅ OPTIONAL: Display name (can be same as username or different)
    name: {
      type: String,
      trim: true,
    },

    // 🔥 Presence/Status Fields (optional, for future use)
    status: {
      type: String,
      enum: ["online", "offline", "idle", "busy"],
      default: "offline",
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },

    // 🔥 Account Status Fields
    isVerified: { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    role: {
      type: String,
      enum: ["user", "admin", "moderator"],
      default: "user",
    },

    // 🔥 Token Version for Sign-Out Invalidation
    tokenVersion: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    // ✅ Ensure username is always lowercase before saving
    toJSON: {
      transform: (doc, ret) => {
        if (ret.username) ret.username = ret.username.toLowerCase();
        return ret;
      },
    },
  },
);

// ✅ Pre-save hook to enforce lowercase username (extra safety)
userSchema.pre("save", function (next) {
  if (this.username) {
    this.username = this.username.toLowerCase();
  }
  next();
});

// ✅ Compound index for faster username+uid lookups
userSchema.index({ username: 1, uid: 1 }, { unique: true });

module.exports = mongoose.model("User", userSchema);
