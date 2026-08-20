// TODO: same pattern as amc.js — implement against Regal's ticket flow for
// a given theater + film + date + time + format. Needs a MovieGlu
// cinema_id -> Regal theater id mapping.

async function getPrice(showing) {
  throw new Error("Regal price adapter not implemented yet");
}

module.exports = { getPrice };
