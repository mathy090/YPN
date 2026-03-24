const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { generateOTP } = require("../utils/otp");

exports.sendOTP = async (req, res) => {
  const { phone } = req.body;
  let user = await User.findOne({ phone });

  if (!user) user = await User.create({ phone });

  const otp = generateOTP();
  user.otp = otp;
  user.otpExpires = new Date(Date.now() + 5 * 60 * 1000);
  await user.save();

  console.log("YPN OTP for", phone, "is", otp); // TEMP for testing
  res.json({ message: "OTP sent" });
};

exports.verifyOTP = async (req, res) => {
  const { phone, otp } = req.body;
  const user = await User.findOne({ phone });

  if (!user || user.otp !== otp || user.otpExpires < Date.now())
    return res.status(400).json({ message: "Invalid or expired OTP" });

  user.isVerified = true;
  user.otp = null;
  await user.save();

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
  const isNewUser = !user.username;

  res.json({ token, isNewUser });
};

exports.setUsername = async (req, res) => {
  const { username } = req.body;
  const userId = req.user.id; // from JWT middleware

  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ message: "User not found" });

  user.username = username;
  await user.save();

  res.json({ message: "Username set" });
};

exports.setBackupEmail = async (req, res) => {
  const { email } = req.body;
  const userId = req.user.id; // from JWT middleware

  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ message: "User not found" });

  user.emailBackup = email;
  await user.save();

  res.json({ message: "Backup email set" });
};
