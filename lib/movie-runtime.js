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

// How long to wait on SerpApi before giving up and using the fallback. The
// request had no timeout at all, so a hung SerpApi would stall every caller
// indefinitely -- and this lookup sits on the critical path of a search. Four
// seconds is generous for a knowledge-graph lookup, and the fallback is
// already the failure path, so waiting longer buys very little.
const SERPAPI_TIMEOUT_MS = 4000;

// Cached values AND in-flight promises live here. Storing the promise is what
// makes concurrent callers share one request: /api/search and /api/search-regal
// fire simultaneously for the same title, and with a value-only cache both
// missed and both spent a real SerpApi call. That showed up as the same
// "Runtime lookup failed ... 429" line twice in every single search log --
// two calls burned to get one answer, against a quota already exhausted.
// Same lookup, but reports WHERE the number came from. Callers that filter
// showtimes against a runtime need to know whether they have a real value or
// the hardcoded constant: the deadline filter computes
// start + runtime + trailers and drops anything past the user's deadline, so
// a fabricated runtime silently recommends showings that run past it. That is
// the one failure this app exists to prevent, and it was invisible -- nothing
// distinguished a real runtime from the fallback anywhere in the codebase.
async function getRuntimeInfo(movieTitle, fallbackMinutes, additionalSource) {
  const minutes = await getRuntimeMinutes(movieTitle, fallbackMinutes, additionalSource);
  return {
    minutes,
    // True only when every real source failed and this is the constant. A film
    // that genuinely runs `fallbackMinutes` is reported as an estimate too --
    // that's the safe direction to be wrong in.
    isEstimate: minutes === fallbackMinutes && OVERRIDES[movieTitle] == null,
  };
}

async function getRuntimeMinutes(movieTitle, fallbackMinutes, additionalSource) {
  if (OVERRIDES[movieTitle] != null) {
    return OVERRIDES[movieTitle];
  }

  // Resolves to a value on a hit, or to the first caller's in-flight promise.
  if (cache.has(movieTitle)) {
    return cache.get(movieTitle);
  }

  const lookup = resolveRuntime(movieTitle, fallbackMinutes, additionalSource);
  cache.set(movieTitle, lookup);
  // Replace the stored promise with its resolved value once it settles, so a
  // later caller gets the number directly instead of an extra microtask hop.
  // On rejection, drop the entry entirely rather than caching a failure that
  // would deny every future caller a retry -- resolveRuntime already handles
  // its own errors, so this is belt-and-braces.
  lookup.then(
    (value) => cache.set(movieTitle, value),
    () => cache.delete(movieTitle)
  );
  return lookup;
}

async function resolveRuntime(movieTitle, fallbackMinutes, additionalSource) {

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
      // No cache.set here (nor at the other return points below):
      // getRuntimeMinutes caches this function's promise and swaps in the
      // resolved value. Writing the cache from in here as well would clobber
      // the in-flight promise mid-flight, which is exactly what concurrent
      // callers are sharing.
      if (fromAdditionalSource != null) return fromAdditionalSource;
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

    // Bound the wait: this used to have no timeout, so a hung SerpApi held up
    // every search that needed this title.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SERPAPI_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${BASE_URL}?${params.toString()}`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`SerpApi request failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();

    const minutes = findDurationInObject(data.knowledge_graph);
    if (minutes) return minutes;

    console.error(
      `Runtime lookup: no duration-shaped value found in knowledge_graph for "${movieTitle}" -- ` +
      `falling back to ${fallbackMinutes} min. knowledge_graph keys seen: ` +
      `${data.knowledge_graph ? Object.keys(data.knowledge_graph).join(", ") : "(no knowledge_graph in response)"}`
    );
  } catch (err) {
    console.error(`Runtime lookup failed for "${movieTitle}":`, err.message);
  }

  return fallbackMinutes;
}

module.exports = { getRuntimeMinutes, getRuntimeInfo, parseDurationToMinutes };
