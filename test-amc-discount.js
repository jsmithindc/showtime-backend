#!/usr/bin/env node
// Dumps the FULL raw ticketPrices array for every showing of The Odyssey
// at AMC Norwalk 20 today, so we can see the real type name AMC uses
// for the Tuesday/Wednesday discount instead of guessing at it.
//
// Usage: AMC_VENDOR_KEY=your-key node test-amc-discount.js

const fetch = require("node-fetch");

const AMC_VENDOR_KEY = process.env.AMC_VENDOR_KEY;
const theatreId = 441; // AMC Norwalk 20, already confirmed real from your searches

if (!AMC_VENDOR_KEY) {
  console.error("Set AMC_VENDOR_KEY as an env var first (same value already in your start.sh).");
  process.exit(1);
}

function todayMDY() {
  const d = new Date();
  return `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;
}

async function main() {
  const url = `https://api.amctheatres.com/v2/theatres/${theatreId}/showtimes/${todayMDY()}?page-size=200`;
  const res = await fetch(url, {
    headers: { "X-AMC-Vendor-Key": AMC_VENDOR_KEY, "Accept": "application/json" },
  });
  console.log(`HTTP ${res.status} ${res.statusText}`);
  if (!res.ok) {
    console.error(await res.text());
    return;
  }
  const json = await res.json();
  const showtimes = json._embedded?.showtimes || [];

  const odyssey = showtimes.filter((s) => (s.movieName || "").toLowerCase().includes("odyssey"));
  console.log(`Found ${odyssey.length} Odyssey showings today at theatre ${theatreId}`);
  console.log();

  for (const s of odyssey) {
    console.log(`--- ${s.showDateTimeLocal} ---`);
    console.log("FULL raw showtime object (checking for a real showtime ID field):");
    console.log(JSON.stringify(s, null, 2));
    console.log();
  }
}

main().catch((err) => {
  console.error("Script failed:", err.message);
  process.exit(1);
});
