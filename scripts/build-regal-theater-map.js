// Geocodes a curated list of confirmed real Regal California theaters
// into lib/regal-theaters-ca.js -- same pipeline as scripts/build-
// cinemark-theater-map.js, but Regal has no equivalent of Cinemark's
// full-theatre-list page (regmovies.com blocks bot traffic even on
// individual theater pages, confirmed live -- Cloudflare protection
// there is broader than Cinemark's). So instead of crawling the site
// directly, this list was built two ways:
// 1. Individually, by searching for real regmovies.com theater page
//    URLs (which Google has indexed even though direct fetches are
//    blocked) and reading the 4-digit cinema code straight out of each
//    URL, e.g. regmovies.com/theatres/regal-edwards-rancho-san-diego-
//    1049 -> code 1049.
// 2. In bulk, since regmovies.com/theatre-list itself isn't blocked for
//    a real human browser (Cloudflare bot detection specifically
//    targets automated traffic) -- a browser-console one-liner
//    (document.querySelectorAll('a[href*="/theatres/regal-"]')...)
//    extracted essentially the entire national list at once, which
//    got filtered down to California here.
//
// This is now California-complete -- all 70 known CA theaters
// confirmed, no remaining gaps (see KNOWN_BUT_UNCODED_CA_THEATERS for
// the resolution of what looked like one last missing theater).
//
// Geocoding: tries the specific theater name first (resolves to the
// real building if OSM has it mapped as a point of interest, with a
// 15-mile sanity check against the city center to reject an unrelated
// same-name mismatch elsewhere), falling back to city-level only if
// that fails. An earlier version used city-only for every theater,
// which put every same-city theater at the identical coordinate --
// confirmed broken for real (Sacramento's 3 theaters all landed on one
// point), making proximity matching unable to tell them apart.
//
// Usage: node scripts/build-regal-theater-map.js
// Writes: lib/regal-theaters-ca.js

const fs = require("fs");
const path = require("path");
const { geocodeForward } = require("../lib/geocode");
const { milesBetween } = require("../lib/distance");

// (name, city, code) -- name/city used only to build a geocodable query;
// matching against Overpass/OSM theaters happens by lat/lng proximity,
// same as the AMC and Cinemark auto-lookups, not by this name string.
const CONFIRMED_CA_THEATERS = [
  { name: "Regal La Habra Stadium 16", city: "La Habra, CA", code: "0704" },
  { name: "Regal Yorba Linda & IMAX", city: "Yorba Linda, CA", code: "1430" },
  { name: "Regal Edwards Brea East", city: "Brea, CA", code: "1028" },
  { name: "Regal Edwards Rancho San Diego", city: "El Cajon, CA", code: "1049" },
  { name: "Regal Edwards West Covina", city: "West Covina, CA", code: "1030" },
  { name: "Regal Edwards Bakersfield", city: "Bakersfield, CA", code: "1031" },
  { name: "Regal Edwards Aliso Viejo", city: "Aliso Viejo, CA", code: "1032" },
  { name: "Regal Edwards Camarillo Palace", city: "Camarillo, CA", code: "1009" },
  { name: "Regal Edwards Mira Mesa", city: "San Diego, CA", code: "1043" },
  { name: "Regal Edwards Temecula", city: "Temecula, CA", code: "1045" },
  { name: "Regal Edwards Fairfield", city: "Fairfield, CA", code: "1046" },
  { name: "Regal UA Laguna Village", city: "Sacramento, CA", code: "1286" },
  { name: "Regal UA La Canada", city: "La Canada, CA", code: "1270" },
  { name: "Regal North Hollywood", city: "North Hollywood, CA", code: "1438" },
  { name: "Regal Edwards Kaleidoscope", city: "Mission Viejo, CA", code: "1035" },
  { name: "Regal Edwards Big Newport", city: "Newport Beach, CA", code: "1024" },
  { name: "Regal Edwards Long Beach", city: "Long Beach, CA", code: "1042" },
  { name: "Regal Delta Shores", city: "Sacramento, CA", code: "1413" },
  { name: "Regal Natomas Marketplace", city: "Sacramento, CA", code: "0774" },
  { name: "Regal Davis Holiday", city: "Davis, CA", code: "1814" },
  { name: "Regal Edwards San Marcos", city: "San Marcos, CA", code: "1034" },
  { name: "Regal Escondido", city: "Escondido, CA", code: "1805" },
  { name: "Regal Simi Valley Civic Center", city: "Simi Valley, CA", code: "0391" },
  { name: "Regal Sherman Oaks Galleria", city: "Sherman Oaks, CA", code: "1483" },
  { name: "Regal Marketplace @ El Paseo", city: "Fresno, CA", code: "1433" },
  { name: "Regal Edwards La Verne", city: "La Verne, CA", code: "1012" },
  { name: "Regal Riverside Plaza", city: "Riverside, CA", code: "1806" },
  { name: "Regal Oceanside", city: "Oceanside, CA", code: "0708" },
  { name: "Regal Stockton City Center", city: "Stockton, CA", code: "1817" },
  { name: "Regal Stockton Holiday", city: "Stockton, CA", code: "1816" },
  { name: "Regal Rancho Mirage", city: "Rancho Mirage, CA", code: "1801" },
  { name: "Regal Rancho Del Rey", city: "Chula Vista, CA", code: "0361" },
  { name: "Regal Edwards Alhambra Renaissance", city: "Alhambra, CA", code: "1053" },
  { name: "Regal Arroyo Grande", city: "Arroyo Grande, CA", code: "1812" },
  { name: "Regal Auburn - California", city: "Auburn, CA", code: "1823" },
  { name: "Regal Carlsbad", city: "Carlsbad, CA", code: "1778" },
  { name: "Regal Edwards Cerritos", city: "Cerritos, CA", code: "1018" },
  { name: "Regal Edwards Corona Crossings", city: "Corona, CA", code: "0665" },
  { name: "Regal Edwards Metro Pointe", city: "Costa Mesa, CA", code: "1007" },
  { name: "Regal Hacienda Crossings", city: "Dublin, CA", code: "0347" },
  { name: "Regal Edwards Eastvale Gateway", city: "Eastvale, CA", code: "1916" },
  { name: "Regal Parkway Plaza", city: "El Cajon, CA", code: "0388" },
  { name: "Regal El Dorado Hills", city: "El Dorado Hills, CA", code: "1807" },
  { name: "Regal Fresno River Park", city: "Fresno, CA", code: "1033" },
  { name: "Regal Manchester - Fresno", city: "Fresno, CA", code: "1820" },
  { name: "Regal Garden Grove", city: "Garden Grove, CA", code: "0364" },
  { name: "Regal Edwards Irvine Spectrum", city: "Irvine, CA", code: "1010" },
  { name: "Regal Edwards University Town Center", city: "Irvine, CA", code: "1025" },
  { name: "Regal Edwards Market Place", city: "Irvine, CA", code: "1048" },
  { name: "Regal LA Live", city: "Los Angeles, CA", code: "1484" },
  { name: "Regal Hollywood Merced", city: "Merced, CA", code: "1607" },
  { name: "Regal Modesto", city: "Modesto, CA", code: "1818" },
  { name: "Regal Jack London", city: "Oakland, CA", code: "1808" },
  { name: "Regal Mission Marketplace", city: "Oceanside, CA", code: "1470" },
  { name: "Regal Edwards Ontario Palace", city: "Ontario, CA", code: "1026" },
  { name: "Regal Edwards Ontario Mountain Village", city: "Ontario, CA", code: "1037" },
  { name: "Regal Paseo", city: "Pasadena, CA", code: "1485" },
  { name: "Regal Promenade", city: "Rolling Hills Estates, CA", code: "0748" },
  { name: "Regal San Bernardino", city: "San Bernardino, CA", code: "1799" },
  { name: "Regal Stonestown Galleria", city: "San Francisco, CA", code: "1464" },
  { name: "Regal San Jacinto Metro", city: "San Jacinto, CA", code: "1804" },
  { name: "Regal Edwards Valencia", city: "Santa Clarita, CA", code: "1038" },
  { name: "Regal Edwards Canyon Country", city: "Canyon Country, CA", code: "1047" },
  { name: "Regal Edwards Santa Maria", city: "Santa Maria, CA", code: "1681" },
  { name: "Regal Sonora", city: "Sonora, CA", code: "1826" },
  { name: "Regal Edwards South Gate", city: "South Gate, CA", code: "1044" },
  { name: "Regal Janss Marketplace", city: "Thousand Oaks, CA", code: "1418" },
  { name: "Regal Turlock", city: "Turlock, CA", code: "1819" },
  { name: "Regal Ukiah", city: "Ukiah, CA", code: "1813" },
  { name: "Regal Visalia", city: "Visalia, CA", code: "1821" },
];

// Full CA theater name/city list from Fandango's directory
// (fandango.com/movie-theaters/regal), for theaters NOT yet confirmed
// with a real regmovies.com code above.
//
// RESOLVED: the one theater this list used to flag as missing --
// "Regal Edwards Fresno ScreenX, 4DX & IMAX" -- turned out to be the
// same physical theater as "Regal Fresno River Park" above (code 1033),
// just referenced under a different marketing name in Fandango's
// listing (likely reflecting formats added after the location's
// original name stuck in other sources). Confirmed directly. So this
// list is empty -- the California confirmed list above is complete.
const KNOWN_BUT_UNCODED_CA_THEATERS = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const results = [];
  const failures = [];

  for (const theater of CONFIRMED_CA_THEATERS) {
    try {
      const cityGeo = await geocodeForward(theater.city);
      await sleep(1200);

      // Try the specific theater name first -- if Nominatim/OSM has it
      // mapped as a real point of interest, this resolves to the actual
      // building instead of the city centroid. Confirmed necessary: an
      // earlier city-only-only version put every same-city theater at
      // the identical coordinate (all 3 Sacramento theaters landed on
      // one point), which breaks proximity matching entirely for any
      // city with more than one theater.
      let lat = cityGeo.lat;
      let lng = cityGeo.lng;
      let approximate = true;

      try {
        const nameGeo = await geocodeForward(`${theater.name}, ${theater.city}`);
        const distFromCity = milesBetween(cityGeo.lat, cityGeo.lng, nameGeo.lat, nameGeo.lng);
        // Sanity bound: a real theater should be reasonably close to its
        // own city's centroid. If the name-based query landed further
        // than this, it more likely matched something unrelated (a
        // similarly-named business elsewhere) than the real theater --
        // safer to fall back to the city-level point in that case.
        const SANITY_RADIUS_MILES = 15;
        if (distFromCity <= SANITY_RADIUS_MILES) {
          lat = nameGeo.lat;
          lng = nameGeo.lng;
          approximate = false;
        }
      } catch {
        // Name+city query found nothing -- keep the city-level fallback.
      }
      await sleep(1200);

      results.push({ id: theater.code, name: theater.name, lat, lng, ...(approximate ? { approximate: true } : {}) });
      console.log(`OK: ${theater.name} -> code ${theater.code}, ${lat}, ${lng}${approximate ? " (city-level approximate)" : " (name match)"}`);
    } catch (err) {
      console.error(`FAILED: ${theater.name} -- ${err.message}`);
      failures.push(theater.name);
    }
    await sleep(1200);
  }

  const outPath = path.join(__dirname, "..", "lib", "regal-theaters-ca.js");
  const fileContent =
    "// Auto-generated by scripts/build-regal-theater-map.js -- do not hand-edit.\n" +
    "// Coordinates try name-specific geocoding first (real building, no\n" +
    "// 'approximate' flag), falling back to city-level (flagged\n" +
    "// approximate:true) if that fails. Re-run to refresh.\n" +
    `// Generated: ${new Date().toISOString()}\n` +
    (failures.length ? `// FAILED: ${failures.join(", ")}\n` : "") +
    `module.exports = ${JSON.stringify(results, null, 2)};\n`;

  fs.writeFileSync(outPath, fileContent);
  console.log(`\nWrote ${results.length} theaters to ${outPath}`);
  if (KNOWN_BUT_UNCODED_CA_THEATERS.length > 0) {
    console.log(
      `\n${KNOWN_BUT_UNCODED_CA_THEATERS.length} more known CA Regal theaters exist but don't have ` +
      `a confirmed code yet -- see KNOWN_BUT_UNCODED_CA_THEATERS in this script.`
    );
  } else {
    console.log("\nCalifornia theater list is complete -- no known gaps remaining.");
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
