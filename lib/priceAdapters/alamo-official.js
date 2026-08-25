// Alamo Drafthouse Cinema — public v2 schedule API
// Endpoint: https://drafthouse.com/s/mother/v2/schedule/market/{marketSlug}
// No auth required, no pricing available, showtimes only.
// CONFIRMED WORKING: fetched live 2026-08-25.

const fetch = require("node-fetch");

const API_BASE = "https://drafthouse.com/s/mother/v2/schedule/market";
const REQUEST_TIMEOUT_MS = 12000;

// All known Alamo Drafthouse markets and their cinemas.
// Cinema lat/lng pulled directly from the v2 API (confirmed real 2026-08-25).
// Chicago Wrigleyville had bad API coordinates (~39.58 = Colorado); corrected
// to its real address: 3519 N Clark St, Chicago, IL (41.9474, -87.6559).
const ALAMO_CINEMAS = [
  // Austin, TX
  { marketSlug: "austin", cinemaId: "0007", name: "Alamo Drafthouse Lakeline", lat: 30.475499, lng: -97.804188, tz: "America/Chicago" },
  { marketSlug: "austin", cinemaId: "0004", name: "Alamo Drafthouse South Lamar", lat: 30.2561, lng: -97.7635, tz: "America/Chicago" },
  { marketSlug: "austin", cinemaId: "0006", name: "Alamo Drafthouse Slaughter Lane", lat: 30.198783, lng: -97.868787, tz: "America/Chicago" },
  { marketSlug: "austin", cinemaId: "0008", name: "Alamo Drafthouse Mueller", lat: 30.298706, lng: -97.704233, tz: "America/Chicago" },
  { marketSlug: "austin", cinemaId: "0003", name: "Alamo Drafthouse Village", lat: 30.360043, lng: -97.734812, tz: "America/Chicago" },
  // San Antonio, TX
  { marketSlug: "san-antonio", cinemaId: "0202", name: "Alamo Drafthouse Park North", lat: 29.5183, lng: -98.5029, tz: "America/Chicago" },
  { marketSlug: "san-antonio", cinemaId: "0203", name: "Alamo Drafthouse Stone Oak", lat: 29.6537, lng: -98.4471, tz: "America/Chicago" },
  // Denver, CO
  { marketSlug: "denver", cinemaId: "0402", name: "Alamo Drafthouse Sloans Lake", lat: 39.7409, lng: -105.0425, tz: "America/Denver" },
  { marketSlug: "denver", cinemaId: "0403", name: "Alamo Drafthouse Westminster", lat: 39.858574, lng: -105.062007, tz: "America/Denver" },
  { marketSlug: "denver", cinemaId: "0401", name: "Alamo Drafthouse Littleton", lat: 39.5837, lng: -105.0249, tz: "America/Denver" },
  // Chicago, IL
  { marketSlug: "chicago", cinemaId: "1801", name: "Alamo Drafthouse Wrigleyville", lat: 41.9474, lng: -87.6559, tz: "America/Chicago" },
  // Los Angeles, CA
  { marketSlug: "los-angeles", cinemaId: "1701", name: "Alamo Drafthouse DTLA", lat: 34.0482, lng: -118.2588, tz: "America/Los_Angeles" },
  // Omaha, NE
  { marketSlug: "omaha", cinemaId: "1601", name: "Alamo Drafthouse La Vista", lat: 41.1793, lng: -96.1156, tz: "America/Chicago" },
  // New York City, NY
  { marketSlug: "nyc", cinemaId: "2103", name: "Alamo Drafthouse Lower Manhattan", lat: 40.708327, lng: -74.008664, tz: "America/New_York" },
  { marketSlug: "nyc", cinemaId: "2102", name: "Alamo Drafthouse Staten Island", lat: 40.56633, lng: -74.10995, tz: "America/New_York" },
  { marketSlug: "nyc", cinemaId: "2101", name: "Alamo Drafthouse Downtown Brooklyn", lat: 40.6907, lng: -73.9831, tz: "America/New_York" },
  // Raleigh, NC
  { marketSlug: "raleigh", cinemaId: "2201", name: "Alamo Drafthouse Raleigh", lat: 35.7785, lng: -78.605, tz: "America/New_York" },
  // St. Louis, MO
  { marketSlug: "st-louis", cinemaId: "2601", name: "Alamo Drafthouse City Foundry", lat: 38.633935, lng: -90.240263, tz: "America/Chicago" },
  // Boston, MA
  { marketSlug: "boston", cinemaId: "2901", name: "Alamo Drafthouse Seaport", lat: 42.3522, lng: -71.0486, tz: "America/New_York" },
  // Indianapolis, IN
  { marketSlug: "indianapolis", cinemaId: "3101", name: "Alamo Drafthouse Indianapolis", lat: 39.827333, lng: -86.239492, tz: "America/New_York" },
];

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Alamo API ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Map Alamo's format slugs to display strings consistent with the rest of the app.
function alamoDisplayFormat(formatSlug) {
  if (!formatSlug) return "Standard";
  const s = formatSlug.toLowerCase();
  if (s === "70mm") return "70mm";
  if (s === "35mm") return "35mm";
  if (s.includes("imax")) return "IMAX";
  if (s.includes("laser")) return "Laser";
  if (s.includes("4dx")) return "4DX";
  if (s.includes("screenx")) return "ScreenX";
  if (s.includes("3d")) return "3D";
  if (s.includes("dolby")) return "Dolby Cinema";
  if (s === "digital" || s === "standard" || s === "2d") return "Standard";
  // Unknown slug: title-case it so it displays legibly
  return formatSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Discover Alamo cinemas within the given driving-minute radius.
 * Returns an array of cinema objects (subset of ALAMO_CINEMAS) each with distanceMin added.
 */
function getAlamoCinemasInRange({ originLat, originLng, discoveryRadiusMin, estimatedMinutesAway }) {
  const inRange = [];
  for (const cinema of ALAMO_CINEMAS) {
    const dMin = estimatedMinutesAway(originLat, originLng, cinema.lat, cinema.lng);
    if (dMin <= discoveryRadiusMin) {
      inRange.push({ ...cinema, distanceMin: dMin });
    }
  }
  return inRange;
}

/**
 * Fetch the schedule for a single market. Returns { sessions, presentations }
 * from the API response. Throws on network error.
 */
async function fetchMarketSchedule(marketSlug) {
  const data = await fetchWithTimeout(`${API_BASE}/${marketSlug}`);
  return {
    sessions: data.data.sessions || [],
    presentations: data.data.presentations || [],
  };
}

/**
 * For a set of matched cinemas (already filtered by distance), fetch their
 * market schedules and return showtime entries ready for buildResultIfWithinWindow.
 *
 * Returns an array of:
 *   { cinemaId, cinemaName, distanceMin, startTimeRaw, format, bookingLink }
 *
 * Filtering by movieTitle and dateISO happens here.
 */
async function getAlamoShowtimesForCinemas({ cinemas, movieTitle, dateISO }) {
  if (cinemas.length === 0) return [];

  // Group cinemas by market to avoid fetching the same market twice
  const byMarket = new Map();
  for (const c of cinemas) {
    if (!byMarket.has(c.marketSlug)) byMarket.set(c.marketSlug, []);
    byMarket.get(c.marketSlug).push(c);
  }

  const cinemaById = new Map(cinemas.map((c) => [c.cinemaId, c]));

  const allEntries = [];

  await Promise.all(
    [...byMarket.entries()].map(async ([marketSlug, marketCinemas]) => {
      let sessions, presentations;
      try {
        ({ sessions, presentations } = await fetchMarketSchedule(marketSlug));
      } catch (err) {
        console.error(`Alamo [${marketSlug}]: schedule fetch failed:`, err.message);
        return;
      }

      // Build a title lookup: presentationSlug -> show.title
      const titleBySlug = new Map();
      for (const pres of presentations) {
        if (pres.show?.title) titleBySlug.set(pres.slug, pres.show.title);
      }

      // Only sessions that (a) match the date, (b) are for a cinema we matched, and (c) match movie
      const { matchesMovie } = require("./serpapi");
      for (const sess of sessions) {
        if (sess.businessDateClt !== dateISO) continue;
        const cinema = cinemaById.get(sess.cinemaId);
        if (!cinema) continue;
        if (sess.status === "CANCELLED") continue;

        const title = titleBySlug.get(sess.presentationSlug);
        if (!title || !matchesMovie(title, movieTitle)) continue;

        const startTimeRaw = isoToHHMM(sess.showTimeClt);
        if (!startTimeRaw) continue;

        const format = alamoDisplayFormat(sess.formatSlug);
        const bookingLink = `https://drafthouse.com/${marketSlug}/show/${sess.presentationSlug}`;

        allEntries.push({
          cinema,
          sessionId: sess.sessionId,
          startTimeRaw,
          format,
          bookingLink,
        });
      }
    })
  );

  return allEntries;
}

function isoToHHMM(iso) {
  const match = /T(\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * Fetch the ticket price for a specific Alamo session.
 * Uses the seats endpoint which returns a DEFAULT ticket class with a flat per-seat price.
 * CONFIRMED REAL: fetched live 2026-08-25. Austin $7.58, DTLA $9.00.
 * No auth required. One GET per session.
 *
 * Returns { priceInCents } or throws on failure.
 */
async function getAlamoSessionPrice(cinemaId, sessionId) {
  const data = await fetchWithTimeout(
    `https://drafthouse.com/s/mother/v1/app/seats/${cinemaId}/${sessionId}`
  );
  const areas = data.data?.seatingData?.areas || [];
  for (const area of areas) {
    for (const tc of area.ticketClassInfos || []) {
      if (tc.defaultPriceInCents != null && tc.defaultPriceInCents > 0) {
        return { priceInCents: tc.defaultPriceInCents };
      }
    }
  }
  throw new Error(`No price found in seats response for ${cinemaId}/${sessionId}`);
}

module.exports = {
  ALAMO_CINEMAS,
  getAlamoCinemasInRange,
  getAlamoShowtimesForCinemas,
  getAlamoSessionPrice,
};
