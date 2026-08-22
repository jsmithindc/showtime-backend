// Fetches the full Regal theater list from regmovies.com/api/theatres and
// caches it for the process lifetime. regmovies.com is Cloudflare-protected
// so this goes through the proxy rotation (same path as regal-scrapedo.js).
//
// Each entry returned: { code, name, lat, lng }
//   code -- TheatreCode (4-digit string, zero-padded); used everywhere in
//           the Regal backend (getTicketsForSession, createOrder, etc.)
//
// Confirmed from a real /api/theatres response: 403 theaters nationwide,
// including all the known codes already in regal-cinema-map.js (e.g.
// "0665" = Corona Crossings, "1916" = Eastvale Gateway).

const { fetchWithRotation } = require("./proxyProviders");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // daily -- theater list changes rarely
let cache = null; // { theaters, fetchedAt }

async function getRegalTheaters() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.theaters;
  }

  const { res } = await fetchWithRotation("https://www.regmovies.com/api/theatres", { method: "GET" });
  if (!res.ok) {
    throw new Error(`Regal theater list request failed: ${res.status} ${res.statusText}`);
  }
  const raw = await res.json();

  const theaters = raw
    .filter((t) => t.TheatreCode && t.Latitude && t.Longitude)
    .map((t) => ({
      code: String(t.TheatreCode).padStart(4, "0"),
      name: t.TheatreMarketingName || t.Name,
      lat: parseFloat(t.Latitude),
      lng: parseFloat(t.Longitude),
    }));

  cache = { theaters, fetchedAt: Date.now() };
  return theaters;
}

module.exports = { getRegalTheaters };
