// Fetches the full Harkins theater list from ticketingservice.harkins.com
// and caches it for the process lifetime (Harkins has ~32 theaters total,
// across AZ, CA, CO, and OK -- the list changes rarely).
//
// Each entry returned: { harkinsId, cinemaId, name, lat, lng }
//   harkinsId -- "hopk" field from the API; used in the Next.js data route's
//                recentTheatre param and to match schedules[].theatreId
//   cinemaId  -- "id" field (zero-padded 10-digit string); used in
//                GetTicketTypes/cinemaid/{cinemaId}/sessionid/{sessionId}
//
// Confirmed from a real GetTheatres response: Cerritos 16 is hopk="63",
// id="0000000010", matching the existing harkins-theater-map.js entry exactly.

const fetch = require("node-fetch");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  "Accept": "application/json",
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // daily -- theater list changes rarely
let cache = null; // { theaters, fetchedAt }

async function getHarkinsTheaters() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.theaters;
  }

  const res = await fetch("https://ticketingservice.harkins.com/api/Theatre/GetTheatres", { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Harkins GetTheatres failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const raw = json.data?.value || [];

  const theaters = raw
    .filter((t) => t.hopk && t.id && t.latitude && t.longitude)
    .map((t) => ({
      harkinsId: String(t.hopk),
      cinemaId: t.id,
      name: t.name,
      lat: parseFloat(t.latitude),
      lng: parseFloat(t.longitude),
    }));

  cache = { theaters, fetchedAt: Date.now() };
  return theaters;
}

module.exports = { getHarkinsTheaters };
