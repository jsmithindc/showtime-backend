const fetch = require("node-fetch");
const zlib = require("zlib");
const readline = require("readline");
const { readDiskCache, writeDiskCache } = require("./disk-cache");

// Authoritative IMDb ratings, from IMDb's own daily dataset export.
//
// OMDb serves a periodic snapshot rather than live IMDb, so its scores drift --
// reported live as consistently ~0.1 above imdb.com, because ratings settle
// downward as votes accumulate past the early enthusiast wave. This reads the
// real thing instead. Same approach the jellyfin-ratings-plugin uses.
//
// Only title.ratings.tsv.gz is needed (8.2 MB, refreshed daily). The companion
// title.basics.tsv.gz, which maps titles to IDs, is 216 MB and deliberately NOT
// used: OMDb already returns imdbID on the lookup this app makes anyway, so the
// ID arrives for free and the huge file is unnecessary.
//
// IMDb's Non-Commercial Datasets are free for personal, non-commercial use,
// which is what this project is. Attribution is required and is surfaced in the
// UI: "Information courtesy of IMDb (imdb.com). Used with permission."
const DATASET_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";

// The file is regenerated daily. Refresh a little under that so a stale copy
// is never served for a full extra day.
const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;
const CACHE_KEY = "imdb-ratings-subset";

// Only the IDs this app has actually asked about are retained. Holding all
// ~1.5M rows would cost well over a hundred megabytes of heap for the sake of
// the ~30 films playing nearby -- far past what a small instance should spend.
let ratingsById = null;          // { tconst: rating }
let interestedIds = new Set();   // IDs seen but not yet in the subset
let lastRefreshAt = 0;
let refreshPromise = null;

function load() {
  if (ratingsById) return ratingsById;
  const cached = readDiskCache(CACHE_KEY, REFRESH_AFTER_MS * 100) || {};
  ratingsById = cached.ratings || {};
  lastRefreshAt = cached.fetchedAt || 0;
  return ratingsById;
}

// Register an IMDb ID as worth tracking. Called with whatever OMDb returns, so
// the set grows to cover what's actually playing rather than being configured.
function noteInterest(tconst) {
  if (!tconst || !/^tt\d+$/.test(tconst)) return;
  load();
  if (!(tconst in ratingsById)) interestedIds.add(tconst);
}

function getRating(tconst) {
  if (!tconst) return null;
  const map = load();
  return map[tconst] ?? null;
}

// Streams the gzip straight through a line reader. The file is never held in
// memory or written to disk whole -- rows are matched against the wanted set as
// they go past, so peak memory is a few KB regardless of file size.
async function refresh() {
  const map = load();
  const wanted = new Set([...Object.keys(map), ...interestedIds]);
  if (wanted.size === 0) return map;   // nothing to look up yet

  const res = await fetch(DATASET_URL);
  if (!res.ok) throw new Error(`IMDb dataset request failed: ${res.status} ${res.statusText}`);

  const rl = readline.createInterface({
    input: res.body.pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  const next = {};
  let found = 0;
  for await (const line of rl) {
    // tconst \t averageRating \t numVotes
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const id = line.slice(0, tab);
    if (!wanted.has(id)) continue;
    const rating = parseFloat(line.slice(tab + 1, line.indexOf("\t", tab + 1)));
    if (Number.isFinite(rating)) { next[id] = rating; found++; }
    // Every wanted row seen -- stop reading rather than scanning the remaining
    // million-odd lines for nothing.
    if (found === wanted.size) break;
  }
  rl.close();

  // Merge, don't replace: a refresh only resolves the IDs it set out to find,
  // and anything already known should survive a run that didn't include it.
  ratingsById = { ...map, ...next };
  lastRefreshAt = Date.now();
  // Remove ONLY the IDs this run actually covered. Clearing the whole set threw
  // away every ID registered while the download was in flight -- and since the
  // first rating of a search triggers the refresh, that was nearly all of them:
  // a live run reported "refreshed 1 of 1" for a search resolving 16 titles.
  for (const id of wanted) interestedIds.delete(id);
  writeDiskCache(CACHE_KEY, { ratings: ratingsById, fetchedAt: lastRefreshAt });
  console.error(
    `IMDb dataset: refreshed ${found} of ${wanted.size} tracked title(s) from the official daily export` +
    (interestedIds.size ? `; ${interestedIds.size} more registered during the run, next refresh will cover them.` : ".")
  );
  return ratingsById;
}

// Fire-and-forget. Never awaited by a request: a search should not wait on an
// 8 MB download, and OMDb's rating is already there as the immediate answer.
// The authoritative figure lands on the next search.
function refreshInBackground() {
  const stale = Date.now() - lastRefreshAt > REFRESH_AFTER_MS;
  if (!stale && interestedIds.size === 0) return;
  if (refreshPromise) return;
  refreshPromise = refresh()
    .catch((err) => console.error("IMDb dataset refresh failed:", err.message))
    .finally(() => { refreshPromise = null; });
}

module.exports = { noteInterest, getRating, refreshInBackground, refresh };
