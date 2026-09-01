const fetch = require("node-fetch");

// Critic/audience scores for a film, from OMDb.
//
// OMDb is used rather than hitting Rotten Tomatoes, Metacritic and IMDb
// separately because a single lookup returns all three: IMDb's own rating on
// the top-level `imdbRating`, and RT and Metacritic inside `Ratings[]`. None
// of those three has a free public API of its own, and scraping them is both
// fragile and against their terms.
//
// Requires OMDB_API_KEY. Free tier is 1,000 requests/day, which is far more
// than this app needs given how hard the results are cached: a film's score
// barely moves day to day, so a long TTL costs nothing in accuracy.
//
// Gated like every other adapter here -- with no key set, getRatings returns
// null and callers carry on without scores rather than failing.

const BASE_URL = "https://www.omdbapi.com/";
const REQUEST_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// Values AND in-flight promises, same reasoning as the runtime lookup: a
// window search resolves 20+ titles at once and repeat searches are common, so
// concurrent callers for one title must share a single request.
const cache = new Map();

// Set when OMDb rejects the key. A 401 is a configuration fact, not a
// transient failure: it will be true for every subsequent title in the same
// way. Without this, one bad key produced a request and a log line PER TITLE
// -- 18 of each on a single window search, all guaranteed to fail.
let keyRejected = false;

function isConfigured() {
  return !!process.env.OMDB_API_KEY && !keyRejected;
}

// Cinema listings decorate titles in ways OMDb won't match. Regal shows
// "HP26: Harry Potter and the Chamber of Secrets" for a re-release series,
// "Colony (Korean)" for a subtitled print, and anniversary screenings carry a
// "- 25th Anniversary" suffix. The underlying film is the same one OMDb knows
// under its plain title.
function normalizeTitle(rawTitle) {
  return String(rawTitle || "")
    // Digit REQUIRED in the prefix: series markers look like "HP26:" / "MOM2:",
    // whereas a real title such as "AI: Artificial Intelligence" has none and
    // must survive intact.
    .replace(/^[A-Z]{2,4}\d{1,2}:\s*/, "")
    .replace(/\s*[-–]\s*\d+(st|nd|rd|th)\s+Anniversary.*$/i, "")
    .replace(/\s+\d+(st|nd|rd|th)\s+Anniv(ersary)?\.?$/i, "")
    .replace(/\s*\((Korean|Japanese|Mandarin|Spanish|Hindi|Subtitled|Dubbed|3D|IMAX)\)\s*$/i, "")
    .replace(/\s*\b(3D|IMAX|RPX|4DX|ScreenX)\b\s*$/i, "")
    // Trailing separator left behind once a suffix is stripped, e.g.
    // "Harry Potter and the Sorcerer's Stone:" after the 25th-anniversary
    // marker goes. OMDb won't match a title ending in punctuation.
    .replace(/[\s:;,\-–]+$/, "")
    .trim();
}

function parsePercent(value) {
  const m = /^(\d{1,3})%$/.exec(String(value || "").trim());
  return m ? Number(m[1]) : null;
}

// Metacritic reports "74/100"; IMDb's top-level field is a bare "7.8".
function parseOutOf100(value) {
  const m = /^(\d{1,3})\s*\/\s*100$/.exec(String(value || "").trim());
  return m ? Number(m[1]) : null;
}

async function fetchRatings(title) {
  const params = new URLSearchParams({
    t: title,
    type: "movie",
    apikey: process.env.OMDB_API_KEY,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE_URL}?${params.toString()}`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    // Almost always an unactivated key: OMDb emails an activation link and the
    // key returns 401 until it's clicked. Say so, once, rather than repeating
    // an opaque status code for every film.
    keyRejected = true;
    throw new Error(
      "OMDb rejected the API key (401). If it's new, check the activation email " +
      "from OMDb and click the link -- keys return 401 until activated. Ratings " +
      "are disabled for the rest of this process; restart after fixing the key."
    );
  }
  if (!res.ok) throw new Error(`OMDb request failed: ${res.status} ${res.statusText}`);

  const data = await res.json();
  // OMDb answers 200 with {Response:"False"} for a title it doesn't know --
  // a miss, not an error, so don't throw and don't retry it.
  if (data.Response === "False") return null;

  const byName = {};
  for (const r of data.Ratings || []) byName[r.Source] = r.Value;

  const imdb = Number(data.imdbRating);
  const ratings = {
    imdb: Number.isFinite(imdb) ? imdb : null,                       // 0-10
    rottenTomatoes: parsePercent(byName["Rotten Tomatoes"]),         // 0-100
    metacritic: parseOutOf100(byName["Metascore"]),                  // 0-100
    matchedTitle: data.Title || null,
    year: data.Year || null,
  };

  // Nothing worth showing -- treat as a miss so the card stays clean.
  if (ratings.imdb == null && ratings.rottenTomatoes == null && ratings.metacritic == null) {
    return null;
  }
  return ratings;
}

async function getRatings(rawTitle) {
  if (!isConfigured()) return null;

  const title = normalizeTitle(rawTitle);
  if (!title) return null;

  const hit = cache.get(title);
  if (hit && (hit.promise || Date.now() - hit.at < CACHE_TTL_MS)) {
    return hit.promise || hit.value;
  }

  const promise = fetchRatings(title).catch((err) => {
    console.error(`Ratings lookup failed for "${title}":`, err.message);
    return null;
  });
  cache.set(title, { promise });
  const value = await promise;
  // A miss is cached too: an unknown title stays unknown, and re-asking every
  // search would spend the daily quota on questions already answered.
  cache.set(title, { value, at: Date.now() });
  return value;
}

module.exports = { getRatings, isConfigured, normalizeTitle };
