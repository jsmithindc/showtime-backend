const fetch = require("node-fetch");
const imdbDataset = require("./imdb-dataset");
const rtScores = require("./rt-scores");
const { readCache, writeCache } = require("./disk-cache");

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

// OMDb's ?t= returns a single best guess and its type filter is loose, so a
// tangential product with a similar name gets through. Confirmed live: "Harry
// Potter and the Half-Blood Prince" matched the AUDIOBOOK ("...: Full-Cast
// Edition - Book 6"), and "...Sorcerer's Stone" matched "...in Shared Reality".
// Both are 2026 releases, so the year guard let them pass.
//
// Accept an exact match, or a modestly longer one (a real subtitle). Reject
// anything carrying a non-film product marker, or substantially longer than
// what was asked for -- that's a different work, not a different edition.
const NON_FILM_MARKERS = /\b(audiobook|unabridged|full cast|book \d|edition|soundtrack|commentary|behind the scenes|making of)\b/;

function titlesMatch(requested, matched) {
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = norm(requested);
  const b = norm(matched);
  if (!a || !b) return false;
  if (a === b) return true;
  if (NON_FILM_MARKERS.test(b)) return false;
  return b.startsWith(a) && b.length <= a.length * 1.25 + 4;
}

function parsePercent(value) {
  const m = /^(\d{1,3})%$/.exec(String(value || "").trim());
  return m ? Number(m[1]) : null;
}

// OMDb's top-level Metascore is a bare "74" (or "N/A").
function parseBareScore(value) {
  const m = /^(\d{1,3})$/.exec(String(value || "").trim());
  const n = m ? Number(m[1]) : null;
  return n != null && n >= 0 && n <= 100 ? n : null;
}

// Metacritic reports "74/100"; IMDb's top-level field is a bare "7.8".
function parseOutOf100(value) {
  const m = /^(\d{1,3})\s*\/\s*100$/.exec(String(value || "").trim());
  return m ? Number(m[1]) : null;
}

// How far from the expected release year a match may sit before it's rejected.
// A film in theaters now is from this year or last; anything else with the same
// title is a different film.
const YEAR_TOLERANCE = 1;

async function omdbLookup(title, year) {
  const params = new URLSearchParams({
    t: title,
    type: "movie",
    apikey: process.env.OMDB_API_KEY,
  });
  if (year) params.set("y", String(year));

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
  return data;
}

// OMDb's ?t= lookup returns ONE match and, with no year, tends to return the
// oldest/best-known film of that name. Cinema listings are full of short
// generic titles -- Buddy, Idiots, Mutiny, Tony, Colony -- so an unqualified
// lookup quietly returns a decades-old namesake. Reported live: 80% RT / 6.1
// IMDb against a film actually scoring 93% / 7.6.
//
// So: ask for the expected year first, then the year before (a December
// release is still playing in January), and only then fall back to an
// unqualified lookup -- which is accepted ONLY if the year it comes back with
// is close enough to be the same film.
async function fetchRatings(title, yearHint) {
  const year = Number(yearHint) || new Date().getFullYear();
  let data = await omdbLookup(title, year);
  if (!data) data = await omdbLookup(title, year - 1);
  if (!data) {
    const loose = await omdbLookup(title, null);
    const looseYear = loose ? parseInt(String(loose.Year).slice(0, 4), 10) : NaN;
    // Without this guard the fallback reintroduces the exact bug above.
    data = Number.isFinite(looseYear) && Math.abs(looseYear - year) <= YEAR_TOLERANCE ? loose : null;
  }
  if (!data) return null;

  // Right year, wrong work -- see titlesMatch.
  if (!titlesMatch(title, data.Title)) {
    console.error(`Ratings for "${title}": rejected OMDb match "${data.Title}" (${data.Year}) -- different work, not the film.`);
    return null;
  }

  const byName = {};
  for (const r of data.Ratings || []) byName[r.Source] = r.Value;

  // OMDb's own rating is a periodic snapshot and drifts (~0.1 high in practice).
  // Its imdbID, though, is exact -- and that's the key into IMDb's official
  // daily export, which carries the real current figure. Register the ID so the
  // dataset starts tracking it, and prefer the dataset's number whenever it has
  // one. OMDb's stays as the immediate answer, including on the very first
  // sighting of a film, before any refresh has run.
  const imdbId = data.imdbID || null;
  // Awaited, not fire-and-forget: the dataset read is ~0.6s and concurrent
  // titles share one batched run, so the FIRST search shows the exact figure
  // rather than a stale one plus an instruction to search again.
  const fromDataset = imdbId ? await imdbDataset.ensureRating(imdbId) : null;

  const imdb = fromDataset ?? Number(data.imdbRating);
  const ratings = {
    imdbId,
    imdbIsExact: fromDataset != null,
    imdb: Number.isFinite(imdb) ? imdb : null,                       // 0-10
    rottenTomatoes: parsePercent(byName["Rotten Tomatoes"]),         // 0-100
    // The Ratings[] entry is sourced "Metacritic" and formatted "74/100".
    // "Metascore" is a DIFFERENT, top-level field holding a bare "74" -- I had
    // been looking that name up inside Ratings[], where it never appears, so
    // Metacritic silently never resolved. Read the correct entry, and fall back
    // to the top-level field for records that carry one but no Ratings row.
    metacritic: parseOutOf100(byName["Metacritic"]) ?? parseBareScore(data.Metascore),
    // OMDb returns a poster URL on the lookup we're already making, so artwork
    // costs no extra request. "N/A" is its miss value, not a URL.
    poster: data.Poster && data.Poster !== "N/A" ? data.Poster : null,
    matchedTitle: data.Title || null,
    year: data.Year || null,
  };

  // Nothing to show at all. Note the poster counts: a film OMDb knows but has
  // no scores for still has artwork worth displaying, and returning null here
  // used to throw that away along with the scores.
  if (ratings.imdb == null && ratings.rottenTomatoes == null &&
      ratings.metacritic == null && ratings.poster == null) {
    console.error(`Ratings for "${title}": matched "${ratings.matchedTitle}" (${ratings.year}) but it carries no scores or poster.`);
    return null;
  }

  // What OMDb ITSELF returned -- not the final score set. RT is fetched in
  // parallel and merged after this point (see getRatings/mergeRatings), so a
  // Tomatometer can never appear on this line even when the scrape succeeded;
  // that one logs separately as `RT for "..."`. Labelled "OMDb for" for exactly
  // that reason: reading it as the finished picture makes a working RT scrape
  // look broken.
  //
  // OMDb's critic aggregates lag well behind IMDb for new releases -- most
  // films in theatres now have an IMDb score and no RT or Metacritic entry yet.
  // Logged once per title (results are cached) so a missing score is visibly
  // OMDb's coverage rather than a guess about whether parsing broke. Also
  // prints the matched title and year, which is how a wrong-film match would
  // show itself.
  const have = [
    ratings.imdb != null ? `imdb ${ratings.imdb}` : null,
    ratings.rottenTomatoes != null ? `rt ${ratings.rottenTomatoes}%` : null,
    ratings.metacritic != null ? `mc ${ratings.metacritic}` : null,
    ratings.poster ? "poster" : null,
  ].filter(Boolean).join(", ") || "nothing";
  console.error(
    `OMDb for "${title}" -> matched "${ratings.matchedTitle}" (${ratings.year}): ${have}` +
    (ratings.imdb != null ? ` [imdb ${ratings.imdbIsExact ? "official dataset" : "OMDb snapshot"}]` : "")
  );

  // Keeps the daily staleness refresh ticking; the per-title fetch above
  // already handles anything newly seen.
  imdbDataset.refreshInBackground();

  return ratings;
}

// RT's own pages beat OMDb for the Tomatometer: OMDb carries it only
// sporadically for films currently in theatres, and it has no audience score at
// all. Everything else still comes from OMDb.
function mergeRatings(omdb, rt) {
  if (!omdb && !rt) return null;
  const merged = { ...(omdb || {}) };
  if (rt) {
    // OMDb's poster wins when it has one; RT fills the gap otherwise.
    if (!merged.poster && rt.poster) merged.poster = rt.poster;
    if (rt.tomatometer != null) merged.rottenTomatoes = rt.tomatometer;
    merged.rtAudience = rt.audience ?? null;
    merged.rtCertifiedFresh = rt.certifiedFresh;
    merged.rtVerifiedHot = rt.verifiedHot;
    merged.rtUrl = rt.url;
  }
  return merged;
}

async function getRatings(rawTitle, yearHint) {
  if (!isConfigured()) return null;

  const normalized = normalizeTitle(rawTitle);
  if (!normalized) return null;

  // Year is part of the identity: the same title in different years is a
  // different film, so it must be part of the cache key too.
  const year = Number(yearHint) || new Date().getFullYear();
  // Case- and punctuation-insensitive cache key. Chains title the same film
  // differently -- one live search asked for "Coyote vs. ACME", "Coyote vs.
  // Acme" AND "Coyote vs Acme", plus two casings each of PAW Patrol and
  // Teenage Sex and Death at Camp Miasma. Keying on the display form meant a
  // separate OMDb call and a separate dataset entry per variant, spending
  // quota to learn the same answer three times.
  //
  // The QUERY still uses the properly-cased title -- only the key is folded.
  const title = `${normalized.toLowerCase().replace(/[^a-z0-9]+/g, "")}::${year}`;

  const hit = cache.get(title);
  if (hit && (hit.promise || Date.now() - hit.at < CACHE_TTL_MS)) {
    return hit.promise || hit.value;
  }

  // Shared tier before the network. This payload is where the POSTER URL lives
  // as well as the scores, so keeping it only in memory meant every redeploy
  // re-fetched artwork the app had already resolved -- and spent OMDb's free
  // 1000/day doing it, at 20-30 titles per window search.
  const promise = (async () => {
    const shared = await readCache(`ratings-${title}`, CACHE_TTL_MS).catch(() => null);
    if (shared !== null && shared !== undefined) {
      // `null` is a legitimate cached answer ("OMDb doesn't have this"), so it
      // is stored wrapped -- an unwrapped null would be indistinguishable from
      // a cache miss and re-asked forever.
      return shared.value ?? null;
    }
    // OMDb and RT are asked in parallel and merged. RT is optional and gated
    // separately, so either can fail without taking the other down.
    const value = await Promise.all([
      fetchRatings(normalized, year).catch((err) => {
        console.error(`Ratings lookup failed for "${normalized}":`, err.message);
        return null;
      }),
      rtScores.getScores(normalized, year).catch(() => null),
    ]).then(([omdb, rt]) => mergeRatings(omdb, rt));
    writeCache(`ratings-${title}`, { value }, CACHE_TTL_MS);
    return value;
  })();

  cache.set(title, { promise });
  const value = await promise;
  // A miss is cached too: an unknown title stays unknown, and re-asking every
  // search would spend the daily quota on questions already answered.
  cache.set(title, { value, at: Date.now() });
  return value;
}

module.exports = { getRatings, isConfigured, normalizeTitle };
