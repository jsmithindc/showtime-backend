const fetch = require("node-fetch");
const imdbDataset = require("./imdb-dataset");

// Ratings from MDBList — aggregates IMDb, Rotten Tomatoes (tomatometer +
// audience), and Metacritic in one API call. Used in place of OMDb + the RT
// scraper when MDBLIST_API_KEY is set.
//
// Lookup is two requests per title: search (title+year → IMDb ID) then media
// info (IMDb ID → full ratings). Both are cheap; the caching layer in
// movie-ratings.js means each title is looked up at most once per 12h.
//
// MDBList does NOT serve poster images, so artwork still comes from the IMDb
// official dataset (already fetched for the exact score anyway).

const BASE = "https://api.mdblist.com";
const TIMEOUT_MS = 6000;

function isConfigured() {
  return !!process.env.MDBLIST_API_KEY;
}

async function mdbFetch(path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set("apikey", process.env.MDBLIST_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const safeUrl = url.toString().replace(/apikey=[^&]+/, "apikey=REDACTED");
  console.error(`MDBList fetch start: ${safeUrl}`);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    console.error(`MDBList AbortController firing for ${path}`);
    controller.abort();
  }, TIMEOUT_MS);
  const hardTimeout = new Promise((_, reject) =>
    setTimeout(() => {
      console.error(`MDBList hard timeout firing for ${path}`);
      reject(new Error(`MDBList ${path}: timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS + 1000)
  );
  try {
    const result = await Promise.race([
      fetch(url.toString(), { signal: controller.signal }).then((res) => {
        console.error(`MDBList fetch got response: ${path} status=${res.status}`);
        if (!res.ok) throw new Error(`MDBList ${path}: HTTP ${res.status}`);
        return res.json().then((data) => {
          console.error(`MDBList fetch parsed JSON: ${path}`);
          return data;
        });
      }),
      hardTimeout,
    ]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function ratingValue(ratings, source) {
  const r = (ratings || []).find((x) => x.source === source);
  return r != null && r.value != null ? r.value : null;
}

// IMDb ID lives at result.imdb_id or nested under result.ids.imdb.
function extractImdbId(obj) {
  return obj.imdb_id || obj.ids?.imdb || null;
}

async function fetchRatings(title, year) {
  // Step 1: search by title + year. If no results, retry without year constraint
  // (MDBList may not have the year indexed yet for brand-new releases).
  let search = await mdbFetch("/search/movie", { query: title, year, limit: 5 });
  let results = search.search || [];
  if (!results.length) {
    console.error(`MDBList for "${title}" (${year}): year-scoped search returned 0 results, retrying without year`);
    search = await mdbFetch("/search/movie", { query: title, limit: 5 });
    results = search.search || [];
  }
  if (!results.length) {
    console.error(`MDBList for "${title}" (${year}): no results even without year constraint`);
    return null;
  }

  // Pick the closest match: exact title+year first, then relax to ±1 year.
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(title);
  let best = null;
  for (const r of results) {
    if (norm(r.title) === target && r.year === year) { best = r; break; }
  }
  if (!best) {
    for (const r of results) {
      if (norm(r.title) === target && Math.abs((r.year || 0) - year) <= 1) { best = r; break; }
    }
  }
  if (!best) best = results[0]; // top result as last resort

  const imdbId = extractImdbId(best);
  if (!imdbId) return null;

  // Step 2: full media info (ratings array) by IMDb ID.
  const media = await mdbFetch(`/imdb/movie/${imdbId}/`);
  if (!media) return null;

  const ratings = media.ratings || [];

  // IMDb score — prefer the official daily dataset for accuracy.
  const imdbRaw = ratingValue(ratings, "imdb");
  const fromDataset = await imdbDataset.ensureRating(imdbId);
  const imdb = fromDataset ?? (typeof imdbRaw === "number" ? imdbRaw : null);

  const result = {
    imdbId,
    imdbIsExact: fromDataset != null,
    imdb: imdb != null && Number.isFinite(imdb) ? imdb : null,
    rottenTomatoes: ratingValue(ratings, "tomatoes"),   // tomatometer 0-100
    rtAudience:     ratingValue(ratings, "audience"),   // audience score 0-100
    metacritic:     ratingValue(ratings, "metacritic"), // 0-100
    // MDBList doesn't serve poster URLs; artwork comes from the IMDb dataset.
    poster: null,
    matchedTitle: media.title || best.title || null,
    year: String(media.year || best.year || ""),
    // RT-specific flags MDBList doesn't expose.
    rtCertifiedFresh: null,
    rtVerifiedHot: null,
    rtUrl: null,
  };

  if (result.imdb == null && result.rottenTomatoes == null &&
      result.rtAudience == null && result.metacritic == null) {
    console.error(`MDBList for "${title}": matched "${result.matchedTitle}" (${result.year}) but no scores found.`);
    return null;
  }

  const have = [
    result.imdb != null            ? `imdb ${result.imdb}`            : null,
    result.rottenTomatoes != null  ? `rt ${result.rottenTomatoes}%`   : null,
    result.rtAudience != null      ? `audience ${result.rtAudience}%` : null,
    result.metacritic != null      ? `mc ${result.metacritic}`        : null,
  ].filter(Boolean).join(", ") || "nothing";
  console.error(
    `MDBList for "${title}" -> matched "${result.matchedTitle}" (${result.year}): ${have}` +
    (result.imdb != null ? ` [imdb ${result.imdbIsExact ? "official dataset" : "mdblist"}]` : "")
  );

  imdbDataset.refreshInBackground();
  return result;
}

module.exports = { isConfigured, fetchRatings };
