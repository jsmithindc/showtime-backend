const fetch = require("node-fetch");

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const BASE_URL = "https://serpapi.com/search.json";

// One call per theater, NOT per (movie, theater) pair. Querying just
// "<theater> showtimes" reliably returns that theater's whole day of
// movies -- querying "<movie> showtimes at <theater>" was inconsistent:
// sometimes Google narrowed to the one movie, sometimes it ignored the
// movie name and returned the full schedule anyway (with the requested
// movie mixed in among everything else). Theater-only is more predictable,
// and as a bonus the raw schedule can now be cached and reused across any
// movie search for that theater/day, not just one.
async function fetchTheaterSchedule({ theaterName, location }) {
  if (!SERPAPI_KEY) {
    throw new Error("SERPAPI_KEY environment variable is not set");
  }

  const params = new URLSearchParams({
    engine: "google",
    // Deliberately NOT including the search origin's location in the
    // query text itself (just theaterName + "showtimes") -- confirmed
    // real bug: for a theater outside the origin's own city, embedding
    // both created a conflicting query like "AMC Orange 30 showtimes
    // Cerritos,California,United States", which returned zero results
    // via SerpApi despite Google's own UI having full real showtimes
    // for that exact theater with a plain "amc 30 orange showtimes"
    // search. The separate `location` param below already handles
    // geographic biasing correctly -- no need to also stuff a
    // potentially-wrong city name into the query text.
    q: `${theaterName} showtimes`,
    location,
    api_key: SERPAPI_KEY,
  });

  const res = await fetch(`${BASE_URL}?${params.toString()}`);

  // SerpApi returns a JSON body even on 4xx/5xx responses, explaining what
  // was actually wrong (bad key, unrecognized location, quota exceeded,
  // etc). Surface that instead of just the bare status code, since "400
  // Bad Request" alone gives no way to tell those apart.
  let data;
  try {
    data = await res.json();
  } catch {
    if (!res.ok) {
      throw new Error(`SerpApi request failed: ${res.status} ${res.statusText}`);
    }
    throw new Error("SerpApi returned a non-JSON response");
  }

  if (!res.ok) {
    throw new Error(
      `SerpApi request failed: ${res.status} ${res.statusText} -- ${
        data.error || JSON.stringify(data)
      }`
    );
  }

  if (data.search_metadata?.status === "Error") {
    throw new Error(data.error || "SerpApi returned an error");
  }

  return data.showtimes || [];
}

// Google's widget labels near-term days as "Today"/"Tomorrow" (reliable),
// then presumably switches to actual dates further out -- but that's
// unconfirmed against a live response for 2+ days out. For those, try
// matching an actual date field if the block has one; this hasn't been
// verified live, so treat multi-day-out results as a first pass to
// sanity-check rather than fully trusted.
function dayOffsetLabel(offsetDays) {
  if (offsetDays === 0) return "Today";
  if (offsetDays === 1) return "Tomorrow";
  return null;
}

function isSameCalendarDate(dateStrA, dateStrB) {
  const a = new Date(dateStrA);
  const b = new Date(dateStrB);
  if (isNaN(a) || isNaN(b)) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Google's showtimes widget doesn't reliably include ticket price -- it's
// present for some theaters/regions, absent for most. This flattens the
// response into one entry per time+format, keeping the movie name on each
// entry so callers can filter down to the one they actually asked about --
// a theater's schedule includes every movie playing there, not just yours.
//
// targetDateISO: "YYYY-MM-DD" for the date being searched. Defaults to
// today if omitted (preserves old behavior for any caller not yet passing
// a date).
function flattenShowtimes(showtimesBlocks, targetDateISO) {
  const dateISO = targetDateISO || new Date().toISOString().slice(0, 10);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateISO}T00:00:00`);
  const offsetDays = Math.round((target - today) / 86400000);
  const expectedLabel = dayOffsetLabel(offsetDays);

  const entries = [];
  for (const day of showtimesBlocks) {
    const matches = expectedLabel
      ? day.day === expectedLabel
      : day.date
      ? isSameCalendarDate(day.date, dateISO)
      : false;
    if (!matches) continue;

    for (const movie of day.movies || []) {
      for (const group of movie.showing || []) {
        for (const time of group.time || []) {
          entries.push({
            movieName: movie.name || null,
            time, // e.g. "7:15pm"
            format: group.type || "Standard",
            price: group.price ?? null, // null when Google doesn't show one
            link: movie.link || null,
          });
        }
      }
    }
  }
  return entries;
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "") // strip punctuation like ":" and "(IMAX)" parens
    .replace(/\s+/g, " ")
    .trim();
}

// Loose containment match rather than exact equality, since Google
// sometimes appends things like "(IMAX)" to a title, or a target title
// might be given with slightly different punctuation than Google's.
function matchesMovie(entryMovieName, targetTitle) {
  if (!entryMovieName) return false;
  const a = normalizeTitle(entryMovieName);
  const b = normalizeTitle(targetTitle);
  return a.includes(b) || b.includes(a);
}

// Caches the raw per-theater schedule (all movies), independent of which
// movie you're currently searching for -- so a second search for a
// different movie at an already-seen theater/date costs zero extra
// SerpApi calls. Cache key includes the date since a theater's schedule
// obviously differs day to day.
//
// Persisted to disk, not just in-memory -- confirmed real problem: this
// project ships a new server restart almost every time a code change
// goes out, which was silently wiping out the in-memory cache's benefit
// each time. A restart-surviving cache matters a lot more once SerpApi
// usage is actually tight (220/250 for the month as of this comment).
// Entries older than 3 days are dropped on load -- a theater's schedule
// from days ago is useless and there's no reason to let this file grow
// forever.
const fs = require("fs");
const path = require("path");
const CACHE_FILE = path.join(__dirname, "..", "..", ".serpapi-schedule-cache.json");
const CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function loadCacheFromDisk() {
  const map = new Map();
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed)) {
      if (now - entry.savedAt < CACHE_MAX_AGE_MS) {
        map.set(key, entry.entries);
      }
    }
    console.error(`SerpApi schedule cache: loaded ${map.size} entries from disk (dropped anything older than 3 days).`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("SerpApi schedule cache: couldn't load from disk, starting fresh:", err.message);
    }
  }
  return map;
}

function saveCacheToDisk(map) {
  try {
    const obj = {};
    for (const [key, entries] of map.entries()) {
      obj[key] = { entries, savedAt: Date.now() };
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (err) {
    console.error("SerpApi schedule cache: couldn't save to disk:", err.message);
  }
}

const scheduleCache = loadCacheFromDisk();

async function getTheaterSchedule({ theaterName, location, dateISO }) {
  const cacheKey = `${theaterName}::${location}::${dateISO || "today"}`;
  if (scheduleCache.has(cacheKey)) {
    return scheduleCache.get(cacheKey);
  }

  const raw = await fetchTheaterSchedule({ theaterName, location });
  const entries = flattenShowtimes(raw, dateISO);
  scheduleCache.set(cacheKey, entries);
  saveCacheToDisk(scheduleCache);
  return entries;
}

async function getPricedShowtimes({ movieTitle, theaterName, location, dateISO }) {
  const allEntries = await getTheaterSchedule({ theaterName, location, dateISO });
  return allEntries.filter((e) => matchesMovie(e.movieName, movieTitle));
}

module.exports = { getPricedShowtimes, getTheaterSchedule, flattenShowtimes, matchesMovie };
