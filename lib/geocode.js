const fetch = require("node-fetch");

// OpenStreetMap's Nominatim -- free, no signup, same family of tools as
// the Overpass API already used for theater discovery. Turns a zip code
// or city name into coordinates, plus extracts a "City, State" string
// from the structured address so the same input can also drive SerpApi's
// location parameter, without the person ever typing coordinates.
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

  const params = new URLSearchParams({
    q: query,
    format: "json",
    addressdetails: "1",
    limit: "1",
    // Restrict to the US -- a bare 5-digit zip code is ambiguous without
    // country context (postal codes aren't globally unique, and several
    // other countries use 5-digit formats too). Everything else in this
    // app (SerpApi theater search, Regal/AMC/Cinemark adapters) is
    // US-only anyway, so this is a safe default, not a new limitation.
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
        // Not a network problem -- a genuinely empty result shouldn't
        // be retried, it'll just fail the same way again.
        throw new Error(`No US location found for "${query}"`);
      }

      const result = results[0];
      const addr = result.address || {};
      const city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || "";
      const state = addr.state || "";
      const locationLabel = [city, state].filter(Boolean).join(", ") || result.display_name;

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
      const isRateLimited = /\b429\b/.test(err.message);
      const isTimeoutOrNetwork =
        err.name === "AbortError" || /ETIMEDOUT|ECONNRESET|ENOTFOUND|network/i.test(err.message);
      // Only retry genuine timeout/network blips or a real rate-limit
      // response -- a "no location found" or any other 4xx from
      // Nominatim won't fix itself on a retry, so don't waste the
      // delay on those.
      if ((!isTimeoutOrNetwork && !isRateLimited) || attempt >= MAX_ATTEMPTS) {
        throw err.name === "AbortError"
          ? new Error(`Nominatim geocoding timed out after ${REQUEST_TIMEOUT_MS}ms for "${query}"`)
          : err;
      }
      console.error(`Geocoding "${query}" failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`, err.message);
      await sleep(isRateLimited ? RATE_LIMIT_RETRY_DELAY_MS : RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

module.exports = { geocodeForward };
