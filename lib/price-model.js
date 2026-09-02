const { readCache, writeCache } = require("./disk-cache");

// Fallback ticket-price estimates, learned from prices this app has actually
// pulled.
//
// WHY: pricing fails for real reasons that have nothing to do with the showing
// -- a proxy times out, a chain's booking API returns HTML, a cart step gets
// challenged. The showtime is real and the theater does have a price; we just
// could not read it this time. Landmark has produced 6 real showings and 0
// prices in every recent log. An unpriced row sorts below every priced one and
// tells the user nothing about whether it is worth considering.
//
// WHAT THIS IS NOT: a substitute for a real price. Estimates are kept in a
// SEPARATE field (`estimatedPrice`), never written into `price`, and are never
// eligible for the "Cheapest" badge. A number here means "similar showings at
// this theater have cost about this", not "this ticket costs this".
//
// ACCURACY CAVEAT: this averages whatever each adapter calls `price`. Adapters
// are not perfectly consistent about base-vs-total or which ticket type is
// cheapest, so a bucket mixing two chains' conventions would be misleading --
// which is why chain is the first key component and estimates never cross it.

// Buckets are recorded at several granularities at once, so a lookup is a
// straight most-specific-first walk rather than a query.
const LEVELS = [
  { id: "theater+format+time+day", parts: (k) => [k.chain, k.theater, k.format, k.part, k.day] },
  { id: "theater+format+time",     parts: (k) => [k.chain, k.theater, k.format, k.part] },
  { id: "theater+format",          parts: (k) => [k.chain, k.theater, k.format] },
  { id: "theater+time",            parts: (k) => [k.chain, k.theater, "*", k.part] },
  { id: "theater",                 parts: (k) => [k.chain, k.theater] },
  { id: "chain+format+time",       parts: (k) => [k.chain, "*", k.format, k.part] },
  { id: "chain+format",            parts: (k) => [k.chain, "*", k.format] },
  { id: "chain",                   parts: (k) => [k.chain] },
];

// Two observations before a bucket is usable. One is a data point, not a
// pattern -- and a single odd ticket type (a $5 kids' show) would otherwise
// become the estimate for everything at that theater.
const MIN_OBSERVATIONS = 2;
// Ticket prices drift. An observation older than this stops counting.
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const CACHE_KEY = "price-model";
const FLUSH_DEBOUNCE_MS = 20_000;

const stats = new Map();  // bucketKey -> { n, sum, min, max, at }
let loaded = false;
let loadPromise = null;
let dirty = false;
let flushTimer = null;

function normText(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 48);
}

// Matinee pricing is real and roughly tracks these boundaries across chains.
// Kept coarse on purpose: finer buckets would be more accurate per-bucket but
// would almost never reach MIN_OBSERVATIONS.
function dayPart(startTimeRaw) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(startTimeRaw || ""));
  if (!m) return "unknown";
  const hour = Number(m[1]);
  if (hour < 12) return "early";
  if (hour < 17) return "matinee";
  return "evening";
}

// Discount Tuesday is a real, widespread thing and worth its own bucket;
// weekends price differently from the rest of the week.
function dayType(dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ""))) return "unknown";
  const [y, m, d] = dateISO.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0 Sun .. 6 Sat
  if (dow === 0 || dow === 6) return "weekend";
  if (dow === 2) return "tue";
  return "weekday";
}

function keyParts({ chain, theaterName, format, startTimeRaw, dateISO }) {
  return {
    chain: normText(chain) || "other",
    theater: normText(theaterName),
    format: normText(format) || "standard",
    part: dayPart(startTimeRaw),
    day: dayType(dateISO),
  };
}

async function load() {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const saved = await readCache(CACHE_KEY, MAX_AGE_MS);
      if (saved && saved.buckets) {
        const cutoff = Date.now() - MAX_AGE_MS;
        let kept = 0;
        for (const [k, v] of Object.entries(saved.buckets)) {
          if (!v || typeof v.n !== "number" || v.at < cutoff) continue;
          stats.set(k, v);
          kept++;
        }
        if (kept > 0) console.error(`Price model: loaded ${kept} bucket(s) of learned pricing.`);
      }
    } catch {
      // best-effort -- an empty model just means no estimates yet
    } finally {
      loaded = true;
      loadPromise = null;
    }
  })();
  return loadPromise;
}

function scheduleFlush() {
  if (flushTimer || !dirty) return;
  // Debounced: a search records dozens of observations, and each one would
  // otherwise be its own write.
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    writeCache(CACHE_KEY, { buckets: Object.fromEntries(stats), savedAt: Date.now() }, MAX_AGE_MS);
  }, FLUSH_DEBOUNCE_MS);
  if (flushTimer.unref) flushTimer.unref(); // never hold the process open
}

/**
 * Record one REAL observed price. Estimates must never be fed back in.
 */
function record({ chain, theaterName, format, startTimeRaw, dateISO, price }) {
  if (!loaded) return;                       // nothing to merge into yet
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return;
  if (price > 200) return;                   // guard against a parse error becoming "truth"
  const k = keyParts({ chain, theaterName, format, startTimeRaw, dateISO });
  if (!k.theater) return;
  const now = Date.now();
  for (const level of LEVELS) {
    const bucketKey = level.parts(k).join("|");
    const cur = stats.get(bucketKey);
    if (cur) {
      cur.n += 1; cur.sum += price; cur.at = now;
      if (price < cur.min) cur.min = price;
      if (price > cur.max) cur.max = price;
    } else {
      stats.set(bucketKey, { n: 1, sum: price, min: price, max: price, at: now });
    }
  }
  dirty = true;
  scheduleFlush();
}

/**
 * Best available estimate, or null. Walks most-specific to least, returning
 * the first bucket with enough observations, and says which level answered so
 * the caller can tell the user how good it is.
 */
function estimate({ chain, theaterName, format, startTimeRaw, dateISO }) {
  if (!loaded || stats.size === 0) return null;
  const k = keyParts({ chain, theaterName, format, startTimeRaw, dateISO });
  if (!k.theater) return null;
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const level of LEVELS) {
    const bucket = stats.get(level.parts(k).join("|"));
    if (!bucket || bucket.n < MIN_OBSERVATIONS || bucket.at < cutoff) continue;
    return {
      price: Math.round((bucket.sum / bucket.n) * 100) / 100,
      low: bucket.min,
      high: bucket.max,
      basis: level.id,
      observations: bucket.n,
    };
  }
  return null;
}

function summary() {
  return { loaded, buckets: stats.size };
}

module.exports = { load, record, estimate, summary, dayPart, dayType, MIN_OBSERVATIONS };
