const fetch = require("node-fetch");

// Cinemark's TicketSeatMap page embeds real ticket pricing directly in the
// initial HTML as a base64-encoded JSON blob assigned to a JS variable
// (rawBoxProducts), rather than via a separate AJAX/JSON endpoint. So
// instead of hunting for an API call, we fetch the page itself and pull
// that variable out. Confirmed against a real decoded sample (Cinemark
// Century DOCO and XD, Sacramento) with permission from Cinemark support
// for personal/hobbyist use.
//
// UNTESTED LIVE: I can't fetch cinemark.com myself (robots.txt blocks my
// fetch tool, and this sandbox's network egress doesn't include it
// either), so the actual HTTP request below hasn't been run against a
// live page yet. The parsing logic has been verified against real
// decoded data you provided.

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// CONFIRMED from a real live request you captured.
const BASE_UMBRACO_API_URL = "https://www.cinemark.com/umbraco/surface/";

// Confirmed from Cinemark's own showtimes.js source: this endpoint returns
// an HTML FRAGMENT (not JSON) that gets injected directly into the page
// ($(resultsDiv).html(data)). That HTML contains showtime buttons whose
// links point at /TicketSeatMap/?TheaterId=...&ShowtimeId=...&
// CinemarkMovieId=...&Showtime=... -- exactly the IDs the pricing fetcher
// needs. Rather than parse the full HTML/DOM structure, regex out each
// link along with its sibling data-print-type-name attribute, which
// (confirmed from a real response) gives the exact format string
// ("XD Luxury Lounger RealD 3D", "Standard Format", etc.) right there --
// no separate format-matching pass needed.
//
// IMPORTANT: the real HTML uses &amp; (HTML-entity-encoded), not raw &, in
// these hrefs -- confirmed from a real response. Must decode before
// splitting into URLSearchParams or theaterId/showtimeId parsing breaks.
function buildShowtimesByMovieUrl({ cinemarkMovieId, dateISO, theaterIdsCsv }) {
  const params = new URLSearchParams({
    cinemarkMovieId,
    showDate: dateISO,
    theaterIds: theaterIdsCsv,
    expandSearch: "false",
    currentTheaterId: theaterIdsCsv.split(",")[0] || "",
  });
  return `${BASE_UMBRACO_API_URL}Showtimes/GetByMovieId?${params.toString()}`;
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractTicketSeatMapLinks(html) {
  // Matches the confirmed real attribute order: aria-label, class,
  // data-link-category, data-link-name, data-print-type-name, href.
  const pattern = /data-print-type-name="([^"]*)"[^>]*href="(\/TicketSeatMap\/\?[^"]+)"/g;
  const results = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const [, format, rawHref] = match;
    const href = decodeHtmlEntities(rawHref);
    const params = new URLSearchParams(href.split("?")[1]);
    results.push({
      theaterId: params.get("TheaterId"),
      showtimeId: params.get("ShowtimeId"),
      cinemarkMovieId: params.get("CinemarkMovieId"),
      showtimeISO: params.get("Showtime"),
      format: decodeHtmlEntities(format),
    });
  }
  return results;
}

// Given a movie and one or more theater IDs, returns every real showtime
// (with the exact IDs needed to fetch pricing via getTicketPricing above).
async function getShowtimesForMovie({ cinemarkMovieId, dateISO, theaterIdsCsv }) {
  const url = buildShowtimesByMovieUrl({ cinemarkMovieId, dateISO, theaterIdsCsv });
  const res = await fetch(url, { headers: HEADERS });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (isChallengePage(text) || res.status === 429) {
      throw new Error(`Cinemark rate-limited the showtimes request (${res.status}) -- Cloudflare challenge page.`);
    }
    throw new Error(
      `Cinemark showtimes request failed: ${res.status} ${res.statusText}${
        text ? ` -- ${text.slice(0, 200)}` : ""
      }`
    );
  }

  const html = await res.text();
  const links = extractTicketSeatMapLinks(html);
  if (!links.length) {
    // Zero links is ambiguous and used to be silent: the film may genuinely
    // not play at these theaters that day, the page may be a bot-check, or
    // the markup this scrapes may have changed. Fingerprint it so the three
    // are distinguishable from the log alone rather than by guesswork.
    const looksBlocked = /captcha|are you a human|access denied|incapsula|unusual traffic|challenge-platform|cf-browser-verification/i.test(html);
    const hasSeatMapHref = html.includes("/TicketSeatMap/");
    console.error(
      `Cinemark: 0 TicketSeatMap links for movie ${cinemarkMovieId} on ${dateISO} at theater(s) ${theaterIdsCsv} -- ` +
      `${html.length} chars, ${looksBlocked ? "looks like a bot-check/challenge page" : "no challenge markers"}, ` +
      `${hasSeatMapHref ? "page DOES contain /TicketSeatMap/ so the extraction pattern is stale" : "no /TicketSeatMap/ anywhere -- the film likely isn't listed at these theaters"}. ` +
      `First 300: ${html.slice(0, 300).replace(/\s+/g, " ")}`
    );
  }
  return links;
}

function buildTicketSeatMapUrl({ theaterId, showtimeId, cinemarkMovieId, showtimeISO }) {
  const params = new URLSearchParams({
    TheaterId: theaterId,
    ShowtimeId: showtimeId,
    CinemarkMovieId: cinemarkMovieId,
    Showtime: showtimeISO, // e.g. "2026-08-16T09:00:00"
  });
  return `https://www.cinemark.com/TicketSeatMap/?${params.toString()}`;
}

// Pulls `var {varName} = '....';` out of raw page HTML/JS and returns the
// base64 payload inside the quotes.
//
// indexOf rather than a regex, for robustness on very large pages.
//
// Historical note, since this rewrite looks like a bug fix and isn't: it was
// made while chasing a "Maximum call stack size exceeded" on every Cinemark
// pricing call, on a theory that the old
// /var\s+{varName}\s*=\s*'([^']+)'/ was backtracking over a huge page. That
// theory was wrong -- tested directly, the old regex returns null cleanly
// against a 1MB unterminated payload instead of throwing. The real cause was
// an accidentally self-recursive addResult() in server.js, unrelated to this
// file. Kept because scanning for delimiters is simpler and has no
// pathological input, but it fixed nothing.
function extractRawVar(html, varName) {
  const declIdx = html.indexOf(varName);
  if (declIdx === -1) return null;

  // Anchor on the assignment rather than on "var " + one space, so extra
  // whitespace or a different declaration keyword doesn't break the match.
  const eqIdx = html.indexOf("=", declIdx);
  if (eqIdx === -1) return null;

  const openIdx = html.indexOf("'", eqIdx);
  if (openIdx === -1) return null;

  const closeIdx = html.indexOf("'", openIdx + 1);
  if (closeIdx === -1) return null;

  const value = html.slice(openIdx + 1, closeIdx);
  return value.length > 0 ? value : null;
}

function decodeRawVar(base64Value) {
  const decoded = Buffer.from(base64Value, "base64").toString("utf8");
  return JSON.parse(decoded);
}

// Ticket type naming varies by showtime slot (Matinee, Evening, Twilight,
// etc.) rather than always literally saying "Adult" -- confirmed with a
// real matinee showing that only had "XD Matinee" / "XD Child" /
// "XD Senior", no "Adult" at all. So: exclude anything explicitly
// discounted (child/senior/student/military), prefer a literal "adult"
// match if present, otherwise take whatever's left as the standard price.
//
// Each decoded product object has a separate `ticketFee` field alongside
// `basePrice` (confirmed real from the very first rawBoxProducts decode
// early in this project -- e.g. basePrice: 17.75, ticketFee: 1.99 -- but
// an earlier version of this function only returned basePrice, silently
// dropping the fee the whole time). Since ticketFee comes from the same
// per-showing decoded data as basePrice, this is a real confirmed value
// every time, not an estimate the way AMC's/Regal's fee figures are.
function extractStandardPrice(products) {
  const nonDiscounted = products.filter((p) => {
    const name = (p.ticketTypeName || p.name || "").toLowerCase();
    return !/child|senior|student|military|kid|junior/.test(name);
  });

  function toResult(p) {
    const basePrice = p.basePrice;
    const fee = p.ticketFee ?? 0;
    return {
      price: basePrice != null ? Math.round((basePrice + fee) * 100) / 100 : null,
      priceBeforeFee: basePrice ?? null,
      fee,
      ticketTypeName: p.ticketTypeName,
    };
  }

  const explicitAdult = nonDiscounted.find((p) =>
    (p.ticketTypeName || p.name || "").toLowerCase().includes("adult")
  );
  if (explicitAdult) {
    return toResult(explicitAdult);
  }

  const fallback = nonDiscounted[0];
  return fallback
    ? toResult(fallback)
    : { price: null, priceBeforeFee: null, fee: null, ticketTypeName: null };
}

// ---- Pacing --------------------------------------------------------------
//
// TicketSeatMap pages are Cloudflare-fronted and rate-limited per IP. The main
// search prices showtimes concurrently under chainLimit (pLimit(8)), which is
// fine in a thin market and a burst in a dense one: a live LA search covering
// SEVEN Cinemark theaters came back 429 with a "Just a moment..." interstitial
// on four showtimes. Same problem Regal's POST serialization solves, so the
// same answer -- one at a time with a gap, tunable if the threshold moves.
//
// Deliberately inside the adapter rather than at the call site: the IMAX 70mm
// panel prices through here too, and would otherwise need its own copy.
const PRICING_GAP_MS = Number(process.env.CINEMARK_PRICING_GAP_MS) || 300;
const CHALLENGE_RETRY_MS = Number(process.env.CINEMARK_CHALLENGE_RETRY_MS) || 3000;
let pricingQueueTail = Promise.resolve();
let lastPricingAt = 0;

// A challenge page is a rate-limit verdict, not a broken showtime. Detected so
// the error can say so in a few words -- these used to dump ~400 characters of
// Cloudflare HTML per failure, twice, and four of them doubled the log.
function isChallengePage(text) {
  return /Just a moment\.\.\.|cf-browser-verification|challenge-platform|cf_chl_|__cf_bm/i.test(text || "");
}

function pacedFetch(url) {
  const run = pricingQueueTail.then(async () => {
    const wait = PRICING_GAP_MS - (Date.now() - lastPricingAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastPricingAt = Date.now();
    return fetch(url, { headers: HEADERS });
  });
  // Swallowed so one failure can't poison the queue for everything behind it.
  pricingQueueTail = run.then(() => {}, () => {});
  return run;
}

async function getTicketPricing({ theaterId, showtimeId, cinemarkMovieId, showtimeISO }) {
  const url = buildTicketSeatMapUrl({ theaterId, showtimeId, cinemarkMovieId, showtimeISO });

  let res = await pacedFetch(url);

  // One retry, and only for a rate-limit/challenge: that is the failure the
  // pacing is meant to avoid, and it clears on its own. Anything else is a
  // real error and retrying it just spends another request.
  if (res.status === 429 || res.status === 503) {
    await new Promise((r) => setTimeout(r, CHALLENGE_RETRY_MS));
    res = await pacedFetch(url);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (isChallengePage(text) || res.status === 429) {
      throw new Error(
        `Cinemark rate-limited this request (${res.status}) -- Cloudflare challenge page, not a pricing failure. ` +
        `Raise CINEMARK_PRICING_GAP_MS (currently ${PRICING_GAP_MS}ms) if this persists.`
      );
    }
    throw new Error(
      `Cinemark TicketSeatMap request failed: ${res.status} ${res.statusText}${
        text ? ` -- ${text.slice(0, 200)}` : ""
      }`
    );
  }

  const html = await res.text();
  if (isChallengePage(html)) {
    // A 200 that is really a challenge -- rawBoxProducts would be missing and
    // the old message blamed the page structure for a rate limit.
    throw new Error(
      `Cinemark returned a Cloudflare challenge page (HTTP 200) instead of the seat map -- rate limited, not a parsing problem.`
    );
  }
  const rawBoxProducts = extractRawVar(html, "rawBoxProducts");

  if (!rawBoxProducts) {
    throw new Error(
      "Couldn't find rawBoxProducts in the page -- either the page structure changed, or this hit a bot-detection/challenge page instead of real content."
    );
  }

  const products = decodeRawVar(rawBoxProducts);
  return extractStandardPrice(products);
}

module.exports = {
  getTicketPricing,
  getShowtimesForMovie,
  buildTicketSeatMapUrl,
  buildShowtimesByMovieUrl,
  extractRawVar,
  decodeRawVar,
  extractStandardPrice,
  extractTicketSeatMapLinks,
};
