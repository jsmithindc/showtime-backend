const fetch = require("node-fetch");

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const BASE_URL = "https://serpapi.com/search.json";

// This tries to pull a movie's runtime out of Google's Knowledge Graph via
// a plain SerpApi google search ("<title> movie runtime"). A first version
// checked a fixed list of guessed field names (duration/runtime/
// running_time) and missed on every real title tested -- SerpApi's own
// docs confirm Knowledge Graph key names mirror whatever Google's panel
// happens to render, so they aren't fixed. This version instead
// recursively scans the whole knowledge_graph object for any
// duration-shaped string (see findDurationInObject below), which is more
// likely to actually find the data regardless of what the real key turns
// out to be. Still unverified against a live response end-to-end, though
// -- if it's still missing for your titles, check the server console for
// the "no duration-shaped value found" log line, which lists every key
// Google actually returned, and add the title to
// lib/movie-runtime-overrides.js as a manual fix.
function parseDurationToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  const s = str.trim();

  // "2 h 6 min", "2h 6min", "2 hr 6 min", "1 hr", "2h"
  let m = /(\d+)\s*h(?:r|rs)?\.?(?:\s*(\d+)\s*m(?:in)?)?/i.exec(s);
  if (m) {
    const hours = parseInt(m[1], 10);
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    return hours * 60 + mins;
  }

  // "126 min" / "126 minutes"
  m = /^(\d+)\s*min/i.exec(s);
  if (m) return parseInt(m[1], 10);

  // "2:06" (H:MM)
  m = /^(\d+):(\d{2})$/.exec(s);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);

  return null;
}

const cache = new Map();
const OVERRIDES = require("./movie-runtime-overrides");

// SerpApi's own documentation confirms Knowledge Graph key names mirror
// whatever Google's panel happens to render for that query -- they are
// NOT fixed/predictable across different searches. So instead of betting
// on a specific field name (which failed completely in testing -- every
// title fell through to the fallback), this recursively scans every
// string value in the knowledge_graph object and takes the first one
// that parses as a duration. Bounded depth to avoid pathological objects.
function findDurationInObject(obj, depth = 0) {
  if (depth > 3 || obj == null) return null;

  if (typeof obj === "string") {
    return parseDurationToMinutes(obj);
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findDurationInObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      // Skip fields extremely unlikely to be a runtime, to cut down on
      // false positives (e.g. a date string that happens to contain a
      // number followed by "m" for some unrelated reason).
      if (/^(link|image|thumbnail|url|id|kgmid|website)$/i.test(key)) continue;
      const found = findDurationInObject(value, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

async function getRuntimeMinutes(movieTitle, fallbackMinutes, additionalSource) {
  if (OVERRIDES[movieTitle] != null) {
    return OVERRIDES[movieTitle];
  }

  if (cache.has(movieTitle)) {
    return cache.get(movieTitle);
  }

  // A free, already-being-fetched alternative (e.g. Harkins' own movie
  // catalog) checked before ever spending a real SerpApi call -- see
  // getRuntimeForMovie in lib/priceAdapters/harkins-official.js. This
  // is what actually fixed a real bug: SerpApi's runtime lookup was
  // silently falling back to the hardcoded default once SerpApi's
  // monthly credits ran low, caught from a live search reporting The
  // Odyssey's runtime as 128 (the fallback) instead of its real 172.
  if (additionalSource) {
    try {
      const fromAdditionalSource = await additionalSource(movieTitle);
      if (fromAdditionalSource != null) {
        cache.set(movieTitle, fromAdditionalSource);
        return fromAdditionalSource;
      }
    } catch (err) {
      console.error(`Runtime lookup: additional source failed for "${movieTitle}":`, err.message);
    }
  }

  if (!SERPAPI_KEY) {
    return fallbackMinutes;
  }

  try {
    const params = new URLSearchParams({
      engine: "google",
      q: `${movieTitle} movie runtime`,
      api_key: SERPAPI_KEY,
    });

    const res = await fetch(`${BASE_URL}?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`SerpApi request failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();

    const minutes = findDurationInObject(data.knowledge_graph);
    if (minutes) {
      cache.set(movieTitle, minutes);
      return minutes;
    }

    console.error(
      `Runtime lookup: no duration-shaped value found in knowledge_graph for "${movieTitle}" -- ` +
      `falling back to ${fallbackMinutes} min. knowledge_graph keys seen: ` +
      `${data.knowledge_graph ? Object.keys(data.knowledge_graph).join(", ") : "(no knowledge_graph in response)"}`
    );
  } catch (err) {
    console.error(`Runtime lookup failed for "${movieTitle}":`, err.message);
  }

  cache.set(movieTitle, fallbackMinutes);
  return fallbackMinutes;
}

module.exports = { getRuntimeMinutes, parseDurationToMinutes };
