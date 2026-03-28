// backend/src/routes/discordRoutes.js
"use strict";

const express = require("express");
const { getChannels, getChannel } = require("../models/DiscordChannels");

const router = express.Router();

// GET /api/discord/channels
router.get("/channels", async (_req, res) => {
  try {
    const channels = await getChannels();
    res.json(channels);
  } catch (e) {
    console.error("[Discord] GET channels:", e.message);
    res.status(500).json({ message: e.message });
  }
});

// GET /api/discord/channels/:id
router.get("/channels/:id", async (req, res) => {
  try {
    const channel = await getChannel(req.params.id);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    res.json(channel);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
