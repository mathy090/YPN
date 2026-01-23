const express = require("express");
const router = express.Router();
const { sendOTP, verifyOTP, setUsername, setBackupEmail } = require("../controllers/authController");
const { verifyToken } = require("../middlewares/authMiddleware");

router.post("/send-otp", sendOTP);
router.post("/verify-otp", verifyOTP);
router.post("/username", verifyToken, setUsername);
router.post("/backup-email", verifyToken, setBackupEmail);

module.exports = router;
