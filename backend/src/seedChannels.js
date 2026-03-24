"use strict";
const { addChannel } = require("./models/Channel");

async function seed() {
  await addChannel("UC_x5XG1OV2P6uZZ5FSM9Ttw", "Google Developers");
  await addChannel("UC29ju8bIPH5as8OGnQzwJyA", "Traversy Media");
  await addChannel("UCWv7vMbMWH4-V0ZXdmDpPBA", "The Net Ninja");
  console.log("Channels seeded ✅");
  process.exit(0);
}

seed();
