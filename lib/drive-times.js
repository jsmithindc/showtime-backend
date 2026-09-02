const fetch = require("node-fetch");
const { readDiskCache, writeDiskCache } = require("./disk-cache");

// Real driving times, via Geoapify's Route Matrix.
//
// WHY THIS EXISTS: lib/distance.js estimates "minutes away" as straight-line
// distance at a flat 22mph. That is badly wrong for anything reached by
// highway, and wrong in the direction that silently removes results. Measured
// from downtown Denver against a 30-minute search:
//
//   theater                     flat 22mph   real drive
//   AMC Brighton 12               51 min       25 min
//   AMC Flatiron Crossing 14      41 min       23 min
//   AMC Arapahoe Crossing 16      39 min       20 min
//   AMC Highlands Ranch 24        35 min       30 min
//
// All four are genuinely inside a 30-minute drive; all four were dropped.
// That is four AMC theaters' worth of showtimes missing from one search.
//
// A hand-tuned distance->speed curve was tried first and rejected: bucketed
// speeds are non-monotonic at the boundaries (a theater 0.6mi FARTHER came out
// 5 minutes CLOSER), and no choice of constants got the four rows above right
// -- the best attempt was off by 3-8 minutes each and ordered them wrongly.
//
// Uses GEOAPIFY_API_KEY, which this app already sets for geocoding
// (lib/geocode.js) -- no new vendor, no new credential.
//
// FAILS OPEN, deliberately. Every error path returns nulls so the caller keeps
// its haversine estimate. A routing outage must degrade the numbers, never
// drop a chain: an exception here would take out theater discovery for the
// whole search, which is far worse than a pessimistic minute count.

const MATRIX_URL = "https://api.geoapify.com/v1/routematrix";
const REQUEST_TIMEOUT_MS = 8000;

// Small chunks, issued in parallel. Geoapify's matrix time scales badly with
// target count, so one big call is much slower than several small ones:
// measured against 58 Denver-area destinations,
//
//   1 x 58 targets          4317ms
//   8 x  8 targets (par)    2259ms
//   5 x 12 targets (par)    1220ms   <- chosen
//   4 x 15 targets (par)    1318ms
//   3 x 20 targets (par)    1709ms
//   2 x 30 targets (par)    1659ms
//
// Below ~12 the per-request overhead starts winning again. Billing is by
// source-target pair, so splitting costs no extra credits, and a failed chunk
// loses only its own targets rather than the whole set.
const MAX_TARGETS_PER_CALL = 12;

// 30 days. Theater coordinates are static and road networks change on a scale
// of years; the only thing this staleness can miss is a long-term closure,
// which would show up as an empty showtimes response anyway.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const memCache = new Map();   // "origin|dest" -> minutes | null
const inFlight = new Map();   // signature -> Promise

function isConfigured() {
  return !!process.env.GEOAPIFY_API_KEY && process.env.DISABLE_DRIVE_TIMES !== "true";
}

// 4dp is ~11m. Origins come from the geocode cache, so repeat searches for the
// same location produce byte-identical keys and never re-bill.
function coordKey(lat, lng) {
  return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
}

async function fetchMatrix(originLat, originLng, targets) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const body = {
      mode: "drive",
      sources: [{ location: [Number(originLng), Number(originLat)] }],
      targets: targets.map((t) => ({ location: [Number(t.lng), Number(t.lat)] })),
    };
    const res = await fetch(`${MATRIX_URL}?apiKey=${encodeURIComponent(process.env.GEOAPIFY_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`routematrix ${res.status} ${res.statusText}${text ? ` -- ${text.slice(0, 200)}` : ""}`);
    }
    const json = await res.json();
    const row = json.sources_to_targets?.[0];
    if (!Array.isArray(row)) throw new Error("routematrix: unexpected response shape");
    // A null entry means "no route found" (an island, a bad coordinate). That
    // is a real answer, not a failure -- cache it so it isn't re-asked.
    return targets.map((_, i) => {
      const cell = row[i];
      return cell && cell.time != null ? Math.round(cell.time / 60) : null;
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Real drive times from one origin to many destinations.
 * Returns an array parallel to `destinations`: minutes, or null where unknown
 * (not configured, no route, or the lookup failed -- callers must fall back).
 */
async function getDriveMinutes({ originLat, originLng, destinations }) {
  const out = new Array(destinations.length).fill(null);
  if (!isConfigured() || destinations.length === 0) return out;

  const oKey = coordKey(originLat, originLng);
  const diskKey = `drive-times-${oKey.replace(/[^0-9a-z.,-]/gi, "")}`;
  const disk = readDiskCache(diskKey, CACHE_TTL_MS) || {};

  // Resolve what's already known, and collect the rest. Duplicate destinations
  // (the same theater discovered by two chains) collapse to one lookup.
  const misses = new Map(); // destKey -> {lat, lng, indexes: []}
  destinations.forEach((d, i) => {
    if (d == null || d.lat == null || d.lng == null) return;
    const dKey = coordKey(d.lat, d.lng);
    const cacheKey = `${oKey}|${dKey}`;
    if (memCache.has(cacheKey)) { out[i] = memCache.get(cacheKey); return; }
    if (Object.prototype.hasOwnProperty.call(disk, dKey)) {
      memCache.set(cacheKey, disk[dKey]);
      out[i] = disk[dKey];
      return;
    }
    if (!misses.has(dKey)) misses.set(dKey, { lat: d.lat, lng: d.lng, indexes: [] });
    misses.get(dKey).indexes.push(i);
  });

  if (misses.size === 0) return out;

  const entries = [...misses.entries()];
  const signature = `${oKey}|${entries.map(([k]) => k).join(";")}`;
  if (inFlight.has(signature)) {
    const shared = await inFlight.get(signature);
    entries.forEach(([, meta], idx) => {
      for (const i of meta.indexes) out[i] = shared[idx];
    });
    return out;
  }

  const work = (async () => {
    const resolved = new Array(entries.length).fill(null);
    const chunks = [];
    for (let start = 0; start < entries.length; start += MAX_TARGETS_PER_CALL) {
      chunks.push(start);
    }
    // In parallel: this pass is a barrier -- no chain fetches anything until it
    // finishes -- so its wall time lands directly on every search. Running the
    // chunks in series (as this did originally) made a 58-theater search wait
    // ~5s instead of ~1.2s.
    await Promise.all(chunks.map(async (start) => {
      const chunk = entries.slice(start, start + MAX_TARGETS_PER_CALL);
      try {
        const mins = await fetchMatrix(originLat, originLng, chunk.map(([, m]) => m));
        mins.forEach((m, j) => { resolved[start + j] = m; });
      } catch (err) {
        // Leave this chunk null and keep going -- the others may succeed, and
        // every null simply means "caller keeps its estimate".
        console.error(`Drive times: lookup failed for ${chunk.length} theater(s):`, err.message);
      }
    }));
    return resolved;
  })();

  inFlight.set(signature, work);
  let resolved;
  try {
    resolved = await work;
  } finally {
    inFlight.delete(signature);
  }

  let learned = 0;
  entries.forEach(([dKey, meta], idx) => {
    const minutes = resolved[idx];
    // Only failures are left un-cached. A successful "no route" (null from the
    // API rather than from an exception) can't be distinguished here, so it is
    // treated as a failure and retried next search -- the cheaper mistake.
    if (minutes != null) {
      memCache.set(`${oKey}|${dKey}`, minutes);
      disk[dKey] = minutes;
      learned++;
    }
    for (const i of meta.indexes) out[i] = minutes;
  });

  if (learned > 0) writeDiskCache(diskKey, disk);
  return out;
}

module.exports = { getDriveMinutes, isConfigured, coordKey };
