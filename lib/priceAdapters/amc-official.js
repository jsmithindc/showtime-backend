const fetch = require("node-fetch");
const { matchesMovie } = require("./serpapi");

const AMC_VENDOR_KEY = process.env.AMC_VENDOR_KEY;
const AMC_BASE = "https://api.amctheatres.com/v2";

// AMC's official developer API. Catalog access (Showtime/Theatre/Movie
// APIs) is open without special approval -- just an application form at
// developers.amctheatres.com/GettingStarted/NewVendorRequest, no waiting
// on a business-partnership decision the way Regal's would have been.
// Crucially: the showtimes response already includes real per-ticket-type
// pricing (adult/child/senior) directly -- no session/cart dance needed
// like Regal's Scrape.do flow. One request per theater per day.
function authHeaders() {
  if (!AMC_VENDOR_KEY) {
    throw new Error("AMC_VENDOR_KEY environment variable is not set");
  }
  return {
    "X-AMC-Vendor-Key": AMC_VENDOR_KEY,
    "Accept": "application/json",
    "User-Agent": "ShowtimeFinder/0.1 (personal project)",
  };
}

function toMDYYYY(dateISO) {
  const [y, m, d] = dateISO.split("-");
  return `${Number(m)}-${Number(d)}-${y}`;
}

// One-time helper for finding a theatre's numeric AMC id -- not used in
// the regular search flow, but exposed so you (or I) can look up an ID
// without guessing. AMC's theatre list has ~630 entries; one request with
// a large page-size pulls them all, then filter client-side by name.
async function findTheatreIdByName(query) {
  const url = `${AMC_BASE}/theatres?page-size=1000`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `AMC theatres list failed: ${res.status} ${res.statusText}${
        text ? ` -- ${text.slice(0, 300)}` : ""
      }`
    );
  }
  const json = await res.json();
  const theatres = json._embedded?.theatres || [];
  const q = query.toLowerCase();
  return theatres
    .filter((t) => (t.name || "").toLowerCase().includes(q) || (t.slug || "").includes(q))
    .map((t) => ({ id: t.id, name: t.name, slug: t.slug }));
}

// Diagnostic-only: tests a single, known-real theatre ID (610, referenced
// directly in AMC's own docs as "AMC Town Center 20") so a failure here
// tells us whether the problem is with auth/the key generally, versus
// something specific to the bulk theatres-list endpoint.
async function testKnownTheatre() {
  const url = `${AMC_BASE}/theatres/610`;
  const res = await fetch(url, { headers: authHeaders() });
  const text = await res.text().catch(() => "");
  return { status: res.status, statusText: res.statusText, body: text.slice(0, 500) };
}

// Derive a human-readable format from AMC's `attributes` array on each
// showtime -- values seen in AMC's own docs include things like
// "RealD 3D", "IMAX", "Dolby Cinema". Falls back to "Standard" if no
// premium-format attribute is present.
function deriveFormat(attributes) {
  const names = (attributes || []).map((a) => a.name || "");
  const premiumMatch = names.find((n) =>
    /imax|dolby|4dx|rpx|d-box|screenx|prime/i.test(n)
  );
  return premiumMatch || "Standard";
}

// AMC's convenience fee is confirmed absent from this API entirely (see
// comment further below) -- estimated here from real observed data, same
// two-tier pattern as Regal's estimateRegalFee() in server.js: $2.69 for
// Standard/3D, $2.99 for premium formats (confirmed directly: ScreenX,
// IMAX, Prime; Dolby/4DX/RPX/D-BOX are grouped into the same "premium"
// bucket by deriveFormat() above but not individually confirmed at
// $2.99 -- reasonable extrapolation, not verified for those specific
// ones). Note deriveFormat() never actually returns "3D" as its own
// value (it's not in that function's premium-matching pattern), so a 3D
// showing already falls through to "Standard" -- no extra case needed
// here for that to work out correctly.
function estimateAmcFee(format) {
  const f = (format || "Standard").toLowerCase().trim();
  return f === "standard" ? 2.69 : 2.99;
}

// CONFIRMED REAL GAP: a real showing (The Odyssey, 11:45am IMAX at AMC
// Norwalk 20) that genuinely exists and is bookable on AMC's own site
// never showed up in this app's results. This function had no
// pagination-following at all -- just one request with page-size=200
// and whatever came back. AMC Norwalk 20 has 20 screens; across every
// movie and showing in a day, a busy multi-screen theater can easily
// exceed 200 total entries, silently truncating whatever the API
// ordered after that cutoff. Fixed by following AMC's page metadata
// (standard Spring HATEOAS/HAL convention, consistent with the
// _embedded wrapper this API already uses) and fetching every page,
// not just the first.
//
// UNCONFIRMED: the exact field names below (page.totalPages,
// page.number) are inferred from the standard HAL pagination
// convention, not verified against a real response that actually had
// more than one page -- every real response captured so far during
// this project happened to fit in one page. Falls back gracefully
// (just uses page 1's results, same as before) if the `page` object
// isn't shaped as expected, so this can't make things worse even if
// the field names turn out to be wrong -- but if this theater's
// missing-showing issue persists after this fix, that's the first
// thing to check with a real captured response.
async function getShowtimesForTheater({ theatreId, dateISO }) {
  const dateMDY = toMDYYYY(dateISO);
  const baseUrl = `${AMC_BASE}/theatres/${theatreId}/showtimes/${dateMDY}?page-size=200`;

  let allShowtimes = [];
  let pageNum = 0;
  let totalPages = 1;

  while (pageNum < totalPages) {
    const url = pageNum === 0 ? baseUrl : `${baseUrl}&page-number=${pageNum + 1}`;
    const res = await fetch(url, { headers: authHeaders() });

    if (!res.ok) {
      throw new Error(`AMC showtimes request failed: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    const pageShowtimes = json._embedded?.showtimes || [];
    allShowtimes = allShowtimes.concat(pageShowtimes);

    if (json.page && typeof json.page.totalPages === "number") {
      totalPages = json.page.totalPages;
    } else if (pageNum === 0) {
      // No page metadata at all -- can't tell if there's more, so stop
      // here rather than guess. Same behavior as before this fix.
      break;
    }
    pageNum++;
  }

  if (totalPages > 1) {
    console.error(`AMC [${theatreId}]: fetched ${totalPages} pages, ${allShowtimes.length} total showtimes (this theater's schedule didn't fit in one page).`);
  }

  return allShowtimes.map((s) => {
    // CONFIRMED, not just unavailable: real ticketPrices data for a
    // Tuesday showing at AMC Norwalk 20 was checked directly and only
    // ever contains ADULT/CHILD/SENIOR -- no separate discount entry.
    // AMC's own official terms explain why: "50% off Tickets on
    // Tuesdays & Wednesdays... will be shown in Order Details" -- this
    // is an AMC Stubs membership benefit applied at checkout, tied to
    // the logged-in member's account, not a property of the showtime or
    // ticket itself. It genuinely can't be reflected here regardless of
    // which field we read -- there's no unauthenticated way to know
    // it's coming. Documented as a known, confirmed limitation, not an
    // open bug to keep chasing.
    const adultTicket = (s.ticketPrices || []).find((t) => t.type === "ADULT");
    // AMC's own documented example responses show ticketPrices entries
    // have a separate `tax` field alongside `price` -- e.g.
    // { "price": 7.50, "type": "ADULT", "tax": 0.60 }. An earlier
    // version of this adapter only read `.price`, silently dropping tax
    // entirely -- fixed below. CONFIRMED via a real side-by-side check
    // (AMC's own site listed "$15.49" as the ticket price, separately
    // from a $2.69 convenience fee, for a showing where this API's raw
    // `.price` also returned $15.49): the convenience fee is genuinely
    // absent from this API response entirely, not folded into `.price`.
    // So `price` below (base + tax) is still missing that fee -- real
    // total is noticeably higher than what this returns.
    const basePrice = adultTicket?.price ?? null;
    const tax = adultTicket?.tax ?? 0;
    const format = deriveFormat(s.attributes);
    // Now tiered by format -- see estimateAmcFee() above for the real
    // data (Standard/3D $2.69, ScreenX/IMAX/Prime $2.99) this is based on.
    const estimatedFee = basePrice != null ? estimateAmcFee(format) : null;
    const priceBeforeFee = basePrice != null ? Math.round((basePrice + tax) * 100) / 100 : null;
    return {
      movieName: s.movieName,
      time: s.showDateTimeLocal?.split("T")[1], // "HH:MM:SS"
      format,
      price: priceBeforeFee != null ? Math.round((priceBeforeFee + estimatedFee) * 100) / 100 : null,
      priceBeforeTax: basePrice,
      priceBeforeFee,
      // Real, confirmed real link straight from AMC's own official API
      // -- confirmed present and consistent across every real showing
      // checked. Was completely unused before, falling back to a Google
      // search guess instead, despite AMC handing us the exact real
      // link the whole time.
      purchaseUrl: s.purchaseUrl,
      tax,
      estimatedFee,
      // CONFIRMED (not a guess) via a direct real-world comparison: AMC's
      // own site listed "$15.49" as the ticket price for a real showing,
      // separately from a $2.69 convenience fee -- and this API's raw
      // `.price` field for that exact same showing also returned $15.49.
      // That match proves the fee is genuinely absent from this API
      // response entirely, not folded into `.price` some other way. The
      // fee itself is now added back in above, but as an ESTIMATE (tiered
      // by format, see estimateAmcFee()) -- not a live-fetched value.
      feeStatus: basePrice != null ? "estimated" : null, // matches Regal's labeling convention -- base fee-exclusion confirmed real, but the added amount is an estimate
    };
  });
}

// Same shape/purpose as the Regal adapter's getPricedShowtimes: filter to
// the target movie AND to the specific candidate times already surfaced
// by the main search, so we're not fetching more than needed. Unlike
// Regal, pricing comes back in the same request as the listing -- no
// per-performance follow-up calls, so this is cheap regardless.
async function getPricedShowtimes({ theatreId, movieTitle, dateISO, candidateMinutes }) {
  const all = await getShowtimesForTheater({ theatreId, dateISO });
  const movieMatches = all.filter((s) => matchesMovie(s.movieName, movieTitle));

  const matching = candidateMinutes
    ? movieMatches.filter((s) => {
        if (!s.time) return false;
        const [h, m] = s.time.split(":").map(Number);
        const sMin = h * 60 + m;
        return candidateMinutes.some((c) => Math.abs(sMin - c) <= 3);
      })
    : movieMatches;

  console.error(
    `AMC [${theatreId}]: found ${all.length} total showtimes, ${movieMatches.length} matching "${movieTitle}", ` +
      `${matching.length} within your search window. Movies seen: ${[...new Set(all.map((s) => s.movieName))].join(", ") || "(none)"}`
  );

  return matching;
}

module.exports = { getPricedShowtimes, getShowtimesForTheater, findTheatreIdByName, testKnownTheatre };
