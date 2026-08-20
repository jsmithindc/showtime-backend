const amc = require("./amc");
const regal = require("./regal");
const cinemark = require("./cinemark");
const fandango = require("./fandango");

const ADAPTERS = { amc, regal, cinemark };

// Falls back to Fandango (which lists most chains) for anything not
// directly supported yet — one less chain-specific adapter to write.
async function getPrice(showing) {
  const adapter = ADAPTERS[showing.theaterChain] || fandango;
  try {
    return await adapter.getPrice(showing);
  } catch (err) {
    console.error(`Price lookup failed for ${showing.theaterName}:`, err.message);
    return null; // caller drops this showing rather than failing the whole search
  }
}

module.exports = { getPrice };
