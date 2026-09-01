const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter", // primary
  "https://overpass.kumi.systems/api/interpreter", // community mirror
  "https://overpass.osm.ch/api/interpreter", // Swiss community mirror
];

// The primary Overpass server started enforcing stricter content-negotiation
// checks as an anti-scraper measure: requests with a missing/generic
// User-Agent (like the node-fetch default), no explicit Accept header, or
// no Accept-Encoding header now get rejected with 406, even though the
// query itself is fine. These headers are required, not cosmetic.
const REQUEST_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "ShowtimeFinder/0.1 (personal project; contact via SerpApi account owner)",
  "Accept": "application/json",
  "Accept-Encoding": "gzip, deflate, br",
};

// The public Overpass instances (primary and mirror both) are shared,
// free, rate-limited infrastructure -- they time out or 504 under load
// sometimes, unrelated to anything about your query. Theater locations
// near a fixed point also don't change day to day, so there's no reason
// to re-hit Overpass on every single search. Cache to disk with a 24h
// TTL: once a lookup succeeds for a given lat/lng/radius, repeated runs
// (like iterating on a search) hit the cache instead and can't be broken
// by Overpass being temporarily down.
const CACHE_PATH = path.join(__dirname, "..", ".overpass-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error("Failed to write Overpass cache:", err.message);
  }
}

function cacheKey({ lat, lng, radiusMeters }) {
  // Round coordinates slightly so tiny float differences don't create
  // needless separate cache entries for what's effectively the same spot.
  return `${lat.toFixed(4)},${lng.toFixed(4)},${radiusMeters}`;
}

// Query language reference: https://wiki.openstreetmap.org/wiki/Overpass_API
async function _findNearbyTheatersOverpass({ lat, lng, radiusMeters }) {
  const key = cacheKey({ lat, lng, radiusMeters });
  const cache = loadCache();
  const cached = cache[key];

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.theaters;
  }

  const query = `
    [out:json][timeout:20];
    (
      node["amenity"="cinema"](around:${radiusMeters},${lat},${lng});
      way["amenity"="cinema"](around:${radiusMeters},${lat},${lng});
    );
    out center tags;
  `;
  const body = `data=${encodeURIComponent(query)}`;

  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    // One retry per endpoint before moving to the next -- the public
    // instances are known to fail transiently under load, and a second
    // attempt a couple seconds later often just succeeds.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          body,
          headers: REQUEST_HEADERS,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Overpass request to ${endpoint} (attempt ${attempt}) failed: ${res.status} ${res.statusText}${
              text ? ` -- ${text.slice(0, 200)}` : ""
            }`
          );
        }

        const data = await res.json();
        const theaters = parseElements(data);

        console.error(
          `Overpass [${endpoint}] attempt ${attempt}: ${data.elements?.length ?? 0} raw elements, ${theaters.length} named theaters.`
        );

        cache[key] = { theaters, fetchedAt: Date.now() };
        saveCache(cache);

        return theaters;
      } catch (err) {
        lastError = err;
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
  }

  // If every endpoint/retry failed but we have a stale cache entry, use it
  // rather than failing outright -- stale theater locations are still far
  // more useful than no results at all.
  if (cached) {
    console.error(
      "Overpass unreachable, falling back to stale cache from",
      new Date(cached.fetchedAt).toISOString()
    );
    return cached.theaters;
  }

  throw lastError;
}

// In-flight lookups, keyed the same way as the disk cache. The frontend fires
// /api/search and /api/search-regal simultaneously and both discover theaters
// for identical coordinates, so a cache alone doesn't help -- neither has
// written anything by the time the other checks. This is what actually
// collapses the pair, and it's why every log showed the Geoapify line twice.
const inFlight = new Map();

async function findNearbyTheaters({ lat, lng, radiusMeters }) {
  const key = cacheKey({ lat, lng, radiusMeters });

  const pending = inFlight.get(key);
  if (pending) return pending;

  // The cache used to live only inside the Overpass path. Once Geoapify became
  // primary -- which it is whenever GEOAPIFY_API_KEY is set, so effectively
  // always -- discovery silently stopped being cached at all: every search made
  // live calls against a 3,000/day free tier. Checking here covers whichever
  // provider answers, and keeps working if the order changes again.
  const cached = loadCache()[key];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.theaters;
  }

  const lookup = _findNearbyTheatersUncached({ lat, lng, radiusMeters, key });
  inFlight.set(key, lookup);
  try {
    return await lookup;
  } finally {
    // Cleared either way: a failed lookup must not pin a rejected promise that
    // every later search would then inherit.
    inFlight.delete(key);
  }
}

async function _findNearbyTheatersUncached({ lat, lng, radiusMeters, key }) {
  // Geoapify is primary when configured -- Render's datacenter IPs are
  // frequently blocked or rate-limited by the public Overpass instances,
  // while Geoapify's free tier (3000 calls/day) handles datacenter IPs
  // cleanly. Overpass stays as fallback for when Geoapify isn't configured
  // or returns 0 results.
  if (process.env.GEOAPIFY_API_KEY) {
    try {
      const geo = await findNearbyTheatersGeoapify({ lat, lng, radiusMeters });
      if (geo && geo.length > 0) {
        const cache = loadCache();
        cache[key] = { theaters: geo, fetchedAt: Date.now() };
        saveCache(cache);
        return geo;
      }
      console.error("Geoapify returned 0 theaters -- falling back to Overpass.");
    } catch (err) {
      console.error("Geoapify failed, falling back to Overpass:", err.message);
    }
  }

  // Writes its own cache entry (and falls back to a stale one if every
  // endpoint is down), so nothing extra to do here.
  return _findNearbyTheatersOverpass({ lat, lng, radiusMeters });
}

// Nodes have lat/lon directly; ways (buildings) report their centroid
// under `center` instead -- normalize both to the same shape.
function parseElements(data) {
  return (data.elements || [])
    .map((el) => {
      const theaterLat = el.lat ?? el.center?.lat;
      const theaterLng = el.lon ?? el.center?.lon;
      const name = el.tags?.name;
      if (!name || theaterLat == null || theaterLng == null) return null;
      return {
        name,
        lat: theaterLat,
        lng: theaterLng,
        address: el.tags?.["addr:full"] || el.tags?.["addr:street"] || null,
      };
    })
    .filter(Boolean);
}

// Fallback theater discovery via Geoapify Places API. Used when Overpass
// returns 0 results -- common from datacenter IPs (Render, Railway, etc.)
// that Overpass silently blocks with an empty elements array instead of
// an error. Geoapify's free tier (3000 calls/day, no billing required)
// covers this use case cleanly. Requires GEOAPIFY_API_KEY in env.
async function findNearbyTheatersGeoapify({ lat, lng, radiusMeters }) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) return null; // not configured -- caller falls back to empty

  const url =
    `https://api.geoapify.com/v2/places` +
    `?categories=entertainment.cinema` +
    `&filter=circle:${lng},${lat},${radiusMeters}` +
    `&limit=50` +
    `&apiKey=${apiKey}`;

  const res = await fetch(url, { headers: { "User-Agent": REQUEST_HEADERS["User-Agent"] } });
  if (!res.ok) {
    throw new Error(`Geoapify Places request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const features = data.features || [];
  const theaters = features
    .map((f) => {
      const p = f.properties || {};
      const name = p.name;
      const [fLng, fLat] = f.geometry?.coordinates || [];
      if (!name || fLat == null || fLng == null) return null;
      return {
        name,
        lat: fLat,
        lng: fLng,
        address: p.address_line2 || p.formatted || null,
      };
    })
    .filter(Boolean);

  console.error(`Geoapify: ${features.length} raw results, ${theaters.length} named theaters.`);
  return theaters;
}

module.exports = { findNearbyTheaters };
