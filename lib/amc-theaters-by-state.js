const fetch = require("node-fetch");
const { milesBetween } = require("./distance");
const { readDiskCache, writeDiskCache } = require("./disk-cache");

const AMC_VENDOR_KEY = process.env.AMC_VENDOR_KEY;
const AMC_BASE = "https://api.amctheatres.com/v2";

// AMC's documented /v2/theatres endpoint (developers.amctheatres.com/
// Theatres) supports filtering by state/city/market/name/brand -- but
// there is NO latitude/longitude/radius query parameter in the
// documented list, despite third-party summaries describing AMC as
// having "geographic helpers for finding theatres by coordinates" (that
// appears to just mean the response includes each theatre's own
// lat/lng, not that you can query by them).
//
// So instead: pull every theatre in a state in one paginated sweep
// (confirmed real response shape includes location.latitude/longitude
// per theatre), cache it, and match against Overpass-discovered
// theaters by proximity client-side using the same distance math used
// for radius filtering elsewhere in this app.
function authHeaders() {
  if (!AMC_VENDOR_KEY) {
    throw new Error("AMC_VENDOR_KEY environment variable is not set");
  }
  return {
    "X-AMC-Vendor-Key": AMC_VENDOR_KEY,
    "Accept": "application/json",
    "User-Agent": "ShowtimeFinder/0.1 (personal project)",
  };
}

const stateCache = new Map(); // in-memory cache keyed by state code
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getAmcTheatersByState(stateCode) {
  if (stateCache.has(stateCode)) {
    return stateCache.get(stateCode);
  }

  const diskData = readDiskCache(`amc-theaters-${stateCode}`, CACHE_TTL_MS);
  if (diskData) {
    stateCache.set(stateCode, diskData);
    return diskData;
  }

  const theaters = [];
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const url = `${AMC_BASE}/theatres?state=${encodeURIComponent(stateCode)}&page-size=${pageSize}&page-number=${pageNumber}`;
    const res = await fetch(url, { headers: authHeaders() });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `AMC theatres-by-state request failed: ${res.status} ${res.statusText}${
          text ? ` -- ${text.slice(0, 300)}` : ""
        }`
      );
    }

    const json = await res.json();
    const pageTheaters = json._embedded?.theatres || [];
    for (const t of pageTheaters) {
      if (t.location?.latitude == null || t.location?.longitude == null) continue;
      theaters.push({
        id: t.id,
        name: t.name,
        lat: t.location.latitude,
        lng: t.location.longitude,
      });
    }

    const totalCount = json.count ?? pageTheaters.length;
    if (pageNumber * pageSize >= totalCount || pageTheaters.length === 0) {
      break;
    }
    pageNumber++;
  }

  stateCache.set(stateCode, theaters);
  writeDiskCache(`amc-theaters-${stateCode}`, theaters);
  return theaters;
}

// Matches an Overpass-discovered theater to an AMC theatre ID by
// proximity, since OSM names and AMC's own branded names frequently
// don't match verbatim (confirmed repeatedly with Cinemark earlier --
// same risk applies here). Anything within ~0.3 miles is almost
// certainly the same physical building; wider than that risks matching
// the wrong theater in a shopping-center-dense area.
const MATCH_THRESHOLD_MILES = 0.3;

function findClosestAmcTheater(osmLat, osmLng, amcTheaters, thresholdMiles = MATCH_THRESHOLD_MILES) {
  let closest = null;
  let closestDist = Infinity;

  for (const t of amcTheaters) {
    const dist = milesBetween(osmLat, osmLng, t.lat, t.lng);
    if (dist < closestDist) {
      closestDist = dist;
      closest = t;
    }
  }

  if (closest && closestDist <= thresholdMiles) {
    return { ...closest, matchedDistanceMiles: closestDist };
  }
  return null;
}

module.exports = { getAmcTheatersByState, findClosestAmcTheater, MATCH_THRESHOLD_MILES };
