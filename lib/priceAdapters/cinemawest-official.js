const fetch = require("node-fetch");

// Cinema West (web.cinemawest.com) runs on Vista's platform, same family
// as Regal -- confirmed directly from a real captured request: the auth
// token's JWT payload has vista_organisation_code, service_framework_
// circuit_id: "Cinemas West", and is issued by auth.moviexchange.com
// (Vista's own auth provider). Different specific product than Regal's
// regmovies.com flow (this uses a REST-ish "OCAPI" pattern instead), but
// same underlying platform family.
//
// CONFIRMED REAL from a live capture (Country Club Cinema, theater code
// 2101): GET https://digital-api.cinemawest.com/ocapi/v1/showtimes/
// {theaterCode}-{showtimeId}/ticket-prices returns real ticket prices
// AND a real, separate, uniform bookingFee ($2.00 across every single
// ticket type in the real response -- confirmed, not an estimate).
//
// STATUS: pricing extraction AND showtime discovery are both confirmed
// real and built (see getTicketPricing / getShowtimesForSite below).
// ONE piece still missing: how the Bearer access token gets issued --
// the captured token expires in exactly 12 hours (confirmed by decoding
// its JWT payload) and looks anonymous/session-based (no real login),
// which suggests the website requests a fresh one automatically on page
// load. Without seeing that request, this can't refresh its own token
// once the captured one expires -- for now it needs a manually-captured
// token supplied via env var, refreshed by hand periodically.

const BASE_URL = "https://digital-api.cinemawest.com/ocapi/v1";

const HEADERS = {
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  "Origin": "https://web.cinemawest.com",
  "Referer": "https://web.cinemawest.com/",
};

// The "Giant Screen with Dolby Atmos" attribute is the real premium-
// format signal -- confirmed from a real response: screens named
// "#5 GS + Dolby Atmos" / "#6 GS + Dolby Atmos" carry attribute id
// "0000000015" ("Giant Screen with Dolby Atmos") on their showtimes,
// while plain "Auditorium 7/10/13" screens don't. Other attribute IDs
// seen (2D, Audio Description, Assistive Listening, Closed Captioning,
// King Size Electric Recliners) are amenities, not format, so they're
// deliberately not used for this.
const PREMIUM_FORMAT_ATTRIBUTE_ID = "0000000015";
const PREMIUM_FORMAT_NAME = "Giant Screen with Dolby Atmos";

// Discovers every showing at a site for "the next business date" --
// confirmed real endpoint: GET /showtimes/by-business-date/first?
// siteIds={siteId}. UNCONFIRMED: whether there's a way to request a
// SPECIFIC business date rather than always "the next one" -- only
// "first" has been seen captured live. If your search date doesn't
// match whatever this returns, that's why; flag it if this becomes a
// real problem and we can look for a dated variant.
// Gets a fresh access token automatically, no manual capture needed.
// CONFIRMED REAL from a live page source captured directly (not through
// a tool that strips <script> tag contents, which is why an earlier
// attempt at this came back looking empty): the token isn't issued via
// any separate API call at all -- Cinema West's site is server-side-
// rendered (Next.js, confirmed via "gssp": true in the page data), and
// it bakes a fresh token directly into the initial HTML on every page
// load, inside a <script id="__NEXT_DATA__" type="application/json">
// block, at props.pageProps.environment.gasToken. So getting a live
// token is just: fetch the theater page HTML, pull that field out.
// UNCONFIRMED: whether Cloudflare requires cookie-based clearance for a
// bare fetch of this specific page (an earlier fetch attempt of this
// exact URL came back nearly content-free, but that was very likely
// this app's own content-extraction tool stripping <script> tags, not
// an actual Cloudflare block -- a plain node-fetch like this one
// doesn't have that problem, but hasn't been proven against a live
// Cloudflare challenge either way). Your first live run is the real test.
async function getFreshToken(sitePath) {
  const url = `https://web.cinemawest.com/sites/${sitePath}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Cinema West token page request failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) {
    throw new Error(
      "Couldn't find __NEXT_DATA__ in the page -- either the page structure changed, or this hit a bot-detection/challenge page instead of real content."
    );
  }

  let nextData;
  try {
    nextData = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`__NEXT_DATA__ found but wasn't valid JSON: ${err.message}`);
  }

  const token = nextData?.props?.pageProps?.environment?.gasToken;
  if (!token) {
    throw new Error("__NEXT_DATA__ parsed fine but had no environment.gasToken field.");
  }
  return token;
}

async function getShowtimesForSite({ siteId, bearerToken }) {
  if (!bearerToken) {
    throw new Error(
      "No Cinema West bearer token available -- see the top-of-file comment about the missing token-refresh piece."
    );
  }

  const url = `${BASE_URL}/showtimes/by-business-date/first?siteIds=${siteId}`;
  const res = await fetch(url, {
    headers: { ...HEADERS, Authorization: `Bearer ${bearerToken}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Cinema West showtimes-discovery request failed: ${res.status} ${res.statusText}${
        text ? ` -- ${text.slice(0, 300)}` : ""
      }`
    );
  }

  const data = await res.json();
  const filmsById = {};
  for (const f of data.relatedData?.films || []) {
    filmsById[f.id] = f;
  }
  const screensById = {};
  for (const s of data.relatedData?.screens || []) {
    screensById[s.id] = s;
  }

  return (data.showtimes || []).map((s) => {
    const [theaterCode, showtimeId] = s.id.split("-");
    const film = filmsById[s.filmId];
    const screen = screensById[s.screenId];
    const isPremium = (s.attributeIds || []).includes(PREMIUM_FORMAT_ATTRIBUTE_ID);
    return {
      theaterCode,
      showtimeId,
      movieName: film?.title?.text || null,
      runtimeMinutes: film?.runtimeInMinutes || null,
      format: isPremium ? PREMIUM_FORMAT_NAME : "Standard",
      screenName: screen?.name?.text || null,
      // filmStartsAt (not startsAt/schedule start, which includes
      // pre-show/trailer time) is when the actual movie begins --
      // confirmed real: startsAt 22:20, filmStartsAt 22:30 in one
      // captured showing, a 10-minute pre-show gap.
      filmStartsAtISO: s.schedule?.filmStartsAt || null,
      isSoldOut: s.isSoldOut,
    };
  });
}

// Ticket type descriptions come from a separate relatedData.ticketTypes
// array (keyed by ticketTypeId), not embedded directly on each price
// entry -- confirmed from the real response shape. "General" is the
// standard/adult-equivalent ticket; excluding anything senior/child/
// member-restricted, same pattern as the other chain adapters in this
// project.
function extractStandardPrice(data) {
  const ticketTypesById = {};
  for (const tt of data.relatedData?.ticketTypes || []) {
    ticketTypesById[tt.id] = tt;
  }

  const eligible = (data.ticketPrices || []).filter((p) => {
    if (!p.isDefault) return false;
    if ((p.restrictions || []).length > 0) return false; // member/reward-only tickets
    const desc = (ticketTypesById[p.ticketTypeId]?.description?.text || "").toLowerCase();
    if (/senior|child|student|military|kid|junior/.test(desc)) return false;
    if (p.price?.valueIncludingTax === 0) return false; // free/comp ticket types, not real pricing
    return true;
  });

  // "General" (or whatever's lowest displayPriority among eligible
  // options) is the standard ticket -- confirmed real: displayPriority 1
  // in the actual captured response was literally the "General" $18 ticket.
  eligible.sort((a, b) => (a.displayPriority ?? 999) - (b.displayPriority ?? 999));
  const best = eligible[0];
  if (!best) return { price: null, priceBeforeFee: null, fee: null, ticketTypeName: null };

  const priceBeforeFee = best.price.valueIncludingTax;
  const fee = best.bookingFee?.amountIncludingTax ?? 0;
  return {
    price: Math.round((priceBeforeFee + fee) * 100) / 100,
    priceBeforeFee,
    fee,
    ticketTypeName: ticketTypesById[best.ticketTypeId]?.description?.text || null,
  };
}

// theaterCode-showtimeId identifies one specific performance (confirmed
// real: "2101-30572" for a showing at Country Club Cinema, theater code
// 2101). Needs a real, currently-valid Bearer token -- see the missing-
// pieces note at the top of this file for why that's not self-sustaining
// yet.
async function getTicketPricing({ theaterCode, showtimeId, bearerToken }) {
  if (!bearerToken) {
    throw new Error(
      "No Cinema West bearer token available -- this adapter needs a live token-issuing " +
      "request captured to refresh its own tokens; see the top-of-file comment."
    );
  }

  const url = `${BASE_URL}/showtimes/${theaterCode}-${showtimeId}/ticket-prices`;
  const res = await fetch(url, {
    headers: { ...HEADERS, Authorization: `Bearer ${bearerToken}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Cinema West ticket-prices request failed: ${res.status} ${res.statusText}${
        text ? ` -- ${text.slice(0, 300)}` : ""
      }`
    );
  }

  const data = await res.json();
  return extractStandardPrice(data);
}

// Real tokens are valid for 12 hours (confirmed by decoding one), but
// cache for a conservative 1 hour so a change on Cinema West's end
// doesn't leave this working with a stale token for half a day before
// anyone notices.
const TOKEN_CACHE_TTL_MS = 60 * 60 * 1000;
const tokenCache = new Map(); // slug -> { token, fetchedAt }

async function getFreshTokenCached(sitePath) {
  const cached = tokenCache.get(sitePath);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }
  const token = await getFreshToken(sitePath);
  tokenCache.set(sitePath, { token, fetchedAt: Date.now() });
  return token;
}

module.exports = { getTicketPricing, extractStandardPrice, getShowtimesForSite, getFreshToken, getFreshTokenCached };
