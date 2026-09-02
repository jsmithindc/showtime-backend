// Landmark Theatres — Webedia Movies / gatsby-source-boxofficeapi platform
// No auth required for schedule/movies API (www.landmarktheatres.com).
// Pricing via booking.landmarktheatres.com/api/launch/ticketing/{uuid} (Cloudflare-protected;
// gated behind DISABLE_LANDMARK_PRICING !== "false").
// Flow:
//   1. GET /api/gatsby-source-boxofficeapi/schedule?from={date}T03:00:00
//        &theaters={"id":"{code}","timeZone":"{tz}"}&to={nextDay}T03:00:00
//      → keyed by theaterCode → filmId → date → [{startsAt, tags, data.ticketing}]
//   2. Collect all filmIds from schedule; batch-GET /api/gatsby-source-boxofficeapi/movies?ids=...
//      → [{id, title, runtime}]
//   3. Match filmId by title; booking URL from data.ticketing[0].urls[0] (pre-generated, no basket needed)
//   4. Format from tags: look for tag beginning with "Format." (e.g. "Format.Projection.Digital")
//   5. Pricing: UUID is the last path segment of bookingLink.
//      GET https://booking.landmarktheatres.com/api/launch/ticketing/{uuid}
//      → selectTicketsModel.groupedTicketTypes[].ticketTypeModels[]: {price (cents), bookingFee (cents)}
//      One call per theater (uses first valid showtime's UUID; price applies to all showtimes at that theater).
// CONFIRMED LIVE 2026-08-25: theaterCode X00Y7 (Los_Angeles tz), "The Wrong Girls", 14:00/16:40/19:25.
// CONFIRMED LIVE 2026-08-25 (pricing): api/launch/ticketing/{uuid} returns price:700 + bookingFee:149 for X00TM.

const fetch = require("node-fetch");

const SCHEDULE_BASE = "https://www.landmarktheatres.com/api/gatsby-source-boxofficeapi";
const BOOKING_BASE = "https://booking.landmarktheatres.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

// booking.landmarktheatres.com/robots.txt is `User-agent: * / Disallow: /`.
// Pricing runs here anyway because Landmark's own developer support confirmed
// personal/hobbyist use is acceptable -- the same footing as Cinemark. That
// permission is why this bypasses the proxy chain: Bright Data enforces
// robots.txt irrespective of it and answers HTTP 200 with a
// "Residential Failed (bad_endpoint)" body, which for several rounds looked
// like a parse bug rather than a refusal. Showtimes come from
// www.landmarktheatres.com, whose robots.txt is empty and unrestricted.
const REQUEST_TIMEOUT_MS = 12000;

// All 26 Landmark Theatres locations.
// Codes extracted from /our-locations/ page slugs (e.g. "x00y7-landmark-piedmont-theatre-oakland" → X00Y7).
// Confirmed: X00Y7 = Piedmont Oakland, X00U8 = Opera Plaza SF, X03C1 = Scottsdale Quarter.
// lat/lng from street addresses (2026-08-25); tz = IANA timezone.
const LANDMARK_THEATERS = [
  // Arizona
  { code: "X03C1", name: "Landmark Scottsdale Quarter Theatre",      lat: 33.6195,  lng: -111.9178, tz: "America/Phoenix"              },
  // California
  { code: "X00TM", name: "Landmark Aquarius Theatre",                lat: 37.4476,  lng: -122.1621, tz: "America/Los_Angeles"          },
  { code: "X00QV", name: "Landmark Del Mar Theatre",                 lat: 36.9743,  lng: -122.0281, tz: "America/Los_Angeles"          },
  { code: "X00CW", name: "Landmark Nuart Theatre",                   lat: 34.0484,  lng: -118.4411, tz: "America/Los_Angeles"          },
  { code: "X00U8", name: "Landmark Opera Plaza Cinema",              lat: 37.7810,  lng: -122.4207, tz: "America/Los_Angeles"          },
  { code: "X00Y7", name: "Landmark Piedmont Theatre",                lat: 37.8258,  lng: -122.2394, tz: "America/Los_Angeles"          },
  { code: "G01SI", name: "Landmark Theatres Sunset",                 lat: 34.0982,  lng: -118.3656, tz: "America/Los_Angeles"          },
  { code: "G01CH", name: "Landmark Theatres Pasadena",               lat: 34.1477,  lng: -118.1358, tz: "America/Los_Angeles"          },
  { code: "X00D9", name: "Landmark Westwood",                        lat: 34.0608,  lng: -118.4437, tz: "America/Los_Angeles"          },
  // Colorado
  { code: "X02AK", name: "Landmark Mayan Theatre",                   lat: 39.7309,  lng: -104.9876, tz: "America/Denver"               },
  { code: "X0873", name: "The Landmark Greenwood Village",           lat: 39.6136,  lng: -104.8961, tz: "America/Denver"               },
  // DC
  { code: "X0WLT", name: "Landmark Atlantic Plumbing Cinema",        lat: 38.9178,  lng: -77.0205,  tz: "America/New_York"             },
  // Florida
  { code: "X0XDF", name: "The Landmark at Merrick Park",             lat: 25.7063,  lng: -80.2777,  tz: "America/New_York"             },
  // Georgia
  { code: "X00QM", name: "Landmark Midtown Art Cinema",              lat: 33.7769,  lng: -84.3726,  tz: "America/New_York"             },
  // Illinois
  { code: "X0JYT", name: "Landmark at The Glen",                     lat: 42.0737,  lng: -87.7998,  tz: "America/Chicago"              },
  { code: "X05IO", name: "Landmark Century Centre Cinema",           lat: 41.9341,  lng: -87.6493,  tz: "America/Chicago"              },
  // Indiana
  { code: "X0KAO", name: "Landmark Glendale 12",                     lat: 39.8892,  lng: -86.1027,  tz: "America/Indiana/Indianapolis" },
  { code: "X07M6", name: "Landmark Keystone Art Cinema",             lat: 39.9152,  lng: -86.1348,  tz: "America/Indiana/Indianapolis" },
  // Maryland
  { code: "G019L", name: "Landmark at Annapolis Harbour Center",     lat: 38.9591,  lng: -76.5441,  tz: "America/New_York"             },
  { code: "X06C1", name: "Landmark Bethesda Row Cinema",             lat: 38.9822,  lng: -77.0968,  tz: "America/New_York"             },
  // Massachusetts
  { code: "X019B", name: "Landmark Kendall Square Cinema",           lat: 42.3629,  lng: -71.0898,  tz: "America/New_York"             },
  // Minnesota
  { code: "X01QW", name: "Landmark Lagoon Cinema",                   lat: 44.9480,  lng: -93.2955,  tz: "America/Chicago"              },
  // New Jersey
  { code: "G01AA", name: "Landmark Closter Plaza",                   lat: 40.9739,  lng: -73.9617,  tz: "America/New_York"             },
  // Pennsylvania
  { code: "X081D", name: "Landmark Ritz Five",                       lat: 39.9497,  lng: -75.1432,  tz: "America/New_York"             },
  // Texas
  { code: "X02KC", name: "Landmark Inwood Theatre",                  lat: 32.8667,  lng: -96.8260,  tz: "America/Chicago"              },
  // Washington
  { code: "X00MT", name: "Landmark Crest Cinema Center",             lat: 47.7482,  lng: -122.3249, tz: "America/Los_Angeles"          },
];

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`Landmark API ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Derive the next calendar date in ISO format (YYYY-MM-DD).
function nextDateISO(dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const next = new Date(y, m - 1, d + 1);
  const ny = next.getFullYear();
  const nm = String(next.getMonth() + 1).padStart(2, "0");
  const nd = String(next.getDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

// Map a Format.* tag to a display string consistent with the rest of the app.
// Only the Format.* namespace signals projection type; accessibility/screen tags are ignored.
// Confirmed tag from live data: "Format.Projection.Digital" → Standard.
// Premium format tags (IMAX, Dolby, etc.) are inferred from likely Webedia naming conventions.
function landmarkDisplayFormat(tags) {
  if (!Array.isArray(tags)) return "Standard";
  for (const tag of tags) {
    if (!tag.startsWith("Format.")) continue;
    const key = tag.toLowerCase();
    if (key.includes("imax")) return "IMAX";
    if (key.includes("dolby")) return "Dolby Cinema";
    if (key.includes("70mm")) return "70mm";
    if (key.includes("35mm")) return "35mm";
    if (key.includes("4dx")) return "4DX";
    if (key.includes("screenx")) return "ScreenX";
    if (key.includes("laser")) return "Laser";
    if (key.includes("3d")) return "3D";
    if (key.includes("digital") || key.includes("standard")) return "Standard";
    // Unknown Format.* tag: title-case the last segment
    const parts = tag.split(".");
    return parts[parts.length - 1].replace(/([A-Z])/g, " $1").trim();
  }
  return "Standard";
}

/**
 * Discover Landmark theaters within the given driving-minute radius.
 * Pure static-list distance match — no OSM name filtering needed.
 * Returns subset of LANDMARK_THEATERS with distanceMin added.
 */
function getLandmarkTheatersInRange({ originLat, originLng, discoveryRadiusMin, estimatedMinutesAway }) {
  const inRange = [];
  for (const theater of LANDMARK_THEATERS) {
    const dMin = estimatedMinutesAway(originLat, originLng, theater.lat, theater.lng);
    if (dMin <= discoveryRadiusMin) {
      inRange.push({ ...theater, distanceMin: dMin });
    }
  }
  return inRange;
}

/**
 * For a set of matched theaters, fetch their schedules and return showtime entries
 * ready for buildResultIfWithinWindow.
 *
 * The schedule endpoint uses local theater time for from/to params. A "movie day"
 * runs from 03:00 to 03:00 the next day, covering all practical start times.
 */
async function getLandmarkShowtimesForTheaters({ theaters, movieTitle, dateISO }) {
  if (theaters.length === 0) return [];

  const nextDay = nextDateISO(dateISO);
  const from = `${dateISO}T03:00:00`;
  const to = `${nextDay}T03:00:00`;

  const { matchesMovie } = require("./serpapi");

  const allEntries = [];

  await Promise.all(
    theaters.map(async (theater) => {
      const theatersParam = encodeURIComponent(JSON.stringify({ id: theater.code, timeZone: theater.tz }));
      const scheduleUrl = `${SCHEDULE_BASE}/schedule?from=${encodeURIComponent(from)}&theaters=${theatersParam}&to=${encodeURIComponent(to)}`;

      let scheduleData;
      try {
        scheduleData = await fetchWithTimeout(scheduleUrl);
      } catch (err) {
        console.error(`Landmark [${theater.code}]: schedule fetch failed:`, err.message);
        return;
      }

      const theaterSchedule = scheduleData[theater.code];
      if (!theaterSchedule || !theaterSchedule.schedule) return;

      const filmIds = Object.keys(theaterSchedule.schedule);
      if (filmIds.length === 0) return;

      // Batch-fetch movie titles
      const movieIdsQuery = filmIds.map((id) => `ids=${id}`).join("&");
      let moviesData;
      try {
        moviesData = await fetchWithTimeout(
          `${SCHEDULE_BASE}/movies?basic=false&castingLimit=0&${movieIdsQuery}`
        );
      } catch (err) {
        console.error(`Landmark [${theater.code}]: movies fetch failed:`, err.message);
        return;
      }

      // moviesData is an array of { id, title, runtime, ... }
      const movies = Array.isArray(moviesData) ? moviesData : [];
      const titleById = new Map(movies.map((m) => [String(m.id), m.title]));

      for (const filmId of filmIds) {
        const title = titleById.get(filmId);
        // Falsy movieTitle means "everything at this theater" -- see the note
        // in marcus-official.js.
        if (!title) continue;
        if (movieTitle && !matchesMovie(title, movieTitle)) continue;

        const dateShowings = theaterSchedule.schedule[filmId][dateISO];
        if (!Array.isArray(dateShowings)) continue;

        for (const showing of dateShowings) {
          if (showing.isExpired) continue;

          // startsAt is local theater time (no timezone suffix)
          const match = /T(\d{2}):(\d{2})/.exec(showing.startsAt || "");
          if (!match) continue;
          const startTimeRaw = `${match[1]}:${match[2]}`;

          // Booking link: first "default" provider URL
          const ticketing = showing.data?.ticketing || [];
          const defaultEntry = ticketing.find((t) => t.provider === "default") || ticketing[0];
          const bookingLink = defaultEntry?.urls?.[0] || null;

          const format = landmarkDisplayFormat(showing.tags);

          allEntries.push({
            movieName: title,   // see marcus-official.js
            cinema: theater,
            startTimeRaw,
            format,
            bookingLink,
          });
        }
      }
    })
  );

  return allEntries;
}

/**
 * Fetch ticket pricing for one showtime from the Cloudflare-protected booking API.
 * bookingUUID is the last path segment of the bookingLink URL.
 *
 * Returns {priceDollars, bookingFeeDollars} or null on failure.
 *
 * This call initializes a basket session (side effect: ephemeral session with TTL).
 * No seats are reserved; the session expires automatically if left incomplete.
 *
 * The price returned is for standard (non-loyalty, non-redemption) tickets.
 * Prices are per-session from the proxy chain (no auth) → guest/non-loyalty rates.
 */
/**
 * Fetch ticket pricing for one showtime from the Cloudflare-protected booking API.
 * bookingUUID is the last path segment of the bookingLink URL.
 *
 * Returns an array of ticket types sorted cheapest-first:
 *   [{displayName, priceDollars, bookingFeeDollars, totalDollars}]
 * or null on failure.
 *
 * This call initializes a basket session (side effect: ephemeral session with TTL).
 * No seats are reserved; the session expires automatically if left incomplete.
 *
 * Guest (unauthenticated) calls return standard ticket types (Adult, Child, Senior, etc.).
 * Loyalty-tier and member-only tickets require authentication and won't appear here.
 */
// Generous, but it now genuinely aborts: the request carries an AbortSignal
// rather than losing a Promise.race while the real fetch runs on. The earlier
// proxy-chain version could not cancel and so could spend a provider credit on
// a response nobody read; going direct removed both problems. Measured, a real
// call answers in ~0.5-3s.
const PRICING_TIMEOUT_MS = 25000;

async function getLandmarkPricing(bookingUUID) {
  const url = `${BOOKING_BASE}/api/launch/ticketing/${bookingUUID}`;
  let res;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICING_TIMEOUT_MS);
  try {
    // POST, not GET. This is the whole reason pricing never worked: the host
    // is a Vite SPA whose server answers EVERY GET with the app shell, so a GET
    // here returned 723 bytes of HTML and the parser reported "not valid JSON".
    // The same path as a POST returns ~217KB of real booking JSON.
    //
    // Direct, not through the proxy chain. Verified reachable in ~450ms with no
    // Cloudflare challenge, so a proxy bought nothing -- and Bright Data
    // actively refuses this host (see the note above BOOKING_BASE).
    res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: `${BOOKING_BASE}/launch/ticketing/${bookingUUID}`,
      },
      body: "{}",
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`Landmark pricing: fetch failed for ${bookingUUID}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }

  let data;
  let rawText = "";
  try {
    rawText = await res.text();
    try {
      data = JSON.parse(rawText);
    } catch {
      // Some proxy providers wrap JSON in <pre> tags when rendered via browser.
      const preMatch = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(rawText);
      if (preMatch) {
        data = JSON.parse(preMatch[1]);
      } else {
        throw new Error("response is not valid JSON and contains no <pre> block");
      }
    }
  } catch (err) {
    // Say WHAT came back, not just that parsing failed. "not valid JSON" is
    // true of a Cloudflare interstitial, a login redirect, an empty body and a
    // provider error page alike, and they need completely different fixes --
    // the bare message sent the last round of debugging at the wrong layer.
    const shape = !rawText
      ? "EMPTY body"
      : /^\s*</.test(rawText)
        ? (/just a moment|challenge-platform|cf-browser-verification/i.test(rawText)
            ? "Cloudflare interstitial"
            : "HTML page")
        : "non-JSON text";
    console.error(
      `Landmark pricing: parse failed for ${bookingUUID} (${res.status ?? "?"}, ${shape}, ` +
      `${rawText.length} bytes): ${err.message}\n` +
      `  first 300 chars: ${JSON.stringify(rawText.slice(0, 300))}`
    );
    return null;
  }

  const ticketTypes = (data?.selectTicketsModel?.groupedTicketTypes ?? [])
    .flatMap((g) => g.ticketTypeModels ?? []);

  // Exclude loyalty-tier, redemption, and card-promo tickets; they require authentication
  // and won't be available in a guest pricing call.
  const standard = ticketTypes.filter(
    (t) => !t.isMemberTicket && !t.isRedemptionTicket && !t.isLoyaltyCreditTicket && !t.isCardPaymentPromotionTicket && t.price > 0
  );

  if (standard.length === 0) return null;

  // The response lists each ticket type once per seating area, so a single
  // showing comes back as e.g. Bargain/Senior/Child twice over. Without this
  // the card shows every alternate price twice.
  const seen = new Set();
  const deduped = standard.filter((t) => {
    const k = `${t.displayName}|${t.price}|${t.bookingFee ?? 0}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  deduped.sort((a, b) => a.price - b.price);
  return deduped.map((t) => ({
    displayName: t.displayName,
    priceDollars: t.price / 100,
    bookingFeeDollars: (t.bookingFee ?? 0) / 100,
    totalDollars: Math.round((t.price + (t.bookingFee ?? 0)) * 100) / 10000,
  }));
}

module.exports = { LANDMARK_THEATERS, getLandmarkTheatersInRange, getLandmarkShowtimesForTheaters, getLandmarkPricing };
