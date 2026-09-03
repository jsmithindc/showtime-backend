// Apple Cinemas -- Cinema360 ("C360OnlineSWeb") platform.
//
// Runs with the operator's permission for personal use, on the same footing as
// Cinemark and Landmark. Routed through Camofox because the API is
// Cloudflare-fronted and 403s from any datacenter IP -- see
// lib/proxyProviders/camofox-applecinemas.js.
//
// Two confirmed endpoints, both plain GETs:
//
//   GET /Kiosk/GetLocationonlineMoviesOptimized/{companyId}/{movieId}/{from}/{to}
//     -> screens[].showTimes[] with showID, priceCardId, screenName and
//        screenInfo. screenInfo carries "IMAX 70MM" OUTRIGHT, which is better
//        provenance than Atom (a Firecrawl credit per venue per day) or
//        Harkins (only ever says "IMAX").
//
//   GET /PriceCard/GetKioskPriceCards/{locationId}/{priceCardId}
//     -> the ticket price and the fee structure. Parameter order matters and is
//        counter-intuitive: LOCATION first, then price card. priceCard/location
//        404s, while show/priceCard and company/priceCard both return 200 with
//        an EMPTY tickets array -- a wrong-but-plausible answer that cost a
//        round of guessing.
//
// KNOWN GAP: no location-scoped "what is playing here" endpoint has been found.
// GetAllCompanyMoviesOptimized, GetLocationMoviesOptimized and
// GetAllCompanyLocationMoviesOptimized all answer 200 with an empty array, and
// GetMoviesByLocationId/GetNowShowingMovies 400 asking for an endDateTime that
// then 404s. So a movieId has to come from somewhere else -- the same situation
// as Cinemark, which keeps lib/cinemark-movie-map.js for exactly this.

const camofox = require("../proxyProviders/camofox-applecinemas");
const fetch = require("node-fetch");

const BASE = "https://www.applecinemas.com";
const COMPANY_ID = "f604d90";
const REQUEST_TIMEOUT_MS = 20000;

/** Camofox when configured; a direct fetch otherwise (which Cloudflare will
 *  almost certainly refuse, but failing loudly beats failing silently). */
async function siteFetch(url) {
  if (camofox.isConfigured() && camofox.supports(url)) return camofox.fetchViaProvider(url, {});
  return fetch(url, { timeout: REQUEST_TIMEOUT_MS, headers: { Accept: "application/json" } });
}

function isSeventyMm(screenInfo) {
  return (screenInfo || []).some((s) => /70\s*MM/i.test(String(s)));
}

/**
 * Showtimes for one movie at one location.
 *
 * showTime looks like "2026-09-03T18:00:00+00:00" but the +00:00 is a LIE --
 * 18:00 is local Providence time. Taking the offset at face value shifts every
 * showing by four hours, so the clock part is read directly, the way Harkins'
 * showtimeOffset has to be.
 */
async function getShowtimes({ locationId, movieId, dateISO }) {
  const from = `${dateISO}T00:00:00.000Z`;
  const to = `${dateISO}T23:59:59.999Z`;
  const url = `${BASE}/Kiosk/GetLocationonlineMoviesOptimized/${COMPANY_ID}/${movieId}/${from}/${to}`;

  const res = await siteFetch(url);
  if (!res.ok) throw new Error(`Apple Cinemas showtimes request failed: ${res.status} ${res.statusText}`);
  const body = await res.json();

  const out = [];
  for (const entry of Array.isArray(body) ? body : []) {
    if (locationId && entry.locationId !== locationId) continue;
    for (const screen of entry.screens || []) {
      for (const st of screen.showTimes || []) {
        const screenInfo = st.screenInfo || screen.screenInfo || entry.screenInfo || [];
        out.push({
          showId: st.showID,
          priceCardId: st.priceCardId || entry.priceCardId || null,
          locationId: entry.locationId,
          locationName: entry.locationName,
          movieName: entry.movieDisplayName || entry.movieName,
          screenName: st.screenName,
          screenInfo,
          imax70mm: isSeventyMm(screenInfo),
          time: String(st.showTime || "").slice(11, 16),
          showTimeRaw: st.showTime,
          soldOut: st.disabled === true,
          runtime: entry.runtime || null,
        });
      }
    }
  }
  return out;
}

/**
 * The adult price for a showing, fees included.
 *
 * Two additionalCharges are returned and they behave differently:
 *   includeTicket: true  -- per TICKET  (Convenience Fee, $1.00, all channels)
 *   includeTicket: false -- per ORDER   (Service Fee, $1.75, Web only)
 * Both are counted, because every other chain in this app reports what a single
 * ticket actually costs at checkout, and dropping the order fee would make
 * Apple Cinemas look cheaper than it is -- the exact cross-chain distortion the
 * Harkins fee note warns about. `priceBeforeFee` keeps the bare figure.
 */
async function getTicketPricing({ locationId, priceCardId, salesChannel = "Web" }) {
  const url = `${BASE}/PriceCard/GetKioskPriceCards/${locationId}/${priceCardId}`;
  const res = await siteFetch(url);
  if (!res.ok) throw new Error(`Apple Cinemas price card request failed: ${res.status} ${res.statusText}`);
  const card = await res.json();

  const tickets = card.tickets || [];
  if (!tickets.length) {
    throw new Error(
      `Apple Cinemas price card "${card.priceCardName || priceCardId}" returned no tickets -- ` +
      `check the parameter order, it is {locationId}/{priceCardId}`
    );
  }

  // Cheapest general ticket. These cards are usually one row ("70 MM IMAX
  // Special Event"), but pick deliberately rather than assuming tickets[0].
  const adult = tickets
    .filter((t) => typeof t.price === "number" && !/child|senior|student|military/i.test(t.displayName || ""))
    .sort((a, b) => a.price - b.price)[0] || tickets[0];

  const applies = (c) => !c.salesChannel || !c.salesChannel.length
    || c.salesChannel.some((s) => s.salesChannelName === salesChannel);
  const fee = (card.additionalCharges || [])
    .filter(applies)
    .reduce((sum, c) => sum + (Number(c.additionalPrice) || 0), 0);

  return {
    price: Math.round((adult.price + fee) * 100) / 100,
    priceBeforeFee: adult.price,
    fee: Math.round(fee * 100) / 100,
    ticketTypeName: adult.displayName || null,
    priceCardName: card.priceCardName || null,
  };
}

module.exports = { getShowtimes, getTicketPricing, isSeventyMm, BASE, COMPANY_ID };
