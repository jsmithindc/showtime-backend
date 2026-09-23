const fetch = require("node-fetch");
const imdbDataset = require("./imdb-dataset");

// Ratings from MDBList — aggregates IMDb, Rotten Tomatoes (tomatometer +
// audience), and Metacritic. Used in place of OMDb + the RT scraper when
// MDBLIST_API_KEY is set; movie-ratings.js falls back to those when this
// returns null.
//
// Two requests per title: search (title+year -> some provider ID) then title
// lookup (that ID -> ratings). The caching layer in movie-ratings.js means each
// title is looked up at most once per 12h.
//
// The published OpenAPI schema leaves search results untyped, and the first
// live run proved `ids.imdb` (the shape the title lookup uses) is NOT where
// search puts it. The lookup accepts imdb/tmdb/trakt/mdblist IDs and returns
// `imdb_id` itself, so step 2 uses whichever ID search happens to carry.

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`MDBList ${path}: HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function ratingValue(ratings, ...sources) {
  for (const source of sources) {
    const r = (ratings || []).find((x) => x.source === source);
    if (r != null && typeof r.value === "number") return r.value;
  }
  return null;
}

function lookupId(r) {
  const ids = r.ids || {};
  const imdb = ids.imdb || ids.imdbid || r.imdb_id || r.imdbid ||
    (/^tt\d+$/.test(String(r.id)) ? r.id : null);
  if (imdb) return { provider: "imdb", id: imdb };
  const tmdb = ids.tmdb || ids.tmdbid || r.tmdb_id || r.tmdbid;
  if (tmdb) return { provider: "tmdb", id: tmdb };
  const trakt = ids.trakt || ids.traktid || r.trakt_id || r.traktid;
  if (trakt) return { provider: "trakt", id: trakt };
  const mdb = ids.mdblist || ids.mdblistid || r.mdblist_id;
  if (mdb) return { provider: "mdblist", id: mdb };
  return null;
}

async function fetchRatings(title, year) {
  // The `year` param already matches +/-1 year. No unscoped retry: an
  // unqualified search is exactly how a same-titled older film gets matched.
  const search = await mdbFetch("/search/movie", { query: title, year, limit: 5 });
  const results = search.search || [];

  // Title must match. A miss returns null so OMDb (with its own guards) gets a
  // turn, rather than taking results[0] and risking a different film.
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(title);
  const sameTitle = results.filter((r) => norm(r.title) === target);
  const best = sameTitle.find((r) => r.year === year) || sameTitle[0];
  if (!best) return null;

  const ref = lookupId(best);
  if (!ref) {
    const idKeys = best.ids && typeof best.ids === "object" ? ` ids{${Object.keys(best.ids).join(",")}}` : "";
    console.error(`MDBList for "${title}": search result carries no usable ID -- fields: ${Object.keys(best).join(",")}${idKeys}`);
    return null;
  }

  const media = await mdbFetch(`/${ref.provider}/movie/${ref.id}/`);
  if (!media) return null;
  const ratings = media.ratings || [];
  const imdbId = media.imdb_id || media.ids?.imdb || (ref.provider === "imdb" ? ref.id : null);

  // IMDb score — prefer the official daily dataset for accuracy.
  const fromDataset = imdbId ? await imdbDataset.ensureRating(imdbId) : null;
  const imdb = fromDataset ?? ratingValue(ratings, "imdb");

  const result = {
    imdbId,
    imdbIsExact: fromDataset != null,
    imdb: imdb != null && Number.isFinite(imdb) ? imdb : null,
    rottenTomatoes: ratingValue(ratings, "tomatoes"),
    // RT's audience score has appeared under both names in MDBList payloads.
    rtAudience: ratingValue(ratings, "popcorn", "audience"),
    metacritic: ratingValue(ratings, "metacritic"),
    // Not in the published schema; used when present, and movie-ratings.js
    // fills it from OMDb when not.
    poster: typeof media.poster === "string" && /^https?:\/\//.test(media.poster) ? media.poster : null,
    matchedTitle: media.title || best.title || null,
    year: String(media.year || best.year || ""),
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
    result.imdb != null           ? `imdb ${result.imdb}`            : null,
    result.rottenTomatoes != null ? `rt ${result.rottenTomatoes}%`   : null,
    result.rtAudience != null     ? `audience ${result.rtAudience}%` : null,
    result.metacritic != null     ? `mc ${result.metacritic}`        : null,
    result.poster                 ? "poster"                         : null,
  ].filter(Boolean).join(", ");
  console.error(
    `MDBList for "${title}" -> matched "${result.matchedTitle}" (${result.year}) via ${ref.provider}: ${have}` +
    (result.imdb != null ? ` [imdb ${result.imdbIsExact ? "official dataset" : "mdblist"}]` : "")
  );

  imdbDataset.refreshInBackground();
  return result;
}

module.exports = { isConfigured, fetchRatings };
