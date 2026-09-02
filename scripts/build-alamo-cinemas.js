#!/usr/bin/env node
// Regenerates the ALAMO_CINEMAS list in lib/priceAdapters/alamo-official.js
// from Alamo's own public API.
//
//   node scripts/build-alamo-cinemas.js          # print the list
//   node scripts/build-alamo-cinemas.js --write  # splice it into the adapter
//
// Endpoints (drafthouse.com/robots.txt is `Allow: /`):
//   GET /s/mother/v1/market          -> every market
//   GET /s/mother/v1/market/{slug}   -> that market's cinemas, with coordinates
//
// The hand-maintained list this replaces had 22 entries and no way to tell
// whether that was all of them -- which is precisely how a chain ends up
// invisible in a city it actually operates in.
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const BASE = "https://drafthouse.com/s/mother/v1/market";
const HEADERS = { "User-Agent": "ShowtimeFinder/1.0 (personal project)", Accept: "application/json" };

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS, timeout: 25000 });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function build() {
  const markets = (await getJson(BASE)).data.markets;
  const rows = [];
  const skipped = [];
  for (const m of markets) {
    let detail;
    try {
      detail = await getJson(`${BASE}/${encodeURIComponent(m.slug)}`);
    } catch (err) {
      skipped.push(`${m.slug}: ${err.message}`);
      continue;
    }
    for (const c of detail.data.market.cinemas || []) {
      // Closed/pre-opening locations would show as theaters that never return
      // showtimes, which is worse than not listing them.
      if (c.status && c.status !== "OPEN") { skipped.push(`${m.slug}/${c.name}: status ${c.status}`); continue; }
      if (c.latitude == null || c.longitude == null) { skipped.push(`${m.slug}/${c.name}: no coordinates`); continue; }
      rows.push({
        marketSlug: m.slug,
        cinemaId: c.id,
        // The adapter matches OSM theater names, which carry the brand.
        name: /^alamo/i.test(c.name) ? c.name : `Alamo Drafthouse ${c.name}`,
        lat: c.latitude,
        lng: c.longitude,
        tz: c.timeZoneName,
        state: c.state,
      });
    }
  }
  rows.sort((a, b) => a.marketSlug.localeCompare(b.marketSlug) || a.name.localeCompare(b.name));
  return { rows, skipped, marketCount: markets.length };
}

function render(rows) {
  let out = "";
  let lastMarket = null;
  for (const r of rows) {
    if (r.marketSlug !== lastMarket) {
      out += `${lastMarket ? "\n" : ""}  // ${r.marketSlug} (${r.state})\n`;
      lastMarket = r.marketSlug;
    }
    out += `  { marketSlug: ${JSON.stringify(r.marketSlug)}, cinemaId: ${JSON.stringify(r.cinemaId)}, ` +
           `name: ${JSON.stringify(r.name)}, lat: ${r.lat}, lng: ${r.lng}, tz: ${JSON.stringify(r.tz)} },\n`;
  }
  return out.replace(/\n$/, "");
}

build().then(({ rows, skipped, marketCount }) => {
  console.error(`${marketCount} market(s) -> ${rows.length} open cinema(s) in ${new Set(rows.map((r) => r.state)).size} state(s)`);
  if (skipped.length) console.error(`skipped ${skipped.length}: ${skipped.join("; ")}`);
  const body = render(rows);
  if (!process.argv.includes("--write")) { console.log(body); return; }

  const target = path.join(__dirname, "..", "lib", "priceAdapters", "alamo-official.js");
  const src = fs.readFileSync(target, "utf8");
  const start = src.indexOf("const ALAMO_CINEMAS = [");
  const end = src.indexOf("\n];", start);
  if (start === -1 || end === -1) throw new Error("couldn't find the ALAMO_CINEMAS array to replace");
  const updated = src.slice(0, start) + "const ALAMO_CINEMAS = [\n" + body + src.slice(end);
  fs.writeFileSync(target, updated);
  console.error(`wrote ${rows.length} cinemas into ${path.relative(process.cwd(), target)}`);
}).catch((err) => { console.error("build failed:", err.message); process.exit(1); });
