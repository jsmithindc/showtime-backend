// One-time (or occasional re-run) crawler that builds a complete
// California Cinemark theater list: {id, name, lat, lng}.
//
// Technique confirmed live against real pages during development:
// - https://www.cinemark.com/full-theatre-list gave every theater's
//   name + URL slug, organized by state, NOT Cloudflare-blocked
// - Each individual theater page (https://www.cinemark.com/theatres/
//   {slug}) embeds its own TheaterId directly in TicketSeatMap links,
//   plus its street address in plain text -- also NOT Cloudflare-
//   blocked (unlike /TicketSeatMap/ itself, which returned
//   ROBOTS_DISALLOWED when fetched directly)
// - Verified against 2 real theaters: Century DOCO and XD (id 448) and
//   Century Arden XD and SCREENX (id 1137), both matched previously
//   confirmed real IDs from live DevTools captures
//
// This script re-fetches all ~52 CA theater pages (as of when this was
// written -- Cinemark opens/closes locations over time, so re-running
// occasionally is reasonable), extracts each TheaterId + address, and
// geocodes the address via lib/geocode.js (Nominatim) to get lat/lng.
//
// Usage: node scripts/build-cinemark-theater-map.js
// Writes: lib/cinemark-theaters-ca.js

const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const { geocodeForward } = require("../lib/geocode");

// Extracted directly from https://www.cinemark.com/full-theatre-list's CA
// section during development. Update this list if theaters open/close.
const CA_THEATER_SLUGS = [
  "ca-apple-valley/cinemark-jess-ranch-and-screenx",
  "ca-carson/cinemark-carson-xd-and-screenx",
  "ca-chico/cinemark-tinseltown-chico-14-and-xd",
  "ca-daly-city/cinemark-century-daly-city-20-xd-and-imax",
  "ca-downey/cinemark-downey-and-xd",
  "ca-el-centro/cinemark-imperial-valley-mall-14",
  "ca-elk-grove/cinemark-century-laguna-16-and-xd",
  "ca-folsom/cinemark-century-folsom-14",
  "ca-fremont/cinemark-century-at-pacific-commons-and-xd",
  "ca-hanford/cinemark-hanford-movies-8",
  "ca-hayward/cinemark-century-at-hayward",
  "ca-hayward/cinemark-century-southland-mall",
  "ca-huntington-beach/cinemark-century-huntington-beach-and-xd",
  "ca-la-quinta/cinemark-century-la-quinta-xd-and-screenx",
  "ca-lancaster/cinemark-lancaster-imax-and-screenx",
  "ca-long-beach/cinemark-at-the-pike-outlets-and-xd",
  "ca-los-angeles/cinemark-baldwin-hills-crenshaw-and-xd",
  "ca-los-angeles/cinemark-howard-hughes-los-angeles-and-xd",
  "ca-marina/cinemark-century-marina-and-xd",
  "ca-milpitas/cinemark-century-great-mall-20-xd-and-screenx",
  "ca-monterey/cinemark-century-monterey-13",
  "ca-mountain-view/cinemark-century-mountain-view-16",
  "ca-napa/cinemark-century-napa-valley-and-xd",
  "ca-north-hollywood/cinemark-century-north-hollywood-and-xd",
  "ca-novato/cinemark-century-rowland-plaza",
  "ca-orange/cinemark-century-orange-xd-and-screenx",
  "ca-oxnard/cinemark-century-riverpark-and-xd",
  "ca-palmdale/cinemark-antelope-valley-mall",
  "ca-playa-vista/cinemark-playa-vista-and-xd",
  "ca-pleasant-hill/cinemark-century-downtown-pleasant-hill-16-and-xd",
  "ca-rancho-mirage/cinemark-century-at-the-river-and-xd",
  "ca-redding/cinemark-redding-14-and-xd",
  "ca-redwood-city/cinemark-century-redwood-downtown-20-and-xd",
  "ca-rialto/cinemark-bistro-renaissance-marketplace-xd-and-screenx",
  "ca-richmond/cinemark-century-hilltop-16",
  "ca-rocklin/cinemark-century-blue-oaks-theatres-and-xd",
  "ca-roseville/cinemark-roseville-galleria-mall-and-xd",
  "ca-sacramento/cinemark-century-doco-and-xd",
  "ca-sacramento/cinemark-century-greenback-lane-16-and-xd",
  "ca-sacramento/cinemark-century-arden-xd-and-screenx",
  "ca-salinas/cinemark-century-northridge-mall-14",
  "ca-san-bruno/cinemark-century-at-tanforan-and-xd",
  "ca-san-jose/cinemark-cinearts-santana-row",
  "ca-san-jose/cinemark-century-oakridge-20-xd-and-screenx",
  "ca-san-leandro/cinemark-century-bayfair-mall-16",
  "ca-san-mateo/cinemark-century-san-mateo-12",
  "ca-tracy/cinemark-tracy-14",
  "ca-union-city/cinemark-century-union-landing-25-and-xd",
  "ca-vallejo/cinemark-century-vallejo-14",
  "ca-ventura/cinemark-century-ventura-downtown-10",
  "ca-victorville/cinemark-victorville-16-and-xd",
  "ca-walnut-creek/cinemark-century-walnut-creek-14-and-xd",
  "ca-yuba-city/cinemark-yuba-city",
];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// PRIMARY address source: real pages embed schema.org PostalAddress
// JSON-LD (confirmed live: Huntington Beach's page has
// {"@type":"PostalAddress","streetAddress":"7777 Edinger Ave",
// "addressLocality":"Huntington Beach","addressRegion":"CA",
// "postalCode":"92647",...} directly in a <script type="application/
// ld+json"> block). This is real structured data meant for Google's
// rich snippets, not something that varies with page layout the way
// visible text does -- should be far more consistent across theaters
// than the plain-text "Address" label the original version looked for
// (which broke on this exact page, likely because of the "Suite 170"
// suffix throwing off adjacency).
function findPostalAddress(obj, depth = 0) {
  if (depth > 6 || obj == null || typeof obj !== "object") return null;
  if (obj["@type"] === "PostalAddress" && obj.streetAddress) {
    return {
      street: obj.streetAddress,
      city: obj.addressLocality,
      state: obj.addressRegion,
      zip: obj.postalCode,
    };
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findPostalAddress(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const value of Object.values(obj)) {
    const found = findPostalAddress(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractAddressFromJsonLd(html) {
  const scriptPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const addr = findPostalAddress(data);
      if (addr) return addr;
    } catch {
      // Malformed/partial JSON in this particular block -- keep
      // checking any other JSON-LD blocks on the page.
    }
  }
  return null;
}

async function fetchTheaterInfo(slug) {
  const url = `https://www.cinemark.com/theatres/${slug}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const html = await res.text();

  // CONFIRMED REAL, observed directly while trying to look up a single
  // theater by hand: cinemark.com sits behind a queue/waiting-room
  // system that can serve a "Cinemark Waiting Room" interstitial ("Your
  // estimated wait time is 5 minutes...") with HTTP 200 instead of the
  // real theater page. That page has no TheaterId in it, so without
  // this check the script fails with the thoroughly misleading "No
  // TheaterId found in page" -- which reads like Cinemark changed their
  // markup, and would send anyone debugging it straight at the parsing
  // logic instead of at the queue. Checked BEFORE the TheaterId regex
  // specifically so the real cause wins.
  //
  // Worth knowing before running this script at all: if the queue is
  // active, it will likely be active for every theater in the list, not
  // just one. Retrying later (or from a different network) is the fix,
  // not a code change.
  if (/Waiting Room|estimated wait time/i.test(html)) {
    throw new Error(
      "Cinemark served its queue/waiting-room page instead of the theater page -- " +
      "this is a rate-limit/queue response, not a markup change. Wait and re-run."
    );
  }

  // TheaterId is a literal substring inside href="...TheaterId=NNN..."
  // attribute values, so this works the same whether the source is raw
  // HTML or any converted/rendered form.
  //
  // IMPORTANT CORRECTION -- caught before shipping, not after: a real
  // full-page network capture showed cinemark.com's Downey theater page
  // never emits a literal "TheaterId=NNN" substring anywhere. Its real
  // ID instead showed up as ep.theater_id=1134 in a Google Analytics
  // call. My first instinct was to add that as a regex fallback here --
  // that would have been wrong. ep.theater_id is a parameter on a
  // request the PAGE'S OWN JAVASCRIPT fires after load; this script
  // does a plain `fetch()` with no JS execution (confirmed: no
  // puppeteer/playwright anywhere in this file), so that parameter
  // never exists in the HTML this script actually receives. A regex
  // for it here would silently never match and just look like it was
  // handling the case.
  //
  // Net effect: for a theater whose ID only lives in an analytics call,
  // this script CANNOT recover it without a real browser context. When
  // this happens, the fix is to add the ID to lib/cinemark-theater-map
  // .js by hand from a DevTools capture (as already done for Downey:
  // 1134, confirmed real) rather than trying to make this fetch-based
  // script smarter -- there's no static-HTML fallback that would work.
  const idMatch = /TheaterId=(\d+)/.exec(html);
  if (!idMatch) {
    throw new Error(
      "No TheaterId found in page. If DevTools shows the real ID only in an " +
      "analytics call (ep.theater_id=...), this script can't recover it -- " +
      "that parameter is set by client-side JS this fetch-based script never runs. " +
      "Add the ID to lib/cinemark-theater-map.js by hand instead."
    );
  }
  const theaterId = idMatch[1];

  let address;
  const jsonLdAddr = extractAddressFromJsonLd(html);
  if (jsonLdAddr) {
    address = `${jsonLdAddr.street}, ${jsonLdAddr.city}, ${jsonLdAddr.state} ${jsonLdAddr.zip}`;
  } else {
    // Fallback: the original plain-text approach, in case a page
    // doesn't have JSON-LD for some reason. Verified against a
    // markdown-converted view rather than raw HTML, so treat this path
    // as the weaker of the two.
    const plainText = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    const addrMatch = /Address\s+([0-9][^,]+),\s*([A-Za-z\s]+?)\s+([A-Z]{2})\s+(\d{5})/.exec(plainText);
    if (!addrMatch) {
      throw new Error("No address found in page (checked both JSON-LD and plain text)");
    }
    address = `${addrMatch[1].trim()}, ${addrMatch[2].trim()}, ${addrMatch[3]} ${addrMatch[4]}`;
  }

  // Name from the <title> tag -- reliably present in raw HTML regardless
  // of page layout changes elsewhere. Not load-bearing for matching
  // (that's done by ID via proximity), just for readability in the
  // output file.
  const titleMatch = /<title>([^<]+)<\/title>/i.exec(html);
  const name = titleMatch
    ? titleMatch[1].split(":").pop().trim()
    : slug;

  return { id: theaterId, name, address };
}

async function main() {
  const results = [];
  const failures = [];

  for (const slug of CA_THEATER_SLUGS) {
    try {
      const info = await fetchTheaterInfo(slug);
      let geo;
      try {
        geo = await geocodeForward(info.address);
      } catch (err) {
        // Nominatim can be picky about exact street-address phrasing
        // (mall names, abbreviations like "Ctr" or "N ___ Rd" don't
        // always match their index) even when the address itself is
        // clearly well-formed. Confirmed live: 5 real addresses failed
        // this way on the first run despite looking completely normal.
        // Fall back to just "city, state zip" -- less precise (city-
        // level rather than street-level), but still close enough for
        // most matching purposes, and clearly better than no entry at
        // all. Flagged via approximate:true so callers can weight it
        // differently if needed.
        const cityStateZipMatch = /,\s*([^,]+,\s*[A-Z]{2}\s+\d{5})$/.exec(info.address);
        if (!cityStateZipMatch) throw err;
        console.log(`  Retrying with city-level fallback: "${cityStateZipMatch[1]}"`);
        geo = await geocodeForward(cityStateZipMatch[1]);
        geo = { ...geo, approximate: true };
      }
      results.push({
        id: info.id,
        name: info.name,
        lat: geo.lat,
        lng: geo.lng,
        slug,
        ...(geo.approximate ? { approximate: true } : {}),
      });
      console.log(
        `OK: ${info.name} -> id ${info.id}, ${geo.lat}, ${geo.lng}${geo.approximate ? " (approximate)" : ""}`
      );
    } catch (err) {
      console.error(`FAILED: ${slug} -- ${err.message}`);
      failures.push(slug);
    }
    // Be polite to both Cinemark and Nominatim -- no need to hammer
    // either, this only needs to run occasionally.
    await sleep(1200);
  }

  const outPath = path.join(__dirname, "..", "lib", "cinemark-theaters-ca.js");
  const fileContent =
    "// Auto-generated by scripts/build-cinemark-theater-map.js -- do not hand-edit.\n" +
    "// Re-run that script to refresh (theaters open/close over time).\n" +
    `// Generated: ${new Date().toISOString()}\n` +
    (failures.length ? `// FAILED slugs (investigate and re-run): ${failures.join(", ")}\n` : "") +
    `module.exports = ${JSON.stringify(results, null, 2)};\n`;

  fs.writeFileSync(outPath, fileContent);
  console.log(`\nWrote ${results.length} theaters to ${outPath}`);
  if (failures.length) {
    console.log(`${failures.length} failed -- see FAILED slugs comment in the output file.`);
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
