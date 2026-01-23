const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  phone: { type: String, unique: true, required: true },
  username: { type: String },
  emailBackup: { type: String }, // optional
  otp: String,
  otpExpires: Date,
  isVerified: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model("User", UserSchema);
