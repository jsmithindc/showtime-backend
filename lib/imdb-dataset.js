const fetch = require("node-fetch");
const zlib = require("zlib");
const readline = require("readline");
const fs = require("fs");
const os = require("os");
const path = require("path");
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

// Local copy of the gzip, valid for a short window. Bounded by the same daily
// cadence as the data itself, so a stale copy is never more than minutes old
// relative to the refresh interval that already governs this file.
const DATASET_FILE_TTL_MS = 30 * 60 * 1000;
const datasetFile = path.join(os.tmpdir(), "imdb-title-ratings.tsv.gz");

async function openDatasetStream() {
  try {
    const stat = fs.statSync(datasetFile);
    if (Date.now() - stat.mtimeMs < DATASET_FILE_TTL_MS && stat.size > 1024) {
      return fs.createReadStream(datasetFile);
    }
  } catch { /* not cached yet */ }

  const res = await fetch(DATASET_URL);
  if (!res.ok) throw new Error(`IMDb dataset request failed: ${res.status} ${res.statusText}`);

  // Write to a temp name and rename, so a run interrupted mid-download can't
  // leave a truncated file that later reads would treat as valid.
  const tmp = `${datasetFile}.${process.pid}.part`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.body.pipe(out);
    res.body.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
  });
  fs.renameSync(tmp, datasetFile);
  return fs.createReadStream(datasetFile);
}

// Streams the gzip straight through a line reader. The file is never held in
// memory or written to disk whole -- rows are matched against the wanted set as
// they go past, so peak memory is a few KB regardless of file size.
async function refresh() {
  const map = load();
  const wanted = new Set([...Object.keys(map), ...interestedIds]);
  if (wanted.size === 0) return map;   // nothing to look up yet

  // The gzip is cached on disk for a short window and re-read locally rather
  // than re-downloaded. A big search's titles arrive over a long spread, so
  // several rounds are legitimately needed -- a live Denver window search
  // needed eight -- but they were eight full 8 MB downloads of a file that
  // changes once a day. Re-scanning the local copy costs no bandwidth.
  const input = await openDatasetStream();

  const rl = readline.createInterface({
    input: input.pipe(zlib.createGunzip()),
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

// One refresh at a time, and at most two passes per caller.
//
// The first attempt at batching cleared its debounce timer BEFORE awaiting the
// download, so every caller arriving during that ~0.6s window saw no timer
// pending and scheduled its own run. A search's titles trickle in over several
// seconds -- throttled behind pricing and RT lookups -- so that produced
// FIFTEEN full 8 MB downloads for a single search.
//
// refresh() snapshots the wanted set when it starts, so a caller registering
// mid-run isn't covered by it. Hence two passes: join whatever is already
// running, and if the ID still isn't there, take part in the next run, which is
// guaranteed to include it. Bounds a search to two downloads rather than one
// per title -- and to zero once the day's titles are cached.
const REFRESH_DEBOUNCE_MS = 300;
let currentRun = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runRefreshOnce() {
  if (currentRun) return currentRun;
  currentRun = (async () => {
    // Brief pause so siblings arriving together land in the same run.
    await sleep(REFRESH_DEBOUNCE_MS);
    try {
      await refresh();
    } catch (err) {
      console.error("IMDb dataset refresh failed:", err.message);
    }
  })().finally(() => { currentRun = null; });
  return currentRun;
}

// Resolve a rating, fetching the dataset first if this ID isn't tracked yet.
//
// Originally fire-and-forget, on the assumption that a search must never wait
// on an 8 MB download. Measured, that was wrong: a full read for modern IDs
// (late in the sorted file, so the early exit barely helps) takes 0.6s at 14 MB
// heap. Waiting once beats showing a knowingly-stale number and telling someone
// to search again.
//
// Bounded: if downloads stall, the timeout wins and the caller falls back to
// OMDb's figure rather than the search hanging.
async function ensureRating(tconst, timeoutMs = 8000) {
  if (!tconst) return null;
  let value = getRating(tconst);
  if (value != null) return value;

  noteInterest(tconst);
  const startedAt = Date.now();

  for (let pass = 0; pass < 2; pass++) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await Promise.race([runRefreshOnce(), sleep(remaining)]);
    value = getRating(tconst);
    if (value != null) return value;
  }
  return null;
}

// Still used for the daily staleness refresh, where nobody is waiting.
function refreshInBackground() {
  const stale = Date.now() - lastRefreshAt > REFRESH_AFTER_MS;
  if (!stale && interestedIds.size === 0) return;
  if (refreshPromise) return;
  refreshPromise = refresh()
    .catch((err) => console.error("IMDb dataset refresh failed:", err.message))
    .finally(() => { refreshPromise = null; });
}

module.exports = { noteInterest, getRating, ensureRating, refreshInBackground, refresh };
