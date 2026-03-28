// backend/src/models/DiscordChannels.js
"use strict";

let _db = null;

const DEFAULT_CHANNELS = [
  {
    id: "general",
    name: "general",
    description: "General YPN community chat",
    color: "#5865F2",
    bgColor: "#5865F222",
    emoji: "💬",
    order: 1,
  },
  {
    id: "mental-health",
    name: "mental-health",
    description: "Safe space to talk",
    color: "#57F287",
    bgColor: "#57F28722",
    emoji: "💚",
    order: 2,
  },
  {
    id: "jobs",
    name: "jobs",
    description: "Opportunities & careers",
    color: "#FEE75C",
    bgColor: "#FEE75C22",
    emoji: "💼",
    order: 3,
  },
  {
    id: "education",
    name: "education",
    description: "Learning & resources",
    color: "#EB459E",
    bgColor: "#EB459E22",
    emoji: "📚",
    order: 4,
  },
  {
    id: "prayer",
    name: "prayer",
    description: "Prayer & community support",
    color: "#FF7043",
    bgColor: "#FF704322",
    emoji: "🙏",
    order: 5,
  },
  {
    id: "announcements",
    name: "announcements",
    description: "YPN news & updates",
    color: "#ED4245",
    bgColor: "#ED424522",
    emoji: "📢",
    order: 6,
  },
];

function init(db) {
  _db = db;
  seedChannels();
}

async function seedChannels() {
  try {
    const count = await _db.collection("discord_channels").countDocuments();
    if (count === 0) {
      await _db
        .collection("discord_channels")
        .insertMany(
          DEFAULT_CHANNELS.map((ch) => ({ ...ch, createdAt: new Date() })),
        );
      console.log("✅ Discord channels seeded");
    }
  } catch (err) {
    console.error("[Discord] Seed error:", err.message);
  }
}

async function getChannels() {
  if (!_db) throw new Error("DiscordChannels not initialised");
  return _db
    .collection("discord_channels")
    .find({}, { projection: { _id: 0 } })
    .sort({ order: 1 })
    .toArray();
}

async function getChannel(id) {
  if (!_db) throw new Error("DiscordChannels not initialised");
  return _db
    .collection("discord_channels")
    .findOne({ id }, { projection: { _id: 0 } });
}

module.exports = { init, getChannels, getChannel };
