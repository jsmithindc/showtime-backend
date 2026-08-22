const express = require("express");
const pLimit = require("p-limit");
const { findNearbyTheaters } = require("./lib/theaters-overpass");
const { estimatedMinutesAway, minutesToMeters } = require("./lib/distance");
const { getPricedShowtimes, getTheaterSchedule } = require("./lib/priceAdapters/serpapi");
const { resolveCanonicalLocation } = require("./lib/serpapi-location");
const { getPricedShowtimes: getRegalPricedShowtimes, getShowtimesForTheater: getRegalShowtimesForTheater } = require("./lib/priceAdapters/regal-scrapedo");
const REGAL_CINEMA_MAP = require("./lib/regal-cinema-map");
// Some map entries are objects { code, lat, lng } instead of plain strings,
// used when the theater's OSM coordinates are known to be wrong. These two
// helpers normalize access so the rest of the code doesn't have to care.
function regalCodeFor(entry) { return entry == null ? null : (typeof entry === "string" ? entry : entry.code); }
function regalCoordsFor(entry) { return (entry != null && typeof entry === "object" && entry.lat != null) ? { lat: entry.lat, lng: entry.lng } : null; }
function regalDisplayNameFor(entry) { return (entry != null && typeof entry === "object") ? entry.displayName || null : null; }
// Display name overrides for theaters whose OSM name doesn't match the
// chain's official branding. Keyed by normalized OSM name.
const THEATER_DISPLAY_NAMES = {
  "AMC 16 Galleria at Tyler": "AMC Tyler Galleria 16",
  "New Vision Theatres Tilghman Square 8": "AMC Tilghman Square 8",
};
const EXCLUDED_THEATERS = require("./lib/excluded-theaters");
const { getPricedShowtimes: getAmcPricedShowtimes } = require("./lib/priceAdapters/amc-official");
const { getAmcTheatersByState, findClosestAmcTheater } = require("./lib/amc-theaters-by-state");
const {
  getShowtimesForMovie: getCinemarkShowtimesForMovie,
  getTicketPricing: getCinemarkTicketPricing,
} = require("./lib/priceAdapters/cinemark-official");
const CINEMARK_THEATER_MAP = require("./lib/cinemark-theater-map");
const CINEMARK_MOVIE_MAP = require("./lib/cinemark-movie-map");
const CINEMAWEST_THEATER_MAP = require("./lib/cinemawest-theater-map");
const { getShowtimesForSite: getCinemaWestShowtimes, getTicketPricing: getCinemaWestTicketPricing, getFreshTokenCached: getCinemaWestFreshToken } = require("./lib/priceAdapters/cinemawest-official");
const { getHarkinsTheaters } = require("./lib/harkins-theaters");
const { getShowtimesForMovie: getHarkinsShowtimesForMovie, getTicketPricing: getHarkinsTicketPricing, getRuntimeForMovie: getHarkinsRuntimeForMovie } = require("./lib/priceAdapters/harkins-official");
const REGENCY_THEATER_MAP = require("./lib/regency-theater-map");
const { getShowtimesForLocation: getRegencyShowtimesForLocation, getTicketPricing: getRegencyTicketPricing, getFilmIdMap: getRegencyFilmIdMap } = require("./lib/priceAdapters/regency-official");
const { matchesMovie } = require("./lib/priceAdapters/serpapi");
const CINEMARK_THEATER_SLUGS = require("./lib/cinemark-theater-slugs");
const { getRuntimeForMovieAtTheater, getCinemarkMovieIdForTitle } = require("./lib/cinemark-runtime-scraper");
const { geocodeForward } = require("./lib/geocode");
const { getRuntimeMinutes } = require("./lib/movie-runtime");
const { configuredProviders } = require("./lib/proxyProviders");

const { getStingerInfo, getInTheatersList } = require("./lib/mediaStinger");

const app = express();

// Render (and most hosting platforms) sit behind a reverse proxy --
// without this, req.ip returns the PROXY's address for every request,
// not the real visitor's. That would make the rate limiter below
// treat every visitor as the same single "IP", so 20 real searches
// from ANYONE would exhaust the shared count and lock out the whole
// app for the rest of the day. Only matters once actually deployed
// behind a real reverse proxy; harmless locally.
app.set("trust proxy", true);

// Simple shared-password gate -- only active when APP_PASSWORD is set in
// start.sh. Deliberately opt-in: running locally at localhost:3000 with
// no password set works exactly as before, no login prompt. Only matters
// once this gets exposed beyond your own machine (e.g. via a Cloudflare
// Tunnel) to share with friends -- without this, anyone who found the
// URL could run searches against your SerpApi/Scrape.do quota.
//
// Plain HTTP Basic Auth rather than a real login page/session system --
// every browser has a native prompt for it built in, so there's nothing
// for friends to install or figure out, and it's genuinely sufficient
// for "keep randoms out," not meant to be bank-grade security.
const APP_PASSWORD = process.env.APP_PASSWORD;
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const authHeader = req.headers.authorization || "";
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const [, providedPassword] = decoded.split(":"); // username is ignored, only password checked
      if (providedPassword === APP_PASSWORD) {
        return next();
      }
    }
    res.set("WWW-Authenticate", 'Basic realm="Showtime Finder"');
    res.status(401).send("Authentication required.");
  });
  console.error("APP_PASSWORD is set -- this instance requires a password to access.");
} else {
  console.error("APP_PASSWORD is not set -- running with no login gate (fine for localhost-only use).");
}

// Alternative/complementary protection to the password gate: a per-IP
// daily cap on the actual credit-costing endpoints (search, movies,
// window-search, search-regal -- the ones that call SerpApi, AMC,
// Cinemark, Harkins, Regency, or any Regal proxy provider). Rather than
// blocking access entirely like the password does, this lets anyone in
// but bounds how much any single visitor -- stranger or not -- can
// actually cost. Meant to replace the password for "friction-free for
// me, capped risk if the URL ever leaks" rather than as a second lock
// on top of it, though both work fine together.
//
// In-memory, resets on every restart/redeploy -- same tradeoff as this
// app's other in-memory caches (SerpApi schedule cache, MediaStinger's
// in-theaters cache). Not a real concern given how infrequently this
// app actually redeploys.
const SEARCH_RATE_LIMIT_PER_DAY = Number(process.env.SEARCH_RATE_LIMIT_PER_DAY) || 20;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const searchCountsByIp = new Map();

function searchRateLimiter(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const existing = searchCountsByIp.get(ip);

  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    searchCountsByIp.set(ip, { count: 1, windowStart: now });
    return next();
  }

  if (existing.count >= SEARCH_RATE_LIMIT_PER_DAY) {
    const resetInMinutes = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - existing.windowStart)) / 60000);
    console.error(`Rate limit hit for ${ip} -- ${existing.count} searches in the last 24h, resets in ~${resetInMinutes} min.`);
    return res.status(429).json({
      error: `You've hit the daily search limit (${SEARCH_RATE_LIMIT_PER_DAY}/day). Try again in about ${resetInMinutes} minutes.`,
    });
  }

  existing.count += 1;
  next();
}

app.use(express.static("public"));

// SerpApi's showtimes results don't reliably include runtime, so this is
// a fixed assumption rather than per-movie data. Update it per movie, or
// wire in a free runtime lookup (e.g. OMDb's free tier) if you want this
// to stop being a manual step.
const RUNTIME_MIN = 128;
// Was a single fixed number (20, then briefly 30 after one real
// observation at AMC Norwalk 20). Changed to a range instead of another
// single guess -- trailer time genuinely varies by theater and we don't
// have enough real observations yet to know a universal number with any
// confidence. 20-30 minutes covers what's been seen/assumed so far.
// Per-theater real observations (see lib/theater-trailer-times.js)
// override this range with an actual known value once we have one.
const TRAILER_BUFFER_MIN_LOW = 20;
const TRAILER_BUFFER_MIN_HIGH = 30;
const THEATER_TRAILER_TIMES = require("./lib/theater-trailer-times");

// Returns { low, high } minutes for a given theater -- a real known
// value (low === high) if we have an observation for this specific
// theater, otherwise the general uncertainty range.
function getTrailerBufferRange(theaterName) {
  const known = THEATER_TRAILER_TIMES[theaterName];
  if (known != null) return { low: known, high: known };
  return { low: TRAILER_BUFFER_MIN_LOW, high: TRAILER_BUFFER_MIN_HIGH };
}

// Cap concurrent SerpApi calls -- matters most on the free tier, which
// also caps hourly throughput, not just the monthly total.
const priceLimit = pLimit(3);

function toMinutesSinceMidnight(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function parseGoogleTime(str) {
  const trimmed = str.trim();

  // 12-hour format with am/pm, e.g. "11:20am", "2:50 pm" -- the usual shape.
  let match = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(trimmed);
  if (match) {
    let [, h, m, ampm] = match;
    h = Number(h);
    m = Number(m);
    if (ampm.toLowerCase() === "pm" && h !== 12) h += 12;
    if (ampm.toLowerCase() === "am" && h === 12) h = 0;
    return h * 60 + m;
  }

  // 24-hour format with no am/pm suffix, e.g. "11:35", "22:00" -- confirmed
  // real: SerpApi returns times this way for at least some theaters
  // (Century DOCO and XD, in a real live response) instead of the usual
  // 12-hour "11:20am" shape. The original version of this function only
  // handled the am/pm form, silently returning null for every 24-hour
  // entry -- which meant that theater's showings vanished from results
  // entirely (dropped before the deadline filter even ran), not because
  // they failed the deadline, but because they were never parsed at all.
  match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (match) {
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return h * 60 + m;
    }
  }

  return null;
}

// Regal's GetTicketsForSession endpoint (what we currently call) only
// returns the base ticket price -- the "booking fee" is a genuinely
// separate, order-level field in Vista's API (confirmed via real Vista
// Connect docs: {"orderTotalValueInCents": 1875, "bookingFeeTotalValueInCents": 375, ...}),
// only populated once a ticket is actually added to a cart, which our
// adapter doesn't currently do (that would cost an extra Scrape.do call
// per showing). Rather than pay for that, this estimates the fee from
// real observed data instead: $2.00 for Standard/3D, $2.50 for other
// premium formats (IMAX, ScreenX, RPX, 4DX, etc.) -- confirmed directly
// against Regal's real checkout for a real showing by the user.
function estimateRegalFee(format) {
  const f = (format || "").toLowerCase().trim();
  if (f === "standard" || f === "3d") return 2.0;
  return 2.5;
}

// Harkins charges a real per-ticket service fee that its own pricing API
// genuinely does not expose -- CONFIRMED, not merely unread: a full real
// GetTicketTypes response was checked end-to-end (every ticket type, all
// top-level fields) and contains no fee field anywhere. So the only
// options are to add a cart step (an extra paid call per showing) or to
// estimate from real observed checkout values, exactly as we already do
// for Regal.
//
// THE RULE, confirmed by the user against Harkins' real checkout: the
// $2.49 fee applies specifically to CINÉXL screenings. Standard Digital
// AND 3D are both $2.09. Note this is NOT the same shape as Regal's fee
// schedule even though the two look similar -- Regal splits on
// standard-vs-premium generally, whereas Harkins' premium fee is tied
// to the large-format screen itself, which is why 3D stays at the base
// rate here. Do not "simplify" these two functions into one.
//
// The $2.09 figure independently corroborates the one fully confirmed
// RequestOrderTotals capture noted in lib/priceAdapters/harkins-official
// .js ($15.50 base + $2.09 fee), so the base rate is solid from two
// directions.
const HARKINS_FEE_REGULAR = 2.09;
const HARKINS_FEE_PREMIUM = 2.49;

// Formats confirmed to bill at the REGULAR rate. Everything else falls
// through to premium -- see the reasoning on the default below.
const HARKINS_REGULAR_FORMATS = new Set(["digital", "3d"]);

// Formats we already expect to be premium. This set is NOT used to
// decide the fee (the default handles that) -- it exists purely so we
// can tell "premium format we know about" apart from "format we've
// never seen before" and log only the latter.
//
// Harkins has consolidated its premium branding: the old "Cine Capri"
// name has been retired in favor of CINÉXL across their premium
// auditoriums, but "Cine 1" / "Cine 1 XL" still appears at some
// locations, and Harkins' own premium-experiences page lists IMAX
// alongside CINEXL -- so CINÉXL is not necessarily the only premium
// format string their API can return.
const HARKINS_KNOWN_PREMIUM_FORMATS = new Set(["cinexl", "imax", "cine1", "cine1xl"]);

// Harkins writes this format with an accent and inconsistent spacing
// ("CINÉXL", "CINÉ XL", "CineXL" have all been seen in their own
// marketing), so compare on a stripped-down form rather than trying to
// match the literal string. NFD + combining-mark removal turns É into
// E; dropping every non-alphanumeric collapses the spacing variants.
function normalizeHarkinsFormat(format) {
  return (format || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const warnedUnknownHarkinsFormats = new Set();

function estimateHarkinsFee(format) {
  const f = normalizeHarkinsFormat(format);
  if (HARKINS_REGULAR_FORMATS.has(f)) return HARKINS_FEE_REGULAR;

  // Deliberate choice of default for anything unrecognized: PREMIUM,
  // not regular. Guessing low understates the total and makes Harkins
  // look cheaper than it is, which actively corrupts the cross-chain
  // comparison this whole app exists to do -- the one failure mode
  // genuinely worth avoiding. Guessing high costs at most $0.40 of
  // accuracy on a showing nobody has verified yet. Logged once per
  // distinct format so a new format string surfaces as something to go
  // confirm at checkout rather than sitting silently wrong.
  if (!HARKINS_KNOWN_PREMIUM_FORMATS.has(f) && !warnedUnknownHarkinsFormats.has(f)) {
    warnedUnknownHarkinsFormats.add(f);
    console.error(
      `Harkins: unrecognized format ${JSON.stringify(format)} -- defaulting to the premium ` +
      `$${HARKINS_FEE_PREMIUM.toFixed(2)} fee. Verify at real checkout and add it to ` +
      `HARKINS_REGULAR_FORMATS or HARKINS_KNOWN_PREMIUM_FORMATS in server.js.`
    );
  }
  return HARKINS_FEE_PREMIUM;
}

// Rough California bounding box -- deliberately generous (includes a
// bit of neighboring states/ocean) since it's only used to decide
// whether it's worth attempting the AMC-by-state auto-lookup at all,
// not for anything that needs to be precise.
// CONFIRMED REAL BUG, found via direct debug logging after weeks of the
// code checking out perfectly under static review: REGENCY_THEATER_MAP
// ["CGV Buena Park"] (a literal string) returned a real entry, but the
// SAME-LOOKING t.name from Overpass's own data returned undefined for
// the exact same lookup. Two strings that display identically but
// aren't ===-equal is the classic signature of a hidden Unicode
// character (a non-breaking space instead of a regular space is the
// most common real-world cause) -- something no amount of reading the
// source code could ever catch, since the bug was in the DATA, not the
// logic. Normalizing every theater name once, right where it's built
// from raw Overpass data, fixes this for every chain's lookup at once
// rather than needing to patch each chain's map lookup individually.
function normalizeTheaterName(name) {
  return name
    .normalize("NFKC") // collapses many visually-identical-but-different-codepoint variants
    .replace(/[\s\u00A0\u2000-\u200B\u202F\u2060\uFEFF]+/g, " ") // any Unicode whitespace variant, not just ASCII space
    .trim();
}

function isRoughlyInCalifornia(lat, lng) {
  return lat >= 32.4 && lat <= 42.1 && lng >= -124.6 && lng <= -114.0;
}

// Rough bounding-box US state lookup -- good enough for choosing which
// state's AMC theater list to fetch. Boxes overlap at borders; first
// match wins, which is fine since AMC's API deduplicates by ID anyway.
const US_STATE_BOXES = [
  ["AK", 51.2, 71.5, -180, -130], ["AL", 30.1, 35.0, -88.5, -84.9],
  ["AR", 33.0, 36.5, -94.6, -89.6], ["AZ", 31.3, 37.0, -114.8, -109.0],
  ["CA", 32.4, 42.1, -124.6, -114.0], ["CO", 36.9, 41.1, -109.1, -102.0],
  ["CT", 40.9, 42.1, -73.7, -71.8], ["DC", 38.8, 39.0, -77.1, -76.9],
  ["DE", 38.4, 39.8, -75.8, -75.0], ["FL", 24.4, 31.1, -87.6, -79.9],
  ["GA", 30.4, 35.0, -85.6, -80.8], ["HI", 18.9, 22.2, -160.3, -154.8],
  ["IA", 40.4, 43.5, -96.6, -90.1], ["ID", 41.9, 49.0, -117.2, -111.0],
  ["IL", 36.9, 42.5, -91.5, -87.0], ["IN", 37.8, 41.8, -88.1, -84.8],
  ["KS", 36.9, 40.0, -102.1, -94.6], ["KY", 36.5, 39.1, -89.6, -81.9],
  ["LA", 28.9, 33.0, -94.1, -88.8], ["MA", 41.2, 42.9, -73.5, -69.9],
  ["MD", 37.9, 39.7, -79.5, -75.0], ["ME", 43.1, 47.5, -71.1, -66.9],
  ["MI", 41.7, 48.3, -90.4, -82.4], ["MN", 43.5, 49.4, -97.2, -89.5],
  ["MO", 35.9, 40.6, -95.8, -89.1], ["MS", 30.2, 35.0, -91.7, -88.1],
  ["MT", 44.4, 49.0, -116.1, -104.0], ["NC", 33.8, 36.6, -84.3, -75.5],
  ["ND", 45.9, 49.0, -104.1, -96.6], ["NE", 40.0, 43.0, -104.1, -95.3],
  ["NH", 42.7, 45.3, -72.6, -70.6], ["NJ", 38.9, 41.4, -75.6, -73.9],
  ["NM", 31.3, 37.0, -109.1, -103.0], ["NV", 35.0, 42.0, -120.0, -114.0],
  ["NY", 40.5, 45.0, -79.8, -71.9], ["OH", 38.4, 42.3, -84.8, -80.5],
  ["OK", 33.6, 37.0, -103.0, -94.4], ["OR", 41.9, 46.3, -124.6, -116.5],
  ["PA", 39.7, 42.3, -80.5, -74.7], ["RI", 41.1, 42.0, -71.9, -71.1],
  ["SC", 32.0, 35.2, -83.4, -78.5], ["SD", 42.5, 45.9, -104.1, -96.4],
  ["TN", 34.9, 36.7, -90.3, -81.6], ["TX", 25.8, 36.5, -106.6, -93.5],
  ["UT", 37.0, 42.0, -114.1, -109.0], ["VA", 36.5, 39.5, -83.7, -75.2],
  ["VT", 42.7, 45.0, -73.4, -71.5], ["WA", 45.5, 49.0, -124.8, -116.9],
  ["WI", 42.5, 47.1, -92.9, -86.2], ["WV", 37.2, 40.6, -82.6, -77.7],
  ["WY", 41.0, 45.0, -111.1, -104.1],
];
function latLngToUsState(lat, lng) {
  for (const [state, latMin, latMax, lngMin, lngMax] of US_STATE_BOXES) {
    if (lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax) return state;
  }
  return null;
}

// CONFIRMED REAL BUG, found from a live report: two real IMAX showings
// (AMC Orange 30, AMC Norwalk 20) never appeared in results despite
// being genuinely bookable. Root cause confirmed directly from an
// earlier real AMC checkout screenshot: AMC's own format label is
// "IMAX at AMC", not just "IMAX" -- the format chip's value ("imax")
// was being checked with an EXACT match against wantedFormats, which
// "imax at amc" can never equal. Fixed with substring matching in both
// directions instead (does the wanted format appear anywhere in the
// real format string, or vice versa) -- the same general pattern
// matchesMovie() already uses elsewhere in this file for exactly this
// kind of "one is a longer/differently-worded version of the other"
// problem. This also protects against the same class of issue for any
// other chain's own compound format labels, not just AMC's.
// CONFIRMED REAL BUG: Harkins' own format label for standard/base
// screenings is "Digital", not "Standard" -- confirmed real from live
// search results ("Real times seen: 12:05 (Digital), ..."). Since
// neither word is a substring of the other, every single Harkins
// showing with this format was being silently excluded by the format
// filter (the "standard" chip is always active by default), then
// mislabeled by this project's own diagnostic logging as "outside your
// search window" -- a real math check confirmed at least 2 of 5 real
// Harkins showings should have fit the actual deadline, but the
// diagnostic counter couldn't distinguish a format-filter rejection
// from a genuine deadline rejection, since buildResultIfWithinWindow
// returns null the same way for both. Same underlying issue as the
// earlier "IMAX at AMC" bug -- different chains using different words
// for the same concept, and exact-substring matching can't bridge them
// on its own.
const FORMAT_SYNONYMS = {
  digital: "standard",
};

function matchesWantedFormat(realFormat, wantedFormats) {
  if (!wantedFormats) return true; // no filter active, everything matches
  const real = (realFormat || "").toLowerCase();
  const realOrSynonym = FORMAT_SYNONYMS[real] || real;
  return wantedFormats.some((wf) => real.includes(wf) || wf.includes(real) || realOrSynonym === wf);
}

// Harkins' real format label for standard screenings is "Digital" (see
// the long note above matchesWantedFormat -- that mismatch used to
// silently drop every standard Harkins showing from results before the
// synonym fix). Filtering treats them as equivalent now, but the
// DISPLAY still showed the raw label, so "Digital" appeared as its own
// separate filter chip right next to "Standard" -- confusing, since
// every other chain's base screening shows as "Standard" and these are
// the same thing to a person choosing a showing. This only relabels
// what's shown/grouped in the UI; estimateHarkinsFee() and any other
// logic keyed on the exact raw label still reads perf.format directly,
// not this display value, so fee estimation is unaffected.
function harkinsDisplayFormat(rawFormat) {
  return (rawFormat || "").toLowerCase() === "digital" ? "Standard" : rawFormat;
}

// Same clutter, same fix, different chain: Cinemark's own raw format
// strings pass straight through unmodified elsewhere in this file --
// CONFIRMED real examples from Cinemark's own showtimes response:
// "Standard Format" for a plain screening, "XD Luxury Lounger RealD 3D"
// for a premium combo (see the long comment in cinemark-official.js).
// "Standard Format" was showing up as its OWN separate post-search
// filter chip instead of merging into the shared "Standard" chip every
// other chain uses -- two near-identical chips ("Standard" and
// "Standard Format") cluttering the same row. Also strips the filler
// word "Format" from premium strings for the same reason it's dropped
// from the plain case: it never adds real information ("XD Luxury
// Lounger RealD 3D Format" wouldn't read any more clearly than "XD
// Luxury Lounger RealD 3D"). Cinemark's own pricing logic reads
// perf.format directly elsewhere, not this display value, so nothing
// downstream of display is affected.
function cinemarkDisplayFormat(rawFormat) {
  const trimmed = (rawFormat || "").trim();
  if (trimmed.toLowerCase() === "standard format") return "Standard";
  const withoutFormat = trimmed.replace(/\s*\bformat\b\s*/i, " ").trim() || trimmed;
  // CONFIRMED REAL from a live report: Cinemark's own raw data returns
  // inconsistent capitalization for the same feature across different
  // theaters/records -- "D-BOX" from one, "D-Box" from another -- which
  // produced two separate, near-identical chips ("Standard Luxury
  // Lounger D-BOX" and "Standard Luxury Lounger D-Box") instead of one.
  // Normalized to a single canonical casing here, at the source, so
  // both the DISPLAY and the filter-matching (which compares this same
  // string) treat every casing variant as the same value -- fixing it
  // only in the chip-generation logic on the frontend wouldn't have
  // been enough, since individual result cards still need to match
  // whichever chip is active regardless of which casing that specific
  // theater happened to return.
  return withoutFormat.replace(/d-?box/gi, "D-BOX");
}

// Module-level standalone copies of formatEndTime/formatEndTimeRange
// (the originals are local to the main /api/search handler) -- needed
// by /api/search-regal, which is self-contained rather than sharing
// code with the main handler.
function formatEndTimeStandalone(startTimeRaw, runtimeMinutes) {
  const startMin = parseGoogleTime(startTimeRaw);
  if (startMin === null) return null;
  const endMinOfDay = (startMin + runtimeMinutes) % (24 * 60);
  const crossesMidnight = startMin + runtimeMinutes >= 24 * 60;
  let h = Math.floor(endMinOfDay / 60);
  const m = endMinOfDay % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const timeStr = `${h}:${String(m).padStart(2, "0")} ${ampm}`;
  return crossesMidnight ? `${timeStr} (next day)` : timeStr;
}

function formatEndTimeRangeStandalone(startTimeRaw, baseMinutes, low, high) {
  const lowStr = formatEndTimeStandalone(startTimeRaw, baseMinutes + low);
  if (low === high) return lowStr;
  const highStr = formatEndTimeStandalone(startTimeRaw, baseMinutes + high);
  return lowStr === highStr ? lowStr : `${lowStr} - ${highStr}`;
}

// For chains without a confirmed real direct booking URL (AMC, Regal,
// Cinemark -- none of this project's real captures ever surfaced a
// stable, guessable customer-facing URL pattern for any of them, unlike
// Regency/Harkins/Cinema West). A Google search reliably surfaces real
// booking options without risking a broken/wrong link from a guessed
// URL structure.
function googleFallbackLink(theaterName, movieTitle) {
  return `https://www.google.com/search?q=${encodeURIComponent(`${theaterName} ${movieTitle} showtimes`)}`;
}

// For Regal's real confirmed booking URL pattern:
// regmovies.com/movies/{slug}-{movieId}?date={date}&site={theaterCode}&id={performanceId}
// Confirmed real from two live captured URLs, including a real bug
// caught while verifying: hyphens/colons/apostrophes are stripped
// entirely (not replaced with a separator), while spaces become
// hyphens -- e.g. "Spider-Man: Brand New Day" -> "spiderman-brand-new-day",
// not "spider-man-brand-new-day". A naive "replace all punctuation with
// hyphens" approach was tested and confirmed wrong before this fix.
function toUrlSlug(title) {
  return title
    .toLowerCase()
    .replace(/[-':]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Today's date in the server's LOCAL timezone, as YYYY-MM-DD.
//
// CRITICAL: do not use `new Date().toISOString().slice(0, 10)` for this
// -- toISOString() is always UTC, while the rest of this app's
// time-of-day math (now.getHours()/getMinutes(), used for the deadline
// comparison) is local. Confirmed as a real live bug: after ~5pm
// Pacific, UTC has already rolled to the next calendar day, so the old
// UTC-based "today" silently matched a user's "tomorrow" date pick,
// misclassifying a future-dated search as today's and running the
// current-time deadline filter against it -- which threw out every
// showing as "already started" on a search that hadn't even happened
// yet. This affects every evening search, in every US timezone, not
// just an edge case.
function todayISOLocal() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

app.get("/api/search", searchRateLimiter, async (req, res) => {
  const { movie, radiusMin, deadline, formats, chains, date, debug, debugSerpApi } = req.query;
  let { lat, lng, location, place } = req.query;

  if (!movie || !radiusMin || !deadline) {
    return res.status(400).json({
      error: "movie, radiusMin, and deadline are required",
    });
  }
  if ((!lat || !lng) && !place) {
    return res.status(400).json({
      error: "Provide either lat & lng, or a place (zip code or city name, e.g. '92835' or 'Fullerton, CA')",
    });
  }

  // New single-field path: geocode a zip code or city name into
  // coordinates AND a location label for SerpApi, both from one lookup --
  // the person never has to know or type coordinates. The explicit
  // lat/lng/location path (used by search.sh) still works unchanged.
  if ((!lat || !lng) && place) {
    try {
      const geo = await geocodeForward(place);
      lat = geo.lat;
      lng = geo.lng;
      location = location || geo.locationLabel;
    } catch (err) {
      return res.status(400).json({
        error: `Couldn't find a location for "${place}"`,
        detail: err.message,
      });
    }
  }

  if (!location) {
    return res.status(400).json({
      error: "location (city/region) is required when lat & lng are provided directly without a place",
    });
  }

  const now = new Date();
  const todayISO = todayISOLocal();
  const searchDateISO = date || todayISO;
  const isToday = searchDateISO === todayISO;

  const wantedFormats = formats ? formats.split(",").map((f) => f.toLowerCase()) : null;
  const wantedChains = chains ? chains.split(",").map((c) => c.toLowerCase()) : null;
  const deadlineMinutes = toMinutesSinceMidnight(deadline);
  // "Already started" and "deadline already passed" only mean anything
  // relative to the current clock when searching today. For a future
  // date, every time of day is still available -- there's no "already
  // started" to filter out, so treat the current-time floor as 0.
  const nowMinutes = isToday ? now.getHours() * 60 + now.getMinutes() : 0;
  const originLat = Number(lat);
  const originLng = Number(lng);

  const timeWindowWarning =
    isToday && deadlineMinutes <= nowMinutes
      ? `Heads up: your deadline (${deadline}) is not after the current time ` +
        `on this machine (${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}). ` +
        `Every showing will be filtered out as "already started" or "ends too late" ` +
        `-- that's very likely why matchingShowings is 0. Try a later deadline.`
      : null;

  try {
    // ---- Phase 1: broad, free theater discovery (OpenStreetMap) ----
    const radiusMeters = minutesToMeters(Number(radiusMin));
    const nearbyTheaters = await findNearbyTheaters({
      lat: originLat,
      lng: originLng,
      radiusMeters,
    });

    // Resolve once per search, not once per theater -- SerpApi rejects
    // location strings it doesn't recognize verbatim (see
    // lib/serpapi-location.js), so translate whatever the caller typed
    // into the exact canonical form before it's used in any theater call.
    let resolvedLocation = location;
    let locationResolutionError = null;
    try {
      resolvedLocation = await resolveCanonicalLocation(location);
    } catch (err) {
      locationResolutionError = err.message;
      console.error(`Location resolution failed for "${location}":`, err.message);
      // Fall through and try the raw string anyway -- worst case SerpApi
      // rejects it with the same clear error as before.
    }

    const theatersInRange = nearbyTheaters
      .map((t) => {
        const normalizedName = normalizeTheaterName(t.name);
        const regalEntry = REGAL_CINEMA_MAP[normalizedName];
        const coordOverride = regalCoordsFor(regalEntry);
        const tLat = coordOverride ? coordOverride.lat : t.lat;
        const tLng = coordOverride ? coordOverride.lng : t.lng;
        const displayName = regalDisplayNameFor(regalEntry) || THEATER_DISPLAY_NAMES[normalizedName] || undefined;
        return { ...t, name: normalizedName, lat: tLat, lng: tLng, ...(displayName ? { displayName } : {}), distanceMin: estimatedMinutesAway(originLat, originLng, tLat, tLng) };
      })
      .filter((t) => t.distanceMin <= Number(radiusMin))
      .filter((t) => !EXCLUDED_THEATERS.has(t.name));

    if (theatersInRange.length === 0) {
      return res.json({
        movie,
        theatersFound: nearbyTheaters.length,
        theatersInRange: 0,
        results: [],
        note: "No theaters found in OpenStreetMap within that radius -- either genuinely none nearby, or this area's OSM cinema data is sparse. Worth a sanity check against Google Maps.",
      });
    }

    // ---- Early chain resolution, BEFORE any SerpApi calls ----
    // Moved forward from what used to be Phases 3-6 (Regal/AMC/Cinemark/
    // Cinema West each independently recomputed this after already
    // spending a SerpApi call on every theater in range, including ones
    // we were about to throw away). Resolution only needs theatersInRange
    // (lat/lng + static maps + proximity auto-lookup) -- it has no
    // dependency on SerpApi data, so there's no reason it can't happen
    // first and filter theatersInRange BEFORE Phase 2 spends any quota.
    //
    // Deliberately NOT gated behind each chain's own pricing-disabled
    // flag -- a theater still counts as "ours" for filtering purposes
    // even while that chain's pricing is paused (e.g. Regal theaters
    // should still show up, just unpriced, while DISABLE_REGAL_PRICING
    // is true). Only the actual pricing calls later respect those flags.
    function wantChain(name) {
      return !wantedChains || wantedChains.includes(name);
    }

    const regalResolvedIds = {};
    if (wantChain("regal")) {
      for (const t of theatersInRange) {
        if (REGAL_CINEMA_MAP[t.name] != null) {
          regalResolvedIds[t.name] = regalCodeFor(REGAL_CINEMA_MAP[t.name]);
        }
      }
      const unmappedRegalInRange = theatersInRange.filter((t) => regalResolvedIds[t.name] == null);
      if (unmappedRegalInRange.some((t) => isRoughlyInCalifornia(t.lat, t.lng))) {
        try {
          const caRegalTheaters = require("./lib/regal-theaters-ca");
          for (const t of unmappedRegalInRange) {
            if (!isRoughlyInCalifornia(t.lat, t.lng)) continue;
            // Same real bug and same fix as the AMC block below this
            // one -- distance-only matching wrongly paired unrelated
            // theaters together. This block is actually MORE exposed to
            // it: a 2-mile radius ("city-level estimate", see the log
            // message) is a much wider net than AMC's 0.3mi, so a false
            // positive here is if anything more likely, not less.
            if (!/\bregal\b|\bedwards\b/i.test(t.name)) {
              console.error(
                `Regal auto-match skipped: OSM theater "${t.name}" doesn't mention Regal in its own name -- ` +
                `not attempting a distance-only match.`
              );
              continue;
            }
            const match = findClosestAmcTheater(t.lat, t.lng, caRegalTheaters, 2);
            if (match) {
              regalResolvedIds[t.name] = match.id;
              console.error(
                `Regal auto-match: OSM theater "${t.name}" -> Regal cinema #${match.id} ` +
                `("${match.name}"), ${match.matchedDistanceMiles.toFixed(3)} mi apart (city-level estimate)`
              );
            }
          }
        } catch (err) {
          console.error("Regal CA theater list unavailable (run scripts/build-regal-theater-map.js to generate it):", err.message);
        }
      }
    }

    // AMC direct discovery: fetch AMC's own theater list for the user's
    // state, then filter to theaters within the search radius. This
    // completely bypasses OSM/Geoapify for AMC -- we no longer try to
    // match OSM theater names to AMC IDs (unreliable: stale names,
    // wrong coordinates, rebrands). AMC's API is the authoritative
    // source for which AMC theaters exist and where they are.
    const amcDirectTheaters = [];
    if (wantChain("amc")) {
      const state = latLngToUsState(originLat, originLng);
      if (state) {
        try {
          const stateAmcTheaters = await getAmcTheatersByState(state);
          for (const t of stateAmcTheaters) {
            const dMin = estimatedMinutesAway(originLat, originLng, t.lat, t.lng);
            if (dMin <= Number(radiusMin)) {
              amcDirectTheaters.push({ ...t, distanceMin: dMin });
            }
          }
          console.error(
            `AMC direct: ${amcDirectTheaters.length} theaters in ${state} within ${radiusMin}min` +
            (amcDirectTheaters.length ? ": " + amcDirectTheaters.map((t) => t.name).join(", ") : "")
          );
        } catch (err) {
          console.error(`AMC direct: ${state} theater list fetch failed:`, err.message);
        }
      } else {
        console.error(`AMC direct: could not determine US state for (${originLat}, ${originLng})`);
      }
    }

    const cinemarkResolvedIds = {};
    if (wantChain("cinemark")) {
      for (const t of theatersInRange) {
        if (CINEMARK_THEATER_MAP[t.name] != null) {
          cinemarkResolvedIds[t.name] = CINEMARK_THEATER_MAP[t.name];
        }
      }
      const unmappedCinemarkInRange = theatersInRange.filter((t) => cinemarkResolvedIds[t.name] == null);
      if (unmappedCinemarkInRange.some((t) => isRoughlyInCalifornia(t.lat, t.lng))) {
        try {
          const caCinemarkTheaters = require("./lib/cinemark-theaters-ca");
          for (const t of unmappedCinemarkInRange) {
            if (!isRoughlyInCalifornia(t.lat, t.lng)) continue;
            // Same real bug and same fix as the AMC/Regal auto-match
            // blocks above -- distance-only matching risks silently
            // pairing an unrelated theater with the wrong chain.
            if (!/\bcinemark\b/i.test(t.name)) {
              console.error(
                `Cinemark auto-match skipped: OSM theater "${t.name}" doesn't mention Cinemark in its own name -- ` +
                `not attempting a distance-only match.`
              );
              continue;
            }
            const match = findClosestAmcTheater(t.lat, t.lng, caCinemarkTheaters);
            if (match) {
              cinemarkResolvedIds[t.name] = match.id;
              console.error(
                `Cinemark auto-match: OSM theater "${t.name}" -> Cinemark theatre #${match.id} ` +
                `("${match.name}"), ${match.matchedDistanceMiles.toFixed(3)} mi apart`
              );
            }
          }
        } catch (err) {
          console.error("Cinemark CA theater list unavailable (run scripts/build-cinemark-theater-map.js to generate it):", err.message);
        }
      }
    }

    const cinemaWestResolvedTheaters = {};
    if (wantChain("cinemawest")) {
      for (const t of theatersInRange) {
        if (CINEMAWEST_THEATER_MAP[t.name] != null) {
          cinemaWestResolvedTheaters[t.name] = CINEMAWEST_THEATER_MAP[t.name];
        }
      }
    }

    // Harkins direct discovery: same approach as AMC -- use Harkins'
    // own theater list (ticketingservice.harkins.com/api/Theatre/GetTheatres)
    // rather than OSM name-matching. Returns { harkinsId, cinemaId, name,
    // lat, lng } for all ~32 Harkins locations; filter to search radius.
    const harkinsDirectTheaters = [];
    if (wantChain("harkins")) {
      try {
        const allHarkins = await getHarkinsTheaters();
        for (const t of allHarkins) {
          const dMin = estimatedMinutesAway(originLat, originLng, t.lat, t.lng);
          if (dMin <= Number(radiusMin)) {
            harkinsDirectTheaters.push({ ...t, distanceMin: dMin });
          }
        }
        console.error(
          `Harkins direct: ${harkinsDirectTheaters.length} theaters within ${radiusMin}min` +
          (harkinsDirectTheaters.length ? ": " + harkinsDirectTheaters.map((t) => t.name).join(", ") : "")
        );
      } catch (err) {
        console.error("Harkins direct: theater list fetch failed:", err.message);
      }
    }

    const regencyResolvedTheaters = {};
    if (wantChain("regency")) {
      for (const t of theatersInRange) {
        if (REGENCY_THEATER_MAP[t.name] != null) {
          regencyResolvedTheaters[t.name] = REGENCY_THEATER_MAP[t.name];
        }
      }
    }

    const knownChainTheaterNames = new Set([
      ...Object.keys(regalResolvedIds),
      // AMC theaters are discovered directly from AMC's own API (amcDirectTheaters),
      // not from OSM, so there's no OSM-name set to add here.
      ...Object.keys(cinemarkResolvedIds),
      ...Object.keys(cinemaWestResolvedTheaters),
      // Harkins theaters are discovered directly from Harkins' own API (harkinsDirectTheaters),
      // not from OSM, so there's no OSM-name set to add here.
      ...Object.keys(regencyResolvedTheaters),
    ]);
    const theatersInRangeAll = theatersInRange; // kept for the raw discovery count in the response
    const excludedFromSerpApi = theatersInRange.filter((t) => !knownChainTheaterNames.has(t.name));
    if (excludedFromSerpApi.length > 0) {
      console.error(
        `Skipping SerpApi entirely for ${excludedFromSerpApi.length} theater(s) not in our known chain set ` +
        `(saves the credits): ${excludedFromSerpApi.map((t) => t.name).join(", ")}`
      );
    }

    // SerpApi is now a fallback ONLY, not the primary discovery path --
    // all four currently-supported chains (AMC, Regal, Cinemark, Cinema
    // West) have their own native "what's playing at this theater"
    // discovery, originally built for pricing but equally capable of
    // discovery on their own. Since we already know the target movie
    // upfront (the whole point of pre-loading the movie dropdown, rather
    // than discovering it via a search), each chain's own listing is
    // strictly better than routing through Google's SERP for it: no
    // per-theater SerpApi cost, no theater-name-matching ambiguity, and
    // no dependency on Google's local-showtimes data actually being
    // populated for that theater (the AMC Orange 30 issue from earlier).
    //
    // theatersToSearch is therefore empty in practice right now -- every
    // theater we ever search resolves to one of these four chains (non-
    // chain theaters are excluded above already), and all four have
    // native discovery. Kept as real, working code rather than deleted,
    // so a hypothetical future 5th chain without its own discovery still
    // has somewhere to fall back to.
    const CHAINS_WITH_NATIVE_DISCOVERY = new Set(["regal", "amc", "cinemark", "cinemawest", "harkins", "regency"]);
    function chainsMatchingTheater(theaterName) {
      const chains = [];
      if (regalResolvedIds[theaterName] != null) chains.push("regal");
      // AMC and Harkins are discovered separately via their own APIs, not via theatersInRange names
      if (cinemarkResolvedIds[theaterName] != null) chains.push("cinemark");
      if (cinemaWestResolvedTheaters[theaterName] != null) chains.push("cinemawest");
      if (regencyResolvedTheaters[theaterName] != null) chains.push("regency");
      return chains;
    }
    const theatersToSearch = theatersInRange.filter((t) => {
      if (!knownChainTheaterNames.has(t.name)) return false;
      const chains = chainsMatchingTheater(t.name);
      return !chains.every((c) => CHAINS_WITH_NATIVE_DISCOVERY.has(c));
    });

    if (theatersInRangeAll.length > 0 && knownChainTheaterNames.size === 0 && amcDirectTheaters.length === 0 && harkinsDirectTheaters.length === 0) {
      return res.json({
        movie,
        theatersFound: nearbyTheaters.length,
        theatersInRange: theatersInRangeAll.length,
        results: [],
        note: "Found theaters in range, but none matched a known chain (AMC/Regal/Cinemark/Cinema West) -- nothing to price.",
      });
    }

    // ---- Phase 2: SerpApi fallback, only for chain-matched theaters whose chain lacks native discovery (currently: none) ----
    const perTheaterResults = theatersToSearch.length === 0 ? [] : await Promise.all(
      theatersToSearch.map((theater) =>
        priceLimit(async () => {
          try {
            const entries = await getPricedShowtimes({
              movieTitle: movie,
              theaterName: theater.displayName || theater.name,
              location: resolvedLocation,
              dateISO: searchDateISO,
            });
            return { theater, entries, error: null };
          } catch (err) {
            console.error(`SerpApi lookup failed for ${theater.name}:`, err.message);
            return { theater, entries: [], error: err.message };
          }
        })
      )
    );

    const totalRawEntries = perTheaterResults.reduce(
      (sum, r) => sum + r.entries.length,
      0
    );

    // Real per-movie runtime instead of the flat RUNTIME_MIN fallback --
    // same lookup already used in the window-search endpoint (movie-
    // runtime overrides -> Cinemark page scrape -> SerpApi Knowledge
    // Graph -> RUNTIME_MIN as a last resort). One lookup per search
    // (not per-theater/showing), since it's the same movie throughout.
    // This also quietly improves the existing deadline filter's
    // accuracy -- it previously always assumed 128 minutes regardless
    // of the real movie's length.
    const realRuntimeMin = await getRuntimeMinutes(movie, RUNTIME_MIN, getHarkinsRuntimeForMovie);

    function formatEndTime(startTimeRaw, runtimeMinutes) {
      // runtimeMinutes here already includes the trailer buffer -- the
      // listed showtime is when trailers start, not the film itself, so
      // the real end time is advertised_start + trailers + actual_runtime,
      // not just advertised_start + runtime.
      const startMin = parseGoogleTime(startTimeRaw);
      if (startMin === null) return null;
      const endMinOfDay = (startMin + runtimeMinutes) % (24 * 60);
      const crossesMidnight = startMin + runtimeMinutes >= 24 * 60;
      let h = Math.floor(endMinOfDay / 60);
      const m = endMinOfDay % 60;
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12;
      if (h === 0) h = 12;
      const timeStr = `${h}:${String(m).padStart(2, "0")} ${ampm}`;
      return crossesMidnight ? `${timeStr} (next day)` : timeStr;
    }

    // Same as formatEndTime, but produces a range string ("4:12-4:22 PM")
    // when low/high differ (the general uncertainty case), or a single
    // precise time (identical to formatEndTime's own output) when a
    // theater has a real known trailer-time observation and low === high.
    function formatEndTimeRange(startTimeRaw, baseMinutes, low, high) {
      const lowStr = formatEndTime(startTimeRaw, baseMinutes + low);
      if (low === high) return lowStr;
      const highStr = formatEndTime(startTimeRaw, baseMinutes + high);
      // Only show a real range if the two ends actually produce
      // different displayed times (they could round to the same minute
      // in an edge case) -- avoids a confusing "4:12-4:12 PM".
      return lowStr === highStr ? lowStr : `${lowStr} - ${highStr}`;
    }

    // Shared by every chain's native discovery below (and, as a fallback,
    // SerpApi) -- filters a raw showing to the search window and builds
    // the final result shape. Centralizing this once avoids repeating
    // the same deadline/radius/format logic four more times per chain.
    function buildResultIfWithinWindow({ theaterName, distanceMin, startTimeRaw, format, price, priceExtras, bookingLink, priceSource, chain }) {
      const startMin = parseGoogleTime(startTimeRaw);
      if (startMin === null) return null;

      const { low: trailerLow, high: trailerHigh } = getTrailerBufferRange(theaterName);
      // Conservative on purpose: use the HIGH end for the actual
      // deadline filter, not an average or the low end. Underestimating
      // here means recommending a showing that might genuinely run past
      // your deadline -- the worse failure mode -- so when uncertain,
      // filter as if trailers run long.
      const endMin = startMin + realRuntimeMin + trailerHigh;
      if (startMin < nowMinutes) return null;
      if (endMin > deadlineMinutes) return null;
      if (!matchesWantedFormat(format, wantedFormats)) return null;

      const built = {
        theaterName,
        distanceMin,
        // Chain identity, independent of priceSource -- priceSource is
        // null whenever pricing failed for this specific showing, which
        // would otherwise make that card invisible to a chain filter
        // even though the theater and chain are both known regardless
        // of whether a price was found. "other" covers theaters found
        // only through SerpApi's general listing (indie/regional chains
        // this project has no direct adapter for), not a gap -- it's a
        // real, meaningful bucket for the chain-filter chips.
        chain: chain || "other",
        format,
        startTime: startTimeRaw,
        estimatedEndTime: formatEndTimeRange(startTimeRaw, realRuntimeMin, trailerLow, trailerHigh),
        filmActuallyStartsAt: formatEndTimeRange(startTimeRaw, 0, trailerLow, trailerHigh),
        runtimeMinutes: realRuntimeMin,
        price: price ?? null,
        bookingLink: bookingLink ?? null,
        priceSource: priceSource ?? null,
        ...(priceExtras || {}),
      };

      // AMC Stubs' real "50% off Tuesdays & Wednesdays" benefit,
      // confirmed directly from AMC's own official terms text: applies
      // to the adult base ticket price only, NOT the convenience fee or
      // tax. This can never be more than an estimate -- the discount is
      // a membership benefit applied at checkout by AMC's own system,
      // not something exposed anywhere in the showtimes API (confirmed
      // real: ticketPrices data for a Tuesday showing at AMC Norwalk 20
      // only ever contains ADULT/CHILD/SENIOR, nothing discount-
      // specific to read instead of computing this ourselves).
      //
      // NINE real confirmed discount observations now, from nine real
      // Order Details screenshots (none match the marketing copy's
      // rounded "50% off" as a simple percentage):
      //   Matinee, Atlantic Times Square, $11.99 (1st visit): -$4.50 (37.5%)
      //   Matinee, Norwalk, $13.59:                             -$5.85 (43.0%)
      //   Matinee, Burbank, $17.19:                             -$7.45 (43.3%)
      //   Matinee, Atlantic Times Square, $13.19 (2nd visit):  -$5.70 (43.2%)
      //   Matinee, Atlantic Times Square, $11.99 (3rd visit):  -$4.50 (37.5%)
      //   Matinee, Atlantic Times Square, $18.19, 3D:          -$5.70 (31.3%)
      //   Matinee, Americana Brand 18, $16.39:                  -$7.15 (43.6%)
      //   Evening, Burbank, $21.49:                             -$11.75 (54.7%)
      //   Evening, Fullerton, $18.99:                           -$10.50 (55.3%)
      //   Evening, Tyler Galleria 16, $21.99 Dolby:             -$7.75  (35.2%)
      //
      // REAL INSIGHT, likely explains the whole pattern: the discount
      // looks like a FLAT PER-FILM DOLLAR AMOUNT, not a percentage of
      // the listed price at all. The $13.19 (2D) and $18.19 (3D)
      // observations, same theater, same 12:45 slot, gave the EXACT
      // SAME $5.70 discount despite a $5.00 higher price -- consistent
      // with the 3D format surcharge simply being added on top,
      // untouched by the discount. This matches AMC's own terms
      // exactly: "Discount does not apply to... surcharge for premium
      // formats." Under this model, "$11.99 reproduced 37.5% exactly
      // twice" and "several different films/theaters all cluster near
      // 43%" both make sense too -- likely each cluster is one film (or
      // a small set of films sharing the same distributor-negotiated
      // flat discount), not one universal rate with noise around it.
      //
      // Can't implement the accurate per-film model with data
      // available -- nothing in any API this project has access to
      // exposes a per-film discount amount. Still using price-
      // percentage as an imperfect proxy, widened again for this new
      // 43.6% high (a new theater, Americana Brand 18, landing just
      // outside the existing cluster) rather than treat it as noise to
      // exclude.
      //
      // KNOWN LIMITATION: premium format surcharges (Dolby, IMAX, etc.)
      // are NOT discounted per AMC's own terms. The AMC API returns the
      // full premium price as the adult ticket price without separating
      // base from surcharge, so the discount estimate here will
      // over-discount premium format tickets -- e.g. Tyler Galleria 16
      // Dolby at $21.99 had only a $7.75 (35.2%) discount, not the
      // ~55% the evening rate would predict, because only the ~$14 base
      // portion was discounted and the ~$8 Dolby surcharge was not.
      // Fixing this accurately requires knowing the non-premium base
      // price at each theater, which nothing in the API exposes.
      const AMC_EVENING_RATE_LOW = 11.75 / 21.49; // Burbank, exact real ratio
      const AMC_EVENING_RATE_HIGH = 10.50 / 18.99; // Fullerton, exact real ratio
      const AMC_MATINEE_RATE_LOW = 5.70 / 18.19; // Atlantic Times Square 3D, exact real ratio
      const AMC_MATINEE_RATE_HIGH = 7.15 / 16.39; // Americana Brand 18, exact real ratio -- new high
      if (built.priceSource === "amc-direct" && built.priceBeforeFee != null) {
        const dayOfWeek = new Date(`${searchDateISO}T12:00:00`).getDay(); // noon avoids any UTC-vs-local date-rollover edge case
        const isStubsDiscountDay = dayOfWeek === 2 || dayOfWeek === 3; // Tuesday or Wednesday
        if (isStubsDiscountDay) {
          const isEvening = startMin >= 17 * 60; // 5pm cutoff -- unconfirmed exact boundary
          const rateLow = isEvening ? AMC_EVENING_RATE_LOW : AMC_MATINEE_RATE_LOW;
          const rateHigh = isEvening ? AMC_EVENING_RATE_HIGH : AMC_MATINEE_RATE_HIGH;
          const fee = built.estimatedFee ?? 0;

          const baseAtLowRate = Math.round((built.priceBeforeFee * (1 - rateLow)) * 100) / 100;
          const baseAtHighRate = Math.round((built.priceBeforeFee * (1 - rateHigh)) * 100) / 100;
          // Higher discount RATE means a LOWER resulting price -- sort so
          // "InPersonLow"/"OnlineLow" are always the cheaper end of the range.
          const inPersonLow = Math.min(baseAtLowRate, baseAtHighRate);
          const inPersonHigh = Math.max(baseAtLowRate, baseAtHighRate);

          built.amcStubsDiscountPriceInPersonLow = inPersonLow;
          built.amcStubsDiscountPriceInPersonHigh = inPersonHigh;
          built.amcStubsDiscountPriceOnlineLow = Math.round((inPersonLow + fee) * 100) / 100;
          built.amcStubsDiscountPriceOnlineHigh = Math.round((inPersonHigh + fee) * 100) / 100;
          built.amcStubsDiscountNote = `Estimate based on 2 real confirmed ${isEvening ? "evening" : "matinee"} purchases, shown as a range since real observations ${isEvening ? "were fairly consistent" : "varied meaningfully"} -- not verified for every showing. AMC's actual matinee/evening cutoff time isn't confirmed either, just assumed at 5pm.`;
        }
      }

      return built;
    }

    // ---- Flatten to individual showings and apply the timing/format filters ----
    const results = [];
    for (const { theater, entries } of perTheaterResults) {
      for (const entry of entries) {
        const built = buildResultIfWithinWindow({
          theaterName: theater.name,
          distanceMin: theater.distanceMin,
          startTimeRaw: entry.time,
          format: entry.format,
          price: entry.price,
          chain: "other",
          bookingLink: entry.link,
        });
        if (built) results.push(built);
      }
    }

    // ---- Phase 3: Regal is now handled separately (see /api/search-regal) ----
    // Moved out of the main handler so a slow/retrying Regal request never
    // blocks the rest of the results -- the frontend fires both endpoints
    // in parallel and merges Regal's results in whenever they arrive.

    // ---- Phase 4: AMC -- native discovery + pricing in one step ----
    // No longer "enrich existing results" -- there may be none, since
    // SerpApi is now skipped for chain-covered theaters. This IS
    // discovery: AMC's own official API already knows every movie
    // playing at a theater today, with real pricing included in the
    // same response, so filtering to the target movie + search window
    // happens directly against AMC's own data.
    // amcDirectTheaters was populated in the early chain-resolution
    // block above (before Phase 2) -- theaters come straight from
    // AMC's own API with their own IDs, names, and coordinates.
    await Promise.all(
      amcDirectTheaters.map((theater) =>
        priceLimit(async () => {
          const theaterName = theater.name;
          try {
            // No candidateMinutes passed -- this is now the discovery
            // step itself, not a narrow-and-price step against
            // something else's candidates.
            const allShowings = await getAmcPricedShowtimes({
              theatreId: theater.id,
              movieTitle: movie,
              dateISO: searchDateISO,
            });

            for (const showing of allShowings) {
              if (!showing.time) continue;
              const built = buildResultIfWithinWindow({
                theaterName,
                distanceMin: theater.distanceMin,
                startTimeRaw: showing.time.slice(0, 5), // "HH:MM:SS" -> "HH:MM", parseGoogleTime already handles bare 24hr
                format: showing.format,
                price: showing.price,
                chain: "amc",
                priceSource: showing.price != null ? "amc-direct" : null,
                // Real, confirmed link straight from AMC's own official
                // API -- was falling back to a Google search guess
                // before despite AMC handing us the exact real link the
                // whole time. Fallback only if the field is somehow
                // missing for a specific showing.
                bookingLink: showing.purchaseUrl || googleFallbackLink(theaterName, movie),
                priceExtras: {
                  priceBeforeTax: showing.priceBeforeTax,
                  priceBeforeFee: showing.priceBeforeFee,
                  tax: showing.tax,
                  estimatedFee: showing.estimatedFee,
                  feeStatus: showing.feeStatus,
                },
              });
              if (built) results.push(built);
            }
          } catch (err) {
            console.error(`AMC discovery/pricing failed for ${theaterName}:`, err.message);
          }
        })
      )
    );

    // ---- Phase 5: real pricing for Cinemark theaters we have IDs for ----
    // Paused by default via DISABLE_CINEMARK_PRICING -- flip to "false"
    // in start.sh to enable. CONFIRMED WORKING LIVE (real priced results,
    // including the real per-ticket fee): the Cloudflare risk flagged
    // here throughout development turned out not to block this specific
    // page, at least from this app's request pattern.
    const cinemarkPricingDisabled = process.env.DISABLE_CINEMARK_PRICING !== "false";

    // cinemarkResolvedIds was already computed in the early chain-
    // resolution block above (before Phase 2) -- reused here as-is.

    // Movie ID resolution: static map first (instant, zero extra
    // requests), then live derivation as a fallback for any movie not
    // in it -- fetches one already-matched Cinemark theater's page
    // (same technique as the runtime lookup below) and reads that
    // movie's own cinemarkMovieId directly out of its TicketSeatMap
    // links. This is what actually extends Cinemark pricing beyond the
    // single movie that used to be manually mapped -- no more hand-
    // adding an entry to lib/cinemark-movie-map.js per movie.
    let cinemarkMovieId = CINEMARK_MOVIE_MAP[movie];
    if (!cinemarkMovieId && !cinemarkPricingDisabled) {
      const matchedTheaterName = Object.keys(cinemarkResolvedIds)[0];
      let slug = matchedTheaterName ? CINEMARK_THEATER_SLUGS[matchedTheaterName] : null;
      // Fall back to the auto-generated CA list, which has a slug for
      // every one of its ~52 theaters -- the static CINEMARK_THEATER_SLUGS
      // map above only covers the 5 manually-added Sacramento theaters.
      if (!slug && matchedTheaterName) {
        try {
          const caCinemarkTheaters = require("./lib/cinemark-theaters-ca");
          const matchedId = cinemarkResolvedIds[matchedTheaterName];
          const found = caCinemarkTheaters.find((t) => t.id === matchedId);
          slug = found?.slug || null;
        } catch {
          // lib/cinemark-theaters-ca.js doesn't exist yet -- fine, just
          // no slug available from this source.
        }
      }
      if (slug) {
        try {
          cinemarkMovieId = await getCinemarkMovieIdForTitle(slug, movie);
          if (cinemarkMovieId) {
            console.error(`Cinemark: derived cinemarkMovieId ${cinemarkMovieId} for "${movie}" live from ${slug}.`);
          }
        } catch (err) {
          console.error(`Cinemark: live movie-ID lookup failed for "${movie}" via ${slug}:`, err.message);
        }
      }
    }

    if (cinemarkPricingDisabled) {
      console.error(
        "Cinemark pricing skipped: DISABLE_CINEMARK_PRICING is not \"false\". Set it in start.sh to re-enable."
      );
    } else if (!cinemarkMovieId) {
      console.error(
        `Cinemark pricing skipped: couldn't resolve a cinemarkMovieId for "${movie}" -- not in lib/cinemark-movie-map.js, and live lookup either found no matched Cinemark theater in range or that theater's page doesn't have this title. Add a manual entry to the map if this persists.`
      );
    } else {
      // No longer "enrich existing results" -- this IS discovery now.
      // cinemarkTheatersToPrice derived from theatersInRange directly
      // (theatersInRange always has real data; results may start empty
      // now that SerpApi is skipped for chain-covered theaters).
      const cinemarkTheatersToPrice = theatersInRange
        .filter((t) => cinemarkResolvedIds[t.name] != null)
        .map((t) => t.name);
      const distanceMinByTheaterId = {};
      for (const t of theatersInRange) {
        const id = cinemarkResolvedIds[t.name];
        if (id != null) distanceMinByTheaterId[id] = t.distanceMin;
      }
      const theaterNameByTheaterId = {};
      for (const t of theatersInRange) {
        const id = cinemarkResolvedIds[t.name];
        if (id != null) theaterNameByTheaterId[id] = t.name;
      }

      if (cinemarkTheatersToPrice.length > 0) {
        try {
          // One batched call covers every matched theater at once -- the
          // real endpoint takes a CSV of theater IDs, confirmed from your
          // capture (9 theaters in a single request).
          const theaterIdsCsv = cinemarkTheatersToPrice
            .map((name) => cinemarkResolvedIds[name])
            .join(",");

          const dateISO = searchDateISO;
          const showtimes = await getCinemarkShowtimesForMovie({
            cinemarkMovieId,
            dateISO,
            theaterIdsCsv,
          });

          // Filter to the search window BEFORE pricing anything -- same
          // principle as Regal/Cinema West above, no reason to spend a
          // pricing call on a showing that wouldn't survive the
          // deadline/radius filter anyway. Cinemark's own discovery
          // already has real format data (data-print-type-name), unlike
          // Regal's, so no "Standard" fallback needed here.
          const toPrice = [];
          for (const s of showtimes) {
            const theaterName = theaterNameByTheaterId[s.theaterId];
            if (!theaterName || !s.showtimeISO) continue;
            const startTimeRaw = isoToHHMM(s.showtimeISO);
            const wouldBeInWindow = buildResultIfWithinWindow({
              theaterName,
              distanceMin: distanceMinByTheaterId[s.theaterId],
              startTimeRaw,
              format: cinemarkDisplayFormat(s.format),
              chain: "cinemark",
            });
            if (wouldBeInWindow) toPrice.push({ theaterName, match: s, startTimeRaw });
          }

          await Promise.all(
            toPrice.map(({ theaterName, match, startTimeRaw }) =>
              priceLimit(async () => {
                try {
                  const priced = await getCinemarkTicketPricing({
                    theaterId: match.theaterId,
                    showtimeId: match.showtimeId,
                    cinemarkMovieId: match.cinemarkMovieId,
                    showtimeISO: match.showtimeISO,
                  });
                  const built = buildResultIfWithinWindow({
                    theaterName,
                    distanceMin: distanceMinByTheaterId[match.theaterId],
                    startTimeRaw,
                    format: cinemarkDisplayFormat(match.format),
                    price: priced.price,
                    chain: "cinemark",
                    priceSource: priced.price != null ? "cinemark-direct" : null,
                    bookingLink: googleFallbackLink(theaterName, movie),
                    priceExtras: {
                      priceBeforeFee: priced.priceBeforeFee,
                      fee: priced.fee,
                      feeStatus: priced.price != null ? "confirmed" : null, // real per-showing data, not an estimate -- see lib/priceAdapters/cinemark-official.js
                    },
                  });
                  if (built) results.push(built);
                } catch (err) {
                  console.error(
                    `Cinemark pricing failed for ${theaterName} showtime ${match.showtimeId}:`,
                    err.message
                  );
                }
              })
            )
          );
        } catch (err) {
          console.error("Cinemark showtime discovery failed:", err.message);
        }
      }
    }

    // ---- Phase 6: Cinema West -- native discovery + pricing (Vista-family platform) ----
    // Token is now fetched live per theater (see getFreshTokenCached in
    // cinemawest-official.js) -- confirmed real: Cinema West's own site
    // bakes a fresh access token directly into its theater page's HTML on
    // every load, so there's no manual token-pasting needed anymore.
    // cinemaWestResolvedTheaters was already computed in the early
    // chain-resolution block above (before Phase 2) -- reused here as-is.
    // No longer "enrich existing results" -- this IS discovery now,
    // filtering Cinema West's own showings against the search window
    // directly instead of matching against something SerpApi found.
    const cinemaWestTheaterEntries = theatersInRange.filter((t) => cinemaWestResolvedTheaters[t.name]);

    // CONFIRMED REAL BUG, caught in testing before shipping: new
    // Date(iso).getHours()/getMinutes() extract the time in the
    // SERVER's own local system timezone, not the timezone actually
    // embedded in the ISO string (e.g. "-07:00" for Pacific). A real
    // test case -- "2026-08-17T14:30:00-07:00" (2:30pm Pacific) --
    // silently became "21:30" when run in a UTC environment. Fixed by
    // extracting the wall-clock HH:MM directly from the ISO string's
    // own text, which is already correctly offset for the theater's
    // timezone -- no Date object, no timezone conversion, no
    // depending on the server's system timezone matching the
    // theater's at all.
    function isoToHHMM(iso) {
      const match = /T(\d{2}):(\d{2})/.exec(iso);
      return match ? `${match[1]}:${match[2]}` : null;
    }

    await Promise.all(
      cinemaWestTheaterEntries.map((theater) =>
        priceLimit(async () => {
          const theaterName = theater.displayName || theater.name;
          const { siteId, sitePath } = cinemaWestResolvedTheaters[theaterName];
          try {
            const cinemaWestToken = await getCinemaWestFreshToken(sitePath);
            const showings = await getCinemaWestShowtimes({ siteId, bearerToken: cinemaWestToken });
            const movieMatches = showings.filter((s) => matchesMovie(s.movieName, movie));

            console.error(
              `Cinema West [${siteId}]: found ${showings.length} total showings, ${movieMatches.length} matching "${movie}". ` +
              `Movies seen: ${[...new Set(showings.map((s) => s.movieName))].join(", ") || "(none)"}`
            );

            for (const match of movieMatches) {
              if (!match.filmStartsAtISO) continue;
              const startTimeRaw = isoToHHMM(match.filmStartsAtISO);

              // Check the search window BEFORE pricing -- no reason to
              // spend a pricing call on a showing that wouldn't survive
              // the deadline/radius filter anyway.
              const wouldBeInWindow = buildResultIfWithinWindow({
                theaterName,
                distanceMin: theater.distanceMin,
                startTimeRaw,
                format: match.format,
                chain: "cinemawest",
              });
              if (!wouldBeInWindow) continue;

              try {
                const priced = await getCinemaWestTicketPricing({
                  theaterCode: match.theaterCode,
                  showtimeId: match.showtimeId,
                  bearerToken: cinemaWestToken,
                });
                const built = buildResultIfWithinWindow({
                  theaterName,
                  distanceMin: theater.distanceMin,
                  startTimeRaw,
                  format: match.format,
                  price: priced.price,
                  chain: "cinemawest",
                  priceSource: priced.price != null ? "cinemawest-direct" : null,
                  // Confirmed real, but theater-page level not session-
                  // specific -- goes to the theater's showtimes page,
                  // where the exact showing needs to be selected again.
                  bookingLink: `https://web.cinemawest.com/sites/${sitePath}`,
                  priceExtras: {
                    priceBeforeFee: priced.priceBeforeFee,
                    fee: priced.fee,
                    feeStatus: priced.price != null ? "confirmed" : null, // real per-showing data, not an estimate
                  },
                });
                if (built) results.push(built);
              } catch (err) {
                console.error(
                  `Cinema West pricing failed for ${theaterName} showtime ${match.showtimeId}:`,
                  err.message
                );
              }
            }
          } catch (err) {
            console.error(`Cinema West showtime discovery failed for ${theaterName}:`, err.message);
          }
        })
      )
    );

    // ---- Phase 7: Harkins -- native discovery + pricing (Vista-family platform) ----
    // harkinsDirectTheaters was populated in the early chain-resolution
    // block above (before Phase 2) -- theaters come straight from
    // Harkins' own ticketing API with both IDs and coordinates.
    // Discovery covers every Harkins theater nationwide in one call
    // (see getShowtimesForMovie in harkins-official.js), so we only need
    // to call it ONCE per search, not once per matched theater -- filter
    // its results down to the theaters we actually matched afterward.

    if (harkinsDirectTheaters.length > 0) {
      try {
        // anyTheaterId just needs to be A real Harkins theater ID (the
        // discovery call doesn't actually filter by it despite the
        // parameter's name) -- using whichever matched theater happens
        // to be first.
        const anyHarkinsId = harkinsDirectTheaters[0].harkinsId;
        const allPerformances = await getHarkinsShowtimesForMovie({
          movieTitle: movie,
          dateISO: searchDateISO,
          anyTheaterId: anyHarkinsId,
        });

        console.error(
          `Harkins: found ${allPerformances.length} total performances nationwide for "${movie}" on ${searchDateISO}.`
        );

        await Promise.all(
          harkinsDirectTheaters.map((theater) =>
            priceLimit(async () => {
              const theaterName = theater.name;
              const { harkinsId, cinemaId } = theater;
              const theaterPerformances = allPerformances.filter((p) => String(p.theatreId) === String(harkinsId));

              // Real gap this was missing before: no per-theater visibility at
              // all, just the nationwide total. If this theater's own match
              // comes up empty, log every distinct theatreId actually present
              // in the nationwide response -- directly answers whether our
              // harkinsId ("63" for Cerritos, from the theater map) is even
              // the right value to be matching against, rather than needing
              // to guess.
              if (theaterPerformances.length === 0) {
                const distinctTheatreIds = [...new Set(allPerformances.map((p) => p.theatreId))];
                console.error(
                  `Harkins [${theaterName}, harkinsId=${harkinsId}]: 0 performances matched. ` +
                  `Distinct theatreId values actually present in the nationwide response: ${distinctTheatreIds.slice(0, 30).join(", ")}` +
                  (distinctTheatreIds.length > 30 ? ` (+${distinctTheatreIds.length - 30} more)` : "")
                );
              } else {
                console.error(`Harkins [${theaterName}, harkinsId=${harkinsId}]: ${theaterPerformances.length} performances matched this theater.`);
              }

              // Real gap this was missing too: no visibility into WHY
              // matched performances never made it into results -- could
              // be missing showtimeOffset, could be the time window,
              // could be the format filter, could be a pricing failure.
              // Breaking this down explicitly rather than guessing at
              // which one it is -- CONFIRMED this ambiguity caused real
              // confusion once already: a format-filter rejection
              // (Harkins' "Digital" not matching the "standard" chip)
              // got mislabeled as "outside window" since
              // buildResultIfWithinWindow returns null the same way for
              // both, and this counter didn't distinguish them. Format
              // rejections are now checked and counted separately.
              let missingOffset = 0;
              let formatRejected = 0;
              let outsideWindow = 0;
              let pricingAttempted = 0;
              let pricingSucceeded = 0;
              const sampleTimes = [];

              for (const perf of theaterPerformances) {
                if (!perf.showtimeOffset) {
                  missingOffset++;
                  continue;
                }
                const startTimeRaw = isoToHHMM(perf.showtimeOffset);
                sampleTimes.push(`${startTimeRaw} (${perf.format})`);

                if (!matchesWantedFormat(perf.format, wantedFormats)) {
                  formatRejected++;
                  continue;
                }

                const wouldBeInWindow = buildResultIfWithinWindow({
                  theaterName,
                  distanceMin: theater.distanceMin,
                  startTimeRaw,
                  format: harkinsDisplayFormat(perf.format),
                  chain: "harkins",
                });
                if (!wouldBeInWindow) {
                  outsideWindow++;
                  continue;
                }

                pricingAttempted++;
                try {
                  const priced = await getHarkinsTicketPricing({ cinemaId, sessionId: perf.sessionId });
                  // Same shape as the Regal path: the adapter returns the
                  // bare ticket price, and the estimated service fee is
                  // added here so the number shown is what you'd actually
                  // pay at checkout, not a base price that quietly
                  // undercounts by ~$2 per ticket against every other
                  // chain's fee-inclusive figure.
                  const harkinsFee = priced.price != null ? estimateHarkinsFee(perf.format) : null;
                  const built = buildResultIfWithinWindow({
                    theaterName,
                    distanceMin: theater.distanceMin,
                    startTimeRaw,
                    format: harkinsDisplayFormat(perf.format),
                    price: priced.price != null ? Math.round((priced.price + harkinsFee) * 100) / 100 : null,
                    chain: "harkins",
                    priceSource: priced.price != null ? "harkins-direct" : null,
                    // Real, confirmed SESSION-specific URL, provided
                    // directly: harkins.com/ticketing/theatre/{harkinsId}/
                    // movie/{movieId}/session/{sessionId}/date/{date} --
                    // more precise than the movie-page-only link used
                    // before (this one lands you right at the specific
                    // showing, not just the movie's general page).
                    bookingLink: `https://harkins.com/ticketing/theatre/${harkinsId}/movie/${perf.movieId}/session/${perf.sessionId}/date/${searchDateISO}`,
                    priceExtras: {
                      // Harkins' pricing API genuinely exposes no fee field -- CONFIRMED, not just unread: a full real GetTicketTypes response was checked end-to-end (every ticket type, top-level fields included) and has none anywhere. So the fee is estimated from real observed checkout values ($2.09 regular / $2.49 premium) rather than read, hence feeStatus "estimated" -- same honesty convention already used on the Regal path.
                      ...(priced.price != null
                        ? { priceBeforeFee: priced.price, estimatedFee: harkinsFee, feeStatus: "estimated" }
                        : { feeStatus: null }),
                      // Harkins' OWN real ticket type name (e.g.
                      // "Matinee" -- confirmed real from a captured
                      // GetTicketTypes response, whose description
                      // literally says "for shows starting before
                      // 5pm," independently validating the 5pm cutoff
                      // already used for the AMC Stubs heuristic).
                      // Chain-agnostic field name (ticketTypeName, not
                      // harkinsTicketTypeName) since Regency's own
                      // pricing response carries the exact same real
                      // field under a different chain -- one badge,
                      // same meaning, wherever the underlying API
                      // actually names its own tiers.
                      ...(priced.ticketTypeName ? { ticketTypeName: priced.ticketTypeName } : {}),
                    },
                  });
                  if (built) {
                    pricingSucceeded++;
                    results.push(built);
                  }
                } catch (err) {
                  console.error(`Harkins pricing failed for ${theaterName} session ${perf.sessionId}:`, err.message);
                }
              }

              console.error(
                `Harkins [${theaterName}]: of ${theaterPerformances.length} matched -- ` +
                `${missingOffset} missing showtimeOffset, ${formatRejected} rejected by format filter, ` +
                `${outsideWindow} outside your search window, ` +
                `${pricingAttempted} pricing attempts (${pricingSucceeded} succeeded). ` +
                `Real times seen: ${sampleTimes.join(", ") || "(none)"}`
              );
            })
          )
        );
      } catch (err) {
        console.error(`Harkins showtime discovery failed:`, err.message);
      }
    }

    // No post-hoc filter needed here anymore -- theatersToSearch was
    // already narrowed to known-chain theaters before Phase 2 ever ran,
    // so results can only ever contain entries from those theaters.

    // ---- Phase 8: Regency Theatres -- native discovery + pricing (Mobile Moviegoing platform) ----
    // regencyResolvedTheaters was already computed in the early chain-
    // resolution block above (before Phase 2) -- reused here as-is.
    // Unlike Harkins, discovery here is per-theater, not nationwide --
    // getFilmShowtimesByLocation.php takes a specific site, so this runs
    // once per matched Regency theater rather than once for the whole
    // chain.
    const regencyTheaterEntries = theatersInRange.filter((t) => regencyResolvedTheaters[t.name]);

    await Promise.all(
      regencyTheaterEntries.map((theater) =>
        priceLimit(async () => {
          const theaterName = theater.displayName || theater.name;
          const { chain, site, seatsSiteId, locationSlug } = regencyResolvedTheaters[theaterName];
          try {
            // filmId is CONFIRMED required by the real endpoint (see the
            // correction note in regency-official.js). Resolved here via
            // getFilmIdMap, which hits doShowtimesNew.php ONCE for this
            // theater/date and returns every film playing there, keyed by
            // title -- confirmed real from a captured response covering 5
            // different movies at once. One extra request per theater per
            // search, not per movie.
            //
            // Matched with the same matchesMovie() fuzzy matcher already
            // used elsewhere in this file, since the titles here come from
            // Regency's own display strings and may not match the search
            // term byte-for-byte (case, punctuation, "The" prefix, etc.) --
            // reusing it here rather than a second ad-hoc comparison keeps
            // the matching behavior consistent everywhere in the file.
            //
            // If nothing matches (movie isn't playing at this theater, or
            // the resolver's title-extraction regex missed it), filmId
            // stays null and the request proceeds anyway -- exactly the
            // same as before this was wired up -- rather than skipping the
            // theater outright, since a null filmId is a known, already-
            // logged failure mode, not a new one.
            let filmId = null;
            try {
              const filmIdMap = await getRegencyFilmIdMap({ dateISO: searchDateISO, seatsSiteId, locationSlug });
              const matchedTitle = Object.keys(filmIdMap).find((title) => matchesMovie(title, movie));
              if (matchedTitle) {
                filmId = filmIdMap[matchedTitle];
              } else {
                // No exception, no match -- previously this looked
                // identical to a genuine "not playing here" case with
                // zero visibility into which one actually happened.
                // Logging the raw map now so a silent empty/mismatched
                // response is distinguishable from a real absence.
                console.error(
                  `Regency [${theaterName}]: film ID lookup succeeded but found no match for "${movie}". ` +
                  `Map had ${Object.keys(filmIdMap).length} title(s): ${JSON.stringify(Object.keys(filmIdMap))}`
                );
              }
            } catch (err) {
              console.error(`Regency [${theaterName}]: film ID lookup failed, proceeding with filmId null:`, err.message);
            }

            // lat/lon: also confirmed required (the real client always
            // sends real geolocation) -- master.js's own
            // getCustLatLng()/locationSuccessInit() flow populates this
            // from the CUSTOMER's browser geolocation, not the theater's
            // coordinates. This backend has no browser to ask, but the
            // searcher's own originLat/originLng (the lat/lng this
            // search was run against) is the direct equivalent -- a real
            // customer position, not a stand-in for one. Previously this
            // sent theater.lat/theater.lng instead, which was strictly
            // closer to reality than 0/0 but not what the real client
            // actually sends.
            const allPerformances = await getRegencyShowtimesForLocation({
              chain,
              site,
              dateISO: searchDateISO,
              seatsSiteId,
              filmId,
              lat: originLat,
              lon: originLng,
            });
            const movieMatches = allPerformances.filter((p) => p.movieTitle && matchesMovie(p.movieTitle, movie));

            console.error(
              `Regency [${theaterName}]: filmId ${filmId ?? "UNRESOLVED"} for "${movie}", ` +
                `found ${allPerformances.length} total performances, ${movieMatches.length} matching.`
            );

            // CONFIRMED REAL GAP, found from a live report: this loop
            // had no per-outcome breakdown at all, unlike the Harkins
            // path a few hundred lines up ("X outside window, Y
            // rejected by format, Z pricing attempts"). If every
            // movieMatches entry got filtered by the deadline window
            // (or the format filter, inside the same
            // buildResultIfWithinWindow check), the loop below just
            // exits with zero further output -- indistinguishable from
            // "nothing to report" versus "5 things were found and then
            // silently dropped." A person reporting "no Regency at all"
            // with a real matching count sitting right above it in the
            // log is exactly the situation this couldn't answer.
            let outsideWindow = 0;
            let rejectedByFormat = 0;
            let pricingAttempted = 0;
            let pricingSucceeded = 0;

            for (const perf of movieMatches) {
              // perf.time is already a 12hr string ("1:15pm") straight
              // from the real aria-label text -- parseGoogleTime already
              // handles this format directly, no conversion needed.
              // Noon anchor avoids any UTC-vs-local date-rollover edge
              // case, same approach already used for the AMC Stubs
              // Tuesday/Wednesday check.
              const searchDateDow = new Date(`${searchDateISO}T12:00:00`).getDay();

              // CONFIRMED REAL BUG, found from a live report right
              // after shipping the recliner/LG LED format-recognition
              // fix: the single wouldBeInWindow call below used to
              // conflate two entirely different rejection reasons under
              // one misleading "outside window" label -- it tests BOTH
              // the deadline window AND the format filter internally
              // (matchesWantedFormat), and this outer counter only ever
              // saw one combined pass/fail bit. The actual live case:
              // all 5 real Regency performances were correctly inside
              // the search window the whole time -- they were being
              // rejected by the format filter instead, because the
              // pre-search UI's default format whitelist never included
              // "recliner" or "lg led" as options (those format strings
              // didn't exist as real, correctly-detected labels until
              // the fix that shipped alongside this one). Every prior
              // search had silently passed by accident, since every
              // Regency showing was mislabeled "Standard" before that
              // fix -- so this diagnostic gap was invisible until the
              // two changes landed in the same release and interacted.
              // Testing format separately here now, the same way
              // Harkins' own diagnostic already does a few hundred
              // lines up, so "outside window" can never again silently
              // mean "rejected by format" instead.
              if (!matchesWantedFormat(perf.format, wantedFormats)) {
                rejectedByFormat++;
                continue;
              }

              const wouldBeInWindow = buildResultIfWithinWindow({
                theaterName,
                distanceMin: theater.distanceMin,
                startTimeRaw: perf.time,
                format: perf.format,
                chain: "regency",
              });
              if (!wouldBeInWindow) {
                outsideWindow++;
                continue;
              }

              pricingAttempted++;
              try {
                const priced = await getRegencyTicketPricing({ perf: Number(perf.sessionId), site, seatsSiteId });
                // CORRECTION, confirmed real from actual checkout data
                // across 4 different real showings (standard and
                // premium formats, morning through evening): the
                // earlier assumption that getSeatData.php's price was
                // the full ticket cost was WRONG. Every one of the 4
                // real prices showed a flat $1 fee on top of the base
                // price returned here ($10+$1, $11.50+$1, $14.50+$1,
                // $17.50+$1) -- consistent regardless of format or
                // time of day, unlike Harkins' two-tier fee. Treated as
                // a flat $1 add, same estimated-fee pattern already
                // used for Regal/Harkins so the displayed total matches
                // what you'd actually pay at checkout.
                const regencyFee = priced.price != null ? 1.0 : null;
                const built = buildResultIfWithinWindow({
                  theaterName,
                  distanceMin: theater.distanceMin,
                  startTimeRaw: perf.time,
                  format: perf.format,
                  price: priced.price != null ? Math.round((priced.price + regencyFee) * 100) / 100 : null,
                  chain: "regency",
                  priceSource: priced.price != null ? "regency-direct" : null,
                  // Confirmed real URL pattern from live captures --
                  // this is the exact same seat-selection page the site
                  // itself links to for this session. Uses seatsSiteId
                  // (the hyphenated form), NOT site (the plain numeric
                  // ID used for API calls) -- confirmed these are two
                  // different representations, not interchangeable.
                  bookingLink: `https://www.regencymovies.com/seats/${seatsSiteId}/${perf.sessionId}/${perf.movieId}`,
                  priceExtras: {
                    ...(priced.price != null
                      ? { priceBeforeFee: priced.price, estimatedFee: regencyFee, feeStatus: "estimated" }
                      : { feeStatus: null }),
                    // Regency's OWN real ticket type name (e.g. a
                    // matinee/evening/day-of-week tier), read straight
                    // from getSeatData.php's ticketClassArray rather
                    // than guessed from a day-of-week/time rule the way
                    // AMC's Stubs discount has to be, since AMC's API
                    // never exposes this but Regency's genuinely does.
                    // This is Regency's own live pricing system already
                    // telling us which tier applied to this exact
                    // showing -- far more reliable than reconstructing
                    // "matinee Mon/Wed/Thu before 4pm" ourselves and
                    // hoping it holds for every Regency location, which
                    // it may not (confirmed different locations already
                    // have different chain-wide promos in this app, see
                    // the Tuesday $7.50 flat-rate note below). Field
                    // name is chain-agnostic (ticketTypeName, not
                    // regencyTicketTypeName) since Harkins' own pricing
                    // response carries the exact same real field --
                    // renamed so one badge on the frontend covers both
                    // chains automatically instead of needing a
                    // per-chain field check there.
                    ...(priced.ticketTypeName ? { ticketTypeName: priced.ticketTypeName } : {}),
                  },
                });
                // Regency charges a real flat $7.50 for standard tickets
                // on Tuesdays -- CONFIRMED by the user, not inferred.
                // Only apply it to formats that plausibly ARE the
                // "standard" ticket class the flat rate covers: we don't
                // have real confirmation the flat rate extends to 4DX,
                // ScreenX, or other premium formats at this chain (Regal
                // and Harkins both draw exactly that line between
                // standard and premium formats), so treat anything
                // outside plain Digital/2D as unconfirmed rather than
                // silently discounting it.
                if (built && searchDateDow === 2) {
                  const fmt = (perf.format || "").toLowerCase().trim();
                  const looksStandard = fmt === "" || fmt === "digital" || fmt === "2d" || fmt === "standard";
                  if (looksStandard) {
                    built.regencyTuesdayPrice = 7.5;
                    built.regencyTuesdayNote =
                      "Regency's confirmed real Tuesday flat rate for standard tickets. Not verified for 4DX/ScreenX/premium formats at this chain, so only applied here.";
                  }
                }
                if (built) {
                  pricingSucceeded++;
                  results.push(built);
                } else {
                  // Should be unreachable in practice now that format
                  // is checked BEFORE this point (see above) -- this
                  // call and the earlier wouldBeInWindow call use
                  // identical inputs, so if the format already passed
                  // and the window already passed, this recheck can't
                  // meaningfully differ. Left as a safety net rather
                  // than removed, in case buildResultIfWithinWindow
                  // ever gains a new rejection condition this loop
                  // doesn't know about -- if this line ever logs again,
                  // that's the signal to go look for one.
                  console.error(
                    `Regency [${theaterName}]: performance ${perf.sessionId} priced successfully but was ` +
                    `unexpectedly dropped by buildResultIfWithinWindow's internal recheck (format: "${perf.format}") -- ` +
                    `this should be unreachable; if it's firing, buildResultIfWithinWindow likely gained a new ` +
                    `rejection condition this loop isn't accounting for.`
                  );
                }
              } catch (err) {
                console.error(`Regency pricing failed for ${theaterName} session ${perf.sessionId}:`, err.message);
              }
            }
            if (movieMatches.length > 0) {
              console.error(
                `Regency [${theaterName}]: of ${movieMatches.length} matched -- ${rejectedByFormat} rejected by ` +
                `format filter, ${outsideWindow} outside your search window, ${pricingAttempted} pricing attempts ` +
                `(${pricingSucceeded} succeeded).`
              );
            }
          } catch (err) {
            console.error(`Regency showtime discovery failed for ${theaterName}:`, err.message);
          }
        })
      )
    );

    // For AMC results eligible for the Stubs Tuesday/Wednesday discount,
    // sort (and rank "cheapest") by the discounted price instead of the
    // full undiscounted one -- using the HIGH end of the estimated
    // range specifically (the more conservative number), and the
    // online/fee-inclusive variant so this stays an apples-to-apples
    // comparison with every other result's price, which also includes
    // its fee. Doesn't change what's DISPLAYED as the headline price
    // (still the real undiscounted figure, with the Stubs range shown
    // separately) -- only affects ordering.
    function effectivePriceForSorting(r) {
      if (r.amcStubsDiscountPriceOnlineHigh != null) return r.amcStubsDiscountPriceOnlineHigh;
      if (r.regencyTuesdayPrice != null) return r.regencyTuesdayPrice;
      return r.price;
    }

    results.sort((a, b) => {
      const priceA = effectivePriceForSorting(a);
      const priceB = effectivePriceForSorting(b);
      if (priceA == null && priceB == null) return 0;
      if (priceA == null) return 1;
      if (priceB == null) return -1;
      return priceA - priceB;
    });

    // A generous flat cap instead of a fixed standard/premium split --
    // format filtering now happens client-side (instant, no re-search)
    // against whatever's in this response, so this needs enough real
    // variety across formats for that filter to be useful, not just the
    // single cheapest handful.
    const RESULTS_CAP = 25;
    const cappedResults = results.slice(0, RESULTS_CAP);
    const totalMatchingShowings = results.length;

    // One lookup for the whole search, not per-theater/showing -- the
    // stinger info doesn't vary by where or when you see the same movie.
    // Guesses the current year first (a reasonable default for anything
    // currently in theaters), falling back to the site's own in-theaters
    // listing if that specific guess misses. Never blocks/fails the
    // actual search -- if MediaStinger is unreachable or the movie isn't
    // found, this just comes back null and the rest of the response is
    // unaffected.
    let mediaStinger = null;
    try {
      mediaStinger = await getStingerInfo(movie, new Date().getFullYear());
    } catch (err) {
      console.error(`MediaStinger lookup failed for "${movie}":`, err.message);
    }

    const response = {
      movie,
      searchDate: searchDateISO,
      searchedLat: originLat,
      searchedLng: originLng,
      locationResolved: resolvedLocation,
      locationResolutionError,
      theatersFound: nearbyTheaters.length,
      theatersInRange: theatersInRange.length,
      serpApiCallsUsed: theatersToSearch.length,
      // Real per-movie runtime, same value already used for every
      // result's own runtimeMinutes field -- surfaced here at the top
      // level too so the frontend can show it once, reliably, even when
      // results is empty (pulling it from results[0] would silently
      // break on a no-results search).
      runtimeMinutes: realRuntimeMin,
      // Regal's credit usage now lives entirely in /api/search-regal's
      // own response -- this endpoint no longer runs Regal at all, so
      // there's nothing real to report here. Removed rather than left
      // in as a stale/always-zero field, which would have been actively
      // misleading (implying no Regal credits were spent, when the
      // separate request may have spent real ones).
      rawShowtimesReturned: totalRawEntries,
      matchingShowings: totalMatchingShowings,
      mediaStinger,
      resultsShown: cappedResults.length,
      pricedCount: cappedResults.filter((r) => r.price != null).length,
      results: cappedResults,
    };

    if (timeWindowWarning) response.warning = timeWindowWarning;

    if (debug === "true") {
      // The SerpApi-based full-schedule check (fullSchedules below) costs
      // one real SerpApi call per theater, purely for diagnostic display
      // -- confirmed real risk: since chain-native discovery no longer
      // needs SerpApi at all, leaving this bundled into the default
      // debug=true would have silently kept burning SerpApi credits
      // every single time debug mode was used for anything else,
      // completely defeating today's restructuring. Split into its own
      // explicit opt-in (debugSerpApi=true) instead.
      const fullSchedules = debugSerpApi !== "true" ? null : await Promise.all(
        theatersInRange.map((theater) =>
          priceLimit(async () => {
            try {
              const all = await getTheaterSchedule({
                theaterName: theater.displayName || theater.name,
                location: resolvedLocation,
                dateISO: searchDateISO,
              });
              return {
                theater: theater.name,
                moviesFoundAtTheater: [...new Set(all.map((e) => e.movieName))],
              };
            } catch (err) {
              return { theater: theater.name, error: err.message };
            }
          })
        )
      );

      response.debug = {
        nowMinutes,
        deadlineMinutes,
        theatersInRange: theatersInRange.map((t) => t.name),
        theatersSearched: theatersToSearch.map((t) => t.name),
        theatersExcludedFromSerpApi: excludedFromSerpApi.map((t) => t.name),
        // Which chain (if any) each theater resolved to, and its native
        // ID for that chain -- the primary "why didn't theater X show
        // up" debug tool now, replacing the old SerpApi-schedule check
        // for the common case (that one still exists, just requires
        // debugSerpApi=true explicitly since it costs real credits).
        theaterChainMatches: theatersInRange.map((t) => ({
          name: t.name,
          regal: regalResolvedIds[t.name] ?? null,
          amc: null, // AMC discovered separately via amcDirectTheaters, not via OSM names
          cinemark: cinemarkResolvedIds[t.name] ?? null,
          cinemawest: cinemaWestResolvedTheaters[t.name] ? cinemaWestResolvedTheaters[t.name].siteId : null,
          harkins: null, // Harkins discovered separately via harkinsDirectTheaters, not via OSM names
          regency: regencyResolvedTheaters[t.name] ? regencyResolvedTheaters[t.name].site : null,
        })),
        fullSchedulesViaSerpApi: fullSchedules, // null unless debugSerpApi=true was also passed
        // Which theater names in range actually matched
        // lib/cinemark-theater-map.js -- useful for catching OSM-name
        // mismatches like "Century DOCO and XD" vs a guessed
        // "Cinemark Century DOCO and XD" without needing a manual
        // cross-check against the raw theatersInRange list.
        cinemarkTheaterMatches: theatersInRange.map((t) => ({
          name: t.name,
          matchedCinemarkId: CINEMARK_THEATER_MAP[t.name] || null,
        })),
        // perTheaterMatchedEntries only reflects the SerpApi fallback
        // path now (theatersToSearch is empty for all four currently
        // supported chains) -- present but typically empty, kept for
        // whatever future chain might still need the SerpApi fallback.
        perTheaterMatchedEntries: perTheaterResults.map((r) => ({
          theater: r.theater.name,
          error: r.error,
          entries: r.entries,
        })),
      };
    }

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "search failed", detail: err.message });
  }
});

// Powers the movie-title autocomplete on the frontend: discovers nearby
// theaters (same cached Overpass call the main search uses) and pulls
// each one's full day schedule (same SerpApi call/cache the main search
// uses), then returns the deduped list of everything actually playing.
// This is exactly as expensive as one real search -- not free, so the
// frontend only calls it when the person explicitly asks, not on every
// keystroke.
// Location-independent, essentially free (cached 6 hours server-side --
// see lib/mediaStinger.js) pre-population for the movie dropdown, so
// picking a common wide-release movie doesn't require waiting on
// "Load nearby" (which costs a real SerpApi call per nearby theater)
// Thin geocoding endpoint so the frontend can resolve a place/zip to
// lat/lng ONCE before firing /api/search and /api/search-regal in
// parallel. Without this, both backend calls geocode the same place
// simultaneously, racing to Nominatim and triggering 429s on Render's
// shared datacenter IP range even though one call would have been enough.
app.get("/api/geocode", async (req, res) => {
  const { place } = req.query;
  if (!place) return res.status(400).json({ error: "place is required" });
  try {
    const geo = await geocodeForward(place);
    res.json(geo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// first. Doesn't replace /api/movies -- that's still how you'd find
// something playing only at a specific local/independent theater that
// wouldn't show up in a general nationwide "in theaters" listing.
app.get("/api/popular-movies", async (req, res) => {
  try {
    const movies = await getInTheatersList();
    res.json({ movies });
  } catch (err) {
    console.error("Popular-movies lookup failed:", err.message);
    res.status(500).json({ error: err.message, movies: [] });
  }
});

app.get("/api/movies", searchRateLimiter, async (req, res) => {
  const { radiusMin, date } = req.query;
  let { lat, lng, location, place } = req.query;

  if (!radiusMin) {
    return res.status(400).json({ error: "radiusMin is required" });
  }
  if ((!lat || !lng) && !place) {
    return res.status(400).json({
      error: "Provide either lat & lng, or a place (zip code or city name)",
    });
  }

  if ((!lat || !lng) && place) {
    try {
      const geo = await geocodeForward(place);
      lat = geo.lat;
      lng = geo.lng;
      location = location || geo.locationLabel;
    } catch (err) {
      return res.status(400).json({
        error: `Couldn't find a location for "${place}"`,
        detail: err.message,
      });
    }
  }

  if (!location) {
    return res.status(400).json({
      error: "location is required when lat & lng are provided directly without a place",
    });
  }

  const searchDateISO = date || todayISOLocal();
  const originLat = Number(lat);
  const originLng = Number(lng);

  try {
    const radiusMeters = minutesToMeters(Number(radiusMin));
    const nearbyTheaters = await findNearbyTheaters({
      lat: originLat,
      lng: originLng,
      radiusMeters,
    });

    const theatersInRange = nearbyTheaters
      .map((t) => {
        const normalizedName = normalizeTheaterName(t.name);
        const regalEntry = REGAL_CINEMA_MAP[normalizedName];
        const coordOverride = regalCoordsFor(regalEntry);
        const tLat = coordOverride ? coordOverride.lat : t.lat;
        const tLng = coordOverride ? coordOverride.lng : t.lng;
        const displayName = regalDisplayNameFor(regalEntry) || THEATER_DISPLAY_NAMES[normalizedName] || undefined;
        return { ...t, name: normalizedName, lat: tLat, lng: tLng, ...(displayName ? { displayName } : {}), distanceMin: estimatedMinutesAway(originLat, originLng, tLat, tLng) };
      })
      .filter((t) => t.distanceMin <= Number(radiusMin))
      .filter((t) => !EXCLUDED_THEATERS.has(t.name));

    if (theatersInRange.length === 0) {
      return res.json({
        movies: [],
        theatersChecked: 0,
        // Diagnostic fields -- previously this endpoint gave no way to
        // tell WHY zero theaters came back (bad geocode? Overpass empty
        // at this radius? every theater excluded?). Now it's visible
        // directly in the response instead of requiring a guess.
        resolvedLat: originLat,
        resolvedLng: originLng,
        resolvedLocation: location,
        rawTheatersFromOverpass: nearbyTheaters.length,
        excludedByName: nearbyTheaters.filter((t) => EXCLUDED_THEATERS.has(t.name)).map((t) => t.name),
      });
    }

    let resolvedLocation = location;
    try {
      resolvedLocation = await resolveCanonicalLocation(location);
    } catch {
      // Fall through with the raw string, same as the main search route.
    }

    const schedules = await Promise.all(
      theatersInRange.map((theater) =>
        priceLimit(async () => {
          try {
            return await getTheaterSchedule({
              theaterName: theater.displayName || theater.name,
              location: resolvedLocation,
              dateISO: searchDateISO,
            });
          } catch (err) {
            console.error(`Movie list lookup failed for ${theater.name}:`, err.message);
            return [];
          }
        })
      )
    );

    const movies = [
      ...new Set(schedules.flat().map((entry) => entry.movieName).filter(Boolean)),
    ].sort();

    res.json({
      movies,
      theatersChecked: theatersInRange.length,
      resolvedLat: originLat,
      resolvedLng: originLng,
      resolvedLocation,
      theatersInRangeNames: theatersInRange.map((t) => t.name),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "movie list failed", detail: err.message });
  }
});

// "What fits in my time window" mode: instead of searching for one
// specific movie, this scans every movie playing at every theater in
// range and returns showings whose actual runtime (via
// lib/movie-runtime.js) fits entirely between availableFrom and
// availableUntil -- e.g. "I have 3 hours to kill starting now."
//
// KNOWN LIMITATION: doesn't handle a window crossing midnight (e.g.
// availableFrom=22:00, availableUntil=01:00) -- both times are treated as
// minutes-since-midnight on the same calendar day, so a wraparound window
// would need availableUntil > availableFrom or it'll just find nothing.
// Regal-specific, non-blocking companion to /api/search -- lets the
// frontend show fast results (AMC, Harkins, Cinemark, Cinema West,
// Regency) immediately, then merge in Regal's results separately once
// they're ready, instead of the whole response waiting on Regal's
// retry-with-delays logic (up to 3 attempts, 1.5s apart, per showing --
// see regal-scrapedo.js). Self-contained: duplicates the setup
// (geocoding, theater discovery, runtime lookup) rather than sharing
// code with the main handler, to avoid any risk of destabilizing the
// working main endpoint while extracting this.
app.get("/api/search-regal", searchRateLimiter, async (req, res) => {
  const { movie, radiusMin, deadline, formats, date } = req.query;
  let { lat, lng, location, place } = req.query;

  // Same diagnostic as the boot-time log, repeated here so it's visible
  // directly inside a specific search's own log output -- confirms
  // which providers this exact request will actually be able to use,
  // without needing to scroll back to server startup or guess from
  // which error message happens to surface last.
  console.error(`Regal search starting -- active proxy providers: ${configuredProviders().map((p) => p.NAME).join(", ") || "NONE"}`);

  if (!movie || !radiusMin || !deadline) {
    return res.status(400).json({ error: "movie, radiusMin, and deadline are required" });
  }
  if ((!lat || !lng) && !place) {
    return res.status(400).json({ error: "Provide either lat & lng, or a place" });
  }

  if ((!lat || !lng) && place) {
    try {
      const geo = await geocodeForward(place);
      lat = geo.lat;
      lng = geo.lng;
      location = location || geo.locationLabel;
    } catch (err) {
      return res.status(400).json({ error: `Couldn't find a location for "${place}"`, detail: err.message });
    }
  }

  const now = new Date();
  const todayISO = todayISOLocal();
  const searchDateISO = date || todayISO;
  const isToday = searchDateISO === todayISO;
  const wantedFormats = formats ? formats.split(",").map((f) => f.toLowerCase()) : null;
  const deadlineMinutes = toMinutesSinceMidnight(deadline);
  const nowMinutes = isToday ? now.getHours() * 60 + now.getMinutes() : 0;
  const originLat = Number(lat);
  const originLng = Number(lng);

  try {
    const radiusMeters = minutesToMeters(Number(radiusMin));
    const nearbyTheaters = await findNearbyTheaters({ lat: originLat, lng: originLng, radiusMeters });

    const theatersInRange = nearbyTheaters
      .map((t) => {
        const normalizedName = normalizeTheaterName(t.name);
        const regalEntry = REGAL_CINEMA_MAP[normalizedName];
        const coordOverride = regalCoordsFor(regalEntry);
        const tLat = coordOverride ? coordOverride.lat : t.lat;
        const tLng = coordOverride ? coordOverride.lng : t.lng;
        const displayName = regalDisplayNameFor(regalEntry) || THEATER_DISPLAY_NAMES[normalizedName] || undefined;
        return { ...t, name: normalizedName, lat: tLat, lng: tLng, ...(displayName ? { displayName } : {}), distanceMin: estimatedMinutesAway(originLat, originLng, tLat, tLng) };
      })
      .filter((t) => t.distanceMin <= Number(radiusMin))
      .filter((t) => !EXCLUDED_THEATERS.has(t.name));

    const regalResolvedIds = {};
    for (const t of theatersInRange) {
      if (REGAL_CINEMA_MAP[t.name] != null) {
        regalResolvedIds[t.name] = regalCodeFor(REGAL_CINEMA_MAP[t.name]);
      }
    }
    const unmappedRegalInRange = theatersInRange.filter((t) => regalResolvedIds[t.name] == null);
    if (unmappedRegalInRange.some((t) => isRoughlyInCalifornia(t.lat, t.lng))) {
      try {
        const caRegalTheaters = require("./lib/regal-theaters-ca");
        for (const t of unmappedRegalInRange) {
          if (!isRoughlyInCalifornia(t.lat, t.lng)) continue;
          // CONFIRMED REAL BUG, caught from a live report: this is a
          // SECOND, separate copy of the same distance-only matching
          // logic already fixed once elsewhere in this file (the main
          // /api/search handler) -- this copy, used by the dedicated
          // /api/search-regal endpoint, never got the same fix. Real
          // consequence: "Regency Academy Cinemas" (a genuinely
          // different, real theater) got matched to "Regal Paseo"'s
          // real cinema code purely because it was within the 2-mile
          // radius -- showing Regal Paseo's correct real times/prices,
          // but displayed under Regency Academy Cinemas' name. Same
          // fix as the other copy: require the OSM name to actually
          // mention Regal before attempting a distance-only match.
          if (!/\bregal\b|\bedwards\b/i.test(t.name)) {
            console.error(
              `Regal auto-match skipped (search-regal endpoint): OSM theater "${t.name}" doesn't mention Regal ` +
              `in its own name -- not attempting a distance-only match.`
            );
            continue;
          }
          const match = findClosestAmcTheater(t.lat, t.lng, caRegalTheaters, 2);
          if (match) regalResolvedIds[t.name] = match.id;
        }
      } catch (err) {
        console.error("Regal CA theater list unavailable:", err.message);
      }
    }

    const regalPricingDisabled = process.env.DISABLE_REGAL_PRICING === "true";
    if (regalPricingDisabled) {
      console.error("Regal pricing skipped: DISABLE_REGAL_PRICING=true (protecting real credits). Set it to false in start.sh to re-enable.");
      return res.json({ results: [], regalScrapeDoCreditsUsed: 0, regalCreditsByProvider: {} });
    }

    const regalTheaterEntries = theatersInRange.filter((t) => regalResolvedIds[t.name] != null);
    if (regalTheaterEntries.length === 0) {
      return res.json({ results: [], regalScrapeDoCreditsUsed: 0, regalCreditsByProvider: {} });
    }

    // TEMPORARY diagnostic: a real report of two different "Regal
    // [1018]: found..." log lines with different total-performance
    // counts (41, then 1) from a single confirmed single-click search,
    // with only one real 25-credit listing charge -- consistent with a
    // genuine duplicate theater entry (a known real-world Overpass
    // quirk: the same physical location sometimes gets tagged as both a
    // node and a way) causing the same theater to be processed twice
    // concurrently, with the second call hitting the adapter's own
    // listing cache. Logging directly whether that's actually happening
    // rather than guessing further.
    const regalTheaterNames = regalTheaterEntries.map((t) => t.name);
    const duplicateNames = regalTheaterNames.filter((name, i) => regalTheaterNames.indexOf(name) !== i);
    if (duplicateNames.length > 0) {
      console.error(`REGAL DEBUG: duplicate theater entries found in regalTheaterEntries: ${JSON.stringify(duplicateNames)}. Full list: ${JSON.stringify(regalTheaterNames)}`);
    }

    const realRuntimeMin = await getRuntimeMinutes(movie, RUNTIME_MIN, getHarkinsRuntimeForMovie);

    // Self-contained window check -- a Regal-specific equivalent of
    // buildResultIfWithinWindow (which is local to the main handler and
    // not reachable from here). Regal always reports format "Standard",
    // so this is simpler than the general version.
    function regalResultIfWithinWindow({ theaterName, distanceMin, startTimeRaw, price, bookingLink, priceExtras }) {
      const startMin = parseGoogleTime(startTimeRaw);
      if (startMin === null) return null;
      const { high: trailerHigh, low: trailerLow } = getTrailerBufferRange(theaterName);
      const endMin = startMin + realRuntimeMin + trailerHigh;
      if (startMin < nowMinutes) return null;
      if (endMin > deadlineMinutes) return null;
      if (!matchesWantedFormat("Standard", wantedFormats)) return null;

      return {
        theaterName,
        distanceMin,
        chain: "regal",
        format: "Standard",
        startTime: startTimeRaw,
        estimatedEndTime: formatEndTimeRangeStandalone(startTimeRaw, realRuntimeMin, trailerLow, trailerHigh),
        filmActuallyStartsAt: formatEndTimeRangeStandalone(startTimeRaw, 0, trailerLow, trailerHigh),
        runtimeMinutes: realRuntimeMin,
        price: price ?? null,
        bookingLink: bookingLink ?? null,
        priceSource: "regal-direct",
        ...(priceExtras || {}),
      };
    }

    const results = [];
    let regalScrapeDoCallsUsed = 0;
    const regalCreditsByProvider = {};

    await Promise.all(
      regalTheaterEntries.map((theater) =>
        priceLimit(async () => {
          const theaterKey = theater.name;
          const theaterName = theater.displayName || theater.name;
          try {
            const costTracker = { total: 0, byProvider: {} };
            const allPerformances = await getRegalShowtimesForTheater({
              cinemaCode: regalResolvedIds[theaterKey],
              dateISO: searchDateISO,
              costTracker,
            });
            const movieMatches = allPerformances.filter((p) => matchesMovie(p.movieName, movie));
            const inWindow = movieMatches.filter((p) =>
              regalResultIfWithinWindow({ theaterName, distanceMin: theater.distanceMin, startTimeRaw: p.showTime.slice(0, 5) })
            );
            // CONFIRMED REAL GAP, found chasing a live report of a
            // specific showtime (12:10pm) not appearing in results: this
            // line only ever reported COUNTS, never the actual times
            // found -- unlike Harkins' equivalent line a few hundred
            // lines up, which lists every real time seen. That made it
            // impossible to tell "our filter dropped a real showing" apart
            // from "Regal's own listing never had it" without re-deriving
            // the answer by elimination each time. Listing every matched
            // showtime's raw time now closes that gap for good.
            console.error(
              `Regal [${regalResolvedIds[theaterKey]}]: found ${allPerformances.length} total performances, ` +
              `${movieMatches.length} matching "${movie}", ${inWindow.length} within your search window ` +
              `(pricing only these). Movies seen: ${[...new Set(allPerformances.map((p) => p.movieName))].join(", ") || "(none)"}. ` +
              `Real times seen for "${movie}": ${movieMatches.map((p) => p.showTime.slice(0, 5)).join(", ") || "(none)"}`
            );
            const MAX_PERFORMANCES_PER_THEATER = 2;
            const toPrice = inWindow.slice(0, MAX_PERFORMANCES_PER_THEATER);
            if (inWindow.length > MAX_PERFORMANCES_PER_THEATER) {
              console.error(
                `Regal: capping ${theaterName} at ${MAX_PERFORMANCES_PER_THEATER} priced showings (had ${inWindow.length} within the search window) to protect real credits.`
              );
            }

            const priced = await getRegalPricedShowtimes({
              cinemaCode: regalResolvedIds[theaterKey],
              movieTitle: movie,
              dateISO: searchDateISO,
              preDiscoveredPerformances: toPrice,
              costTracker,
            });
            regalScrapeDoCallsUsed += priced.creditsUsed;
            for (const [providerName, credits] of Object.entries(priced.creditsByProvider || {})) {
              regalCreditsByProvider[providerName] = (regalCreditsByProvider[providerName] || 0) + credits;
            }

            for (const p of priced.results) {
              if (p.price == null) continue;
              const estimatedFee = estimateRegalFee("Standard");
              const [y, m, d] = searchDateISO.split("-");
              const regalDateFormatted = `${m}-${d}-${y}`;
              const regalBookingLink = p.movieId
                ? `https://www.regmovies.com/movies/${toUrlSlug(movie)}-${p.movieId.toLowerCase()}?date=${regalDateFormatted}&site=${regalResolvedIds[theaterKey]}&id=${p.performanceId ?? ""}`
                : googleFallbackLink(theaterName, movie);
              const built = regalResultIfWithinWindow({
                theaterName,
                distanceMin: theater.distanceMin,
                startTimeRaw: p.time.slice(0, 5),
                price: Math.round((p.price + estimatedFee) * 100) / 100,
                bookingLink: regalBookingLink,
                priceExtras: {
                  priceBeforeFee: p.price,
                  estimatedFee,
                  feeStatus: "estimated",
                },
              });
              if (built) results.push(built);
            }
          } catch (err) {
            console.error(`Regal pricing failed for ${theaterName}:`, err.message);
          }
        })
      )
    );

    res.json({ results, regalScrapeDoCreditsUsed: regalScrapeDoCallsUsed, regalCreditsByProvider });
  } catch (err) {
    console.error("Regal search failed:", err);
    res.status(500).json({ error: "Regal search failed", detail: err.message });
  }
});

app.get("/api/window-search", searchRateLimiter, async (req, res) => {
  const { radiusMin, date, availableFrom, availableUntil, formats } = req.query;
  let { lat, lng, location, place } = req.query;

  if (!radiusMin || !availableFrom || !availableUntil) {
    return res.status(400).json({
      error: "radiusMin, availableFrom, and availableUntil are required",
    });
  }
  if ((!lat || !lng) && !place) {
    return res.status(400).json({
      error: "Provide either lat & lng, or a place (zip code or city name)",
    });
  }

  const fromMinutes = toMinutesSinceMidnight(availableFrom);
  const untilMinutes = toMinutesSinceMidnight(availableUntil);
  if (untilMinutes <= fromMinutes) {
    return res.status(400).json({
      error: "availableUntil must be after availableFrom (windows crossing midnight aren't supported yet)",
    });
  }

  if ((!lat || !lng) && place) {
    try {
      const geo = await geocodeForward(place);
      lat = geo.lat;
      lng = geo.lng;
      location = location || geo.locationLabel;
    } catch (err) {
      return res.status(400).json({
        error: `Couldn't find a location for "${place}"`,
        detail: err.message,
      });
    }
  }
  if (!location) {
    return res.status(400).json({
      error: "location is required when lat & lng are provided directly without a place",
    });
  }

  const wantedFormats = formats ? formats.split(",").map((f) => f.toLowerCase()) : null;
  const searchDateISO = date || todayISOLocal();
  const originLat = Number(lat);
  const originLng = Number(lng);

  try {
    const radiusMeters = minutesToMeters(Number(radiusMin));
    const nearbyTheaters = await findNearbyTheaters({
      lat: originLat,
      lng: originLng,
      radiusMeters,
    });

    let resolvedLocation = location;
    let locationResolutionError = null;
    try {
      resolvedLocation = await resolveCanonicalLocation(location);
    } catch (err) {
      locationResolutionError = err.message;
      console.error(`Location resolution failed for "${location}":`, err.message);
    }

    const theatersInRange = nearbyTheaters
      .map((t) => {
        const normalizedName = normalizeTheaterName(t.name);
        const regalEntry = REGAL_CINEMA_MAP[normalizedName];
        const coordOverride = regalCoordsFor(regalEntry);
        const tLat = coordOverride ? coordOverride.lat : t.lat;
        const tLng = coordOverride ? coordOverride.lng : t.lng;
        const displayName = regalDisplayNameFor(regalEntry) || THEATER_DISPLAY_NAMES[normalizedName] || undefined;
        return { ...t, name: normalizedName, lat: tLat, lng: tLng, ...(displayName ? { displayName } : {}), distanceMin: estimatedMinutesAway(originLat, originLng, tLat, tLng) };
      })
      .filter((t) => t.distanceMin <= Number(radiusMin))
      .filter((t) => !EXCLUDED_THEATERS.has(t.name));

    if (theatersInRange.length === 0) {
      return res.json({
        searchDate: searchDateISO,
        theatersFound: nearbyTheaters.length,
        theatersInRange: 0,
        results: [],
        note: "No theaters found in OpenStreetMap within that radius.",
      });
    }

    // Full schedule (every movie, not filtered to one title) per theater.
    const perTheaterSchedules = await Promise.all(
      theatersInRange.map((theater) =>
        priceLimit(async () => {
          try {
            const entries = await getTheaterSchedule({
              theaterName: theater.displayName || theater.name,
              location: resolvedLocation,
              dateISO: searchDateISO,
            });
            return { theater, entries, error: null };
          } catch (err) {
            console.error(`SerpApi lookup failed for ${theater.name}:`, err.message);
            return { theater, entries: [], error: err.message };
          }
        })
      )
    );

    // Runtime lookups are cached per title, so this only costs one real
    // lookup per unique movie across the whole search, not per showing.
    //
    // Two-tier source, cheapest/most-reliable first:
    // 1. Cinemark's own theater pages embed real runtime data directly
    //    ("PG-13 2 hr 25 min") -- confirmed live against a real page,
    //    strictly more reliable than SerpApi's Knowledge Graph guessing
    //    since it's the distributor's own data, not a search-result
    //    scan. Only covers movies playing at a Cinemark theater that's
    //    actually in range with a known slug (lib/cinemark-theater-
    //    slugs.js, or the auto-discovered CA list once you've run
    //    scripts/build-cinemark-theater-map.js).
    // 2. lib/movie-runtime.js's SerpApi-based lookup, for anything
    //    Cinemark doesn't cover -- still unverified against a live
    //    response as of this writing, treat it as the weaker fallback.
    const uniqueMovieTitles = [
      ...new Set(
        perTheaterSchedules.flatMap(({ entries }) => entries.map((e) => e.movieName)).filter(Boolean)
      ),
    ];

    // Any Cinemark theater in range with a known slug, to try first.
    let cinemarkSlugForRuntimes = null;
    for (const { theater } of perTheaterSchedules) {
      const slug = CINEMARK_THEATER_SLUGS[theater.name];
      if (slug) {
        cinemarkSlugForRuntimes = slug;
        break;
      }
    }

    const runtimeByTitle = {};
    await Promise.all(
      uniqueMovieTitles.map((title) =>
        priceLimit(async () => {
          if (cinemarkSlugForRuntimes) {
            try {
              const cinemarkRuntime = await getRuntimeForMovieAtTheater(cinemarkSlugForRuntimes, title);
              if (cinemarkRuntime) {
                runtimeByTitle[title] = cinemarkRuntime;
                return;
              }
            } catch (err) {
              console.error(`Cinemark runtime lookup failed for "${title}":`, err.message);
            }
          }
          runtimeByTitle[title] = await getRuntimeMinutes(title, RUNTIME_MIN, getHarkinsRuntimeForMovie);
        })
      )
    );

    const results = [];
    for (const { theater, entries } of perTheaterSchedules) {
      for (const entry of entries) {
        if (!entry.movieName) continue;
        const startMin = parseGoogleTime(entry.time);
        if (startMin === null) continue;
        if (startMin < fromMinutes) continue;

        const runtime = runtimeByTitle[entry.movieName] ?? RUNTIME_MIN;
        // Same conservative principle as the main search endpoint: use
        // the high end of the range (or a real per-theater value, if
        // known) for the actual deadline check, not an average or the
        // low end.
        const { high: trailerHigh } = getTrailerBufferRange(theater.name);
        const endMin = startMin + runtime + trailerHigh;
        if (endMin > untilMinutes) continue;

        if (!matchesWantedFormat(entry.format, wantedFormats)) {
          continue;
        }

        results.push({
          movieName: entry.movieName,
          runtimeMinutes: runtime,
          theaterName: theater.name,
          distanceMin: theater.distanceMin,
          format: entry.format,
          startTime: entry.time,
          price: entry.price,
          bookingLink: entry.link,
        });
      }
    }

    // Soonest-starting first -- the natural order for "what can I catch
    // starting now-ish," with priced-and-cheapest as a tiebreaker within
    // the same start time.
    results.sort((a, b) => {
      const aMin = parseGoogleTime(a.startTime);
      const bMin = parseGoogleTime(b.startTime);
      if (aMin !== bMin) return aMin - bMin;
      if (a.price == null && b.price == null) return 0;
      if (a.price == null) return 1;
      if (b.price == null) return -1;
      return a.price - b.price;
    });

    // Same generous flat cap as the main search endpoint -- format
    // filtering happens client-side against whatever's in this response,
    // so this needs enough real variety across formats for that filter
    // to be useful, not just the single cheapest handful.
    const RESULTS_CAP = 25;
    const totalMatchingShowings = results.length;
    const cappedResults = results.slice(0, RESULTS_CAP);

    res.json({
      searchDate: searchDateISO,
      availableFrom,
      availableUntil,
      locationResolved: resolvedLocation,
      locationResolutionError,
      theatersFound: nearbyTheaters.length,
      theatersInRange: theatersInRange.length,
      matchingShowings: totalMatchingShowings,
      resultsShown: cappedResults.length,
      results: cappedResults,
      note:
        "Pricing here is whatever SerpApi returns directly (often null) -- " +
        "this mode doesn't yet run the Regal/AMC/Cinemark direct-pricing " +
        "enrichment that the single-movie search does, since those are " +
        "keyed to one specific movie/theater at a time.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "window search failed", detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
// CONFIRMED useful diagnostic: the previous report of "Apify/Firecrawl
// never get tried" turned out ambiguous from the search log alone --
// "Last error: scrape.do quota exhausted" is consistent with either
// "Apify/Firecrawl aren't configured" or "they were tried and something
// swallowed their own log output," and there was no way to tell which
// from that log. This settles it directly, once, at boot, instead of
// inferring from an indirect symptom during a search.
const activeProviders = configuredProviders().map((p) => p.NAME);
console.log(
  activeProviders.length > 0
    ? `Proxy providers configured and active: ${activeProviders.join(", ")}`
    : `WARNING: no proxy providers are configured at all -- Regal pricing will fail outright. ` +
      `Check SCRAPEDO_TOKEN, ZENROWS_API_KEY, APIFY_API_TOKEN, FIRECRAWL_API_KEY in start.sh.`
);

app.listen(PORT, () => console.log(`Showtime Finder API on :${PORT}`));
