// src/routes/auth.js
const express = require("express");
const router = express.Router();
const {
  sendOTP,
  verifyOTP,
  setUsername,
  setBackupEmail,
  refreshWithFirebase,
  updateStatus,
} = require("../controllers/authController");

// Middleware
const { verifyBackendToken } = require("../middlewares/authMiddleware");

// ── Public Routes (No Auth Required) ────────────────────────────────────────
router.post("/send-otp", sendOTP);
router.post("/verify-otp", verifyOTP);
router.post("/refresh", refreshWithFirebase); // Hybrid Auth Entry Point

// ── Protected Routes (Requires Valid Backend JWT) ───────────────────────────
router.post("/username", verifyBackendToken, setUsername);
router.post("/backup-email", verifyBackendToken, setBackupEmail);
router.post("/status", verifyBackendToken, updateStatus); // Heartbeat

module.exports = router;
