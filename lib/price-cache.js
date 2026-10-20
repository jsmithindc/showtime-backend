const { readCache, writeCache } = require("./disk-cache");

// Prices for one specific showing, shared across searches. Pricing is the slow
// part of a search -- a Regal cart, a Cinemark seat-map page, Cinema West's API,
// most of it through Camofox -- while discovery is already cached. So without
// this, repeating a search, or re-running it with a later end time, a wider
// radius or "show all", paid for every price again.
//
// Keyed by the chain's own showing id, which is unique per date, so a cached
// price can't leak onto a different showing. Only successes are stored: a
// failure may be a Cloudflare blip, and caching it would hide the real price
// for hours.
const PRICE_TTL_MS = 6 * 60 * 60 * 1000;

const isPriced = (v) => v != null && v.price != null;

async function readPrice(key) {
  const hit = await readCache(`price-${key}`, PRICE_TTL_MS).catch(() => null);
  return hit ? hit.value : null;
}

function writePrice(key, value) {
  writeCache(`price-${key}`, { value }, PRICE_TTL_MS);
}

// Wraps a single-showing pricing function. keyOf returns the showing's id from
// the call's arguments, or a falsy value to skip the cache for that call.
function cachePrices(chain, keyOf, fn, isGood = isPriced, ttlMs = PRICE_TTL_MS) {
  return async function cachedPricing(...args) {
    const id = keyOf(...args);
    if (!id) return fn(...args);
    const key = `price-${chain}-${id}`;
    const hit = await readCache(key, ttlMs).catch(() => null);
    if (hit) return hit.value;
    const value = await fn(...args);
    if (isGood(value)) writeCache(key, { value }, ttlMs);
    return value;
  };
}

// Same, for a showtime LISTING fetched through Camofox (Cinemark's page, Cinema
// West's API). Shorter-lived than prices, since a schedule can gain or lose a
// showing during the day; only a non-empty list is kept, because an empty one is
// as likely to be a challenge page as a quiet theater.
const LISTING_TTL_MS = 60 * 60 * 1000;
function cacheListing(name, keyOf, fn) {
  return cachePrices(name, keyOf, fn, (v) => Array.isArray(v) && v.length > 0, LISTING_TTL_MS);
}

module.exports = { cachePrices, cacheListing, readPrice, writePrice, PRICE_TTL_MS };
