const fetch = require("node-fetch");

// Photon (komoot) is primary -- same OSM data as Nominatim but a separate
// instance with a separate rate-limit pool. Render's shared datacenter IPs
// regularly hit Nominatim 429s (many unrelated apps use the same IPs and
// share Nominatim's per-IP quota). Photon handles datacenter traffic more
// reliably and is the better primary for a hosted deployment.
const PHOTON_URL = "https://photon.komoot.io/api";

// Fallback when Photon fails or returns no results. Same underlying OSM
// data; kept as backup in case Photon itself has an outage or rate-limits.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Nominatim's usage policy requires a real User-Agent identifying the
// application -- same lesson learned from Overpass's anti-scraper checks.
// CONFIRMED REAL: a hosted deployment (Render) hit a 429 that never
// showed up in local testing. Nominatim's policy explicitly asks for
// requests to be genuinely identifiable, and shared-hosting IP ranges
// (Render, Railway, etc.) get hit by many unrelated apps' Nominatim
// traffic at once -- so 429s there are a real, expected possibility,
// not a sign of a bug in this app's own request rate.
const HEADERS = {
  "User-Agent": "ShowtimeFinder/0.1 (personal project; not for redistribution)",
  "Accept": "application/json",
};

const cache = new Map();
// In-flight deduplication: if a geocoding call for the same query is
// already in progress, subsequent callers get the SAME promise rather
// than each firing their own Nominatim request. Without this, concurrent
// endpoint calls (/api/search + /api/search-regal + /api/movies, which
// all geocode the same "place" param at once) each see an empty cache
// and hit Nominatim simultaneously, triggering rate-limit 429s even
// though one successful call would have been enough for all of them.
const inFlight = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Real failure seen live: a plain read ETIMEDOUT against Nominatim, with
// no timeout set on our own request and no retry -- so a single slow
// response from their free-tier API failed the entire search outright.
// Nominatim's usage policy explicitly describes it as a shared,
// best-effort service, not something to assume will always answer
// quickly -- a bounded timeout plus one retry is a reasonable response
// to that, not a sign something is broken in our own code.
const REQUEST_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;
// 429 specifically means "you're being rate-limited right now," which is
// a different situation than a slow/flaky response -- a full second of
// backoff before the (single) retry gives the rate window a real chance
// to clear, rather than immediately re-triggering the same limit.
const RATE_LIMIT_RETRY_DELAY_MS = 2000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function geocodeForward(query) {
  if (cache.has(query)) {
    return cache.get(query);
  }
  if (inFlight.has(query)) {
    return inFlight.get(query);
  }

  const promise = _doGeocode(query).finally(() => inFlight.delete(query));
  inFlight.set(query, promise);
  return promise;
}

async function _doGeocode(query) {
  if (cache.has(query)) {
    return cache.get(query);
  }

  // Try Photon first -- better primary for hosted deployments (Render's
  // shared IPs regularly hit Nominatim 429s).
  try {
    const result = await geocodeViaPhoton(query);
    cache.set(query, result);
    return result;
  } catch (photonErr) {
    console.error(`Geocoding "${query}": Photon failed, falling back to Nominatim:`, photonErr.message);
  }

  // Nominatim fallback.
  const params = new URLSearchParams({
    q: query,
    format: "json",
    addressdetails: "1",
    limit: "1",
    countrycodes: "us",
  });

  const url = `${NOMINATIM_URL}?${params.toString()}`;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers: HEADERS });
      if (res.status === 429) {
        throw new Error(`Nominatim geocoding failed: 429 Too many requests`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Nominatim geocoding failed: ${res.status} ${res.statusText}${
            text ? ` -- ${text.slice(0, 200)}` : ""
          }`
        );
      }

      const results = await res.json();
      if (!Array.isArray(results) || results.length === 0) {
        throw new Error(`No US location found for "${query}"`);
      }

      const result = results[0];
      const addr = result.address || {};
      const city = addr.city || addr.town || addr.village || addr.hamlet || addr.suburb || addr.municipality || addr.county || "";
      const state = addr.state || "";
      // Fallback: display_name is "Murphy, Collin County, Texas, United States" --
      // split, drop "United States", take first (city/place) and last (state).
      const fallbackParts = result.display_name.split(",").map((s) => s.trim()).filter((s) => s && s !== "United States");
      const fallbackLabel = fallbackParts.length >= 2 ? `${fallbackParts[0]}, ${fallbackParts[fallbackParts.length - 1]}` : fallbackParts[0] || result.display_name;
      const locationLabel = [city, state].filter(Boolean).join(", ") || fallbackLabel;

      const resolved = {
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon),
        locationLabel,
        displayName: result.display_name,
      };

      cache.set(query, resolved);
      return resolved;
    } catch (err) {
      lastErr = err;
      const isTimeoutOrNetwork =
        err.name === "AbortError" || /ETIMEDOUT|ECONNRESET|ENOTFOUND|network/i.test(err.message);
      const isRateLimited = /\b429\b/.test(err.message);
      if ((!isTimeoutOrNetwork && !isRateLimited) || attempt >= MAX_ATTEMPTS) {
        throw err.name === "AbortError"
          ? new Error(`Nominatim geocoding timed out after ${REQUEST_TIMEOUT_MS}ms for "${query}"`)
          : err;
      }
      console.error(`Geocoding "${query}" Nominatim attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying:`, err.message);
      await sleep(isRateLimited ? RATE_LIMIT_RETRY_DELAY_MS : RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

async function geocodeViaPhoton(query) {
  const params = new URLSearchParams({ q: query, limit: "1", countrycode: "us" });
  const url = `${PHOTON_URL}?${params.toString()}`;
  const res = await fetchWithTimeout(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Photon geocoding failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) throw new Error(`No US location found for "${query}" (Photon)`);
  const [lng, lat] = feature.geometry.coordinates;
  const props = feature.properties || {};
  const city = props.city || props.county || "";
  const state = props.state || "";
  const locationLabel = [city, state].filter(Boolean).join(", ") || props.name || query;
  return { lat, lng, locationLabel, displayName: props.name || query };
}

module.exports = { geocodeForward };
