// Landmark Theatres — Webedia Movies / gatsby-source-boxofficeapi platform
// No auth required for schedule/movies API (www.landmarktheatres.com).
// Booking.landmarktheatres.com is Cloudflare-protected — pricing skipped.
// Flow:
//   1. GET /api/gatsby-source-boxofficeapi/schedule?from={date}T03:00:00
//        &theaters={"id":"{code}","timeZone":"{tz}"}&to={nextDay}T03:00:00
//      → keyed by theaterCode → filmId → date → [{startsAt, tags, data.ticketing}]
//   2. Collect all filmIds from schedule; batch-GET /api/gatsby-source-boxofficeapi/movies?ids=...
//      → [{id, title, runtime}]
//   3. Match filmId by title; booking URL from data.ticketing[0].urls[0] (pre-generated, no basket needed)
//   4. Format from tags: look for tag beginning with "Format." (e.g. "Format.Projection.Digital")
// CONFIRMED LIVE 2026-08-25: theaterCode X00Y7 (Los_Angeles tz), "The Wrong Girls", 14:00/16:40/19:25.

const fetch = require("node-fetch");

const SCHEDULE_BASE = "https://www.landmarktheatres.com/api/gatsby-source-boxofficeapi";
const REQUEST_TIMEOUT_MS = 12000;

// Static theater list — codes + locations required for distance-based discovery.
// TO POPULATE: open DevTools on landmarktheatres.com/find-a-theatre → Network tab →
// look for a call to /api/gatsby-source-boxofficeapi/... that returns a list of theaters.
// Each entry needs: { code, name, lat, lng, tz }
// tz must be a valid IANA timezone name (e.g. "America/Los_Angeles").
//
// Codes confirmed from 2026-08-25 network captures:
//   X00Y7 = an LA-area theater (timezone America/Los_Angeles) — identity unverified
//
// Add entries as theater codes are confirmed. Distance matching requires chain name
// ("landmark") to appear in the OSM theater name to avoid false-positive matches.
const LANDMARK_THEATERS = [
  // { code: "X00Y7", name: "Landmark ??? Theatre", lat: ???, lng: ???, tz: "America/Los_Angeles" },
  // Add more entries here as theater codes are confirmed.
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
 * Requires "landmark" (case-insensitive) in the OSM theater name to avoid false positives.
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
        if (!title || !matchesMovie(title, movieTitle)) continue;

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

module.exports = {
  LANDMARK_THEATERS,
  getLandmarkTheatersInRange,
  getLandmarkShowtimesForTheaters,
};
