const fetch = require("node-fetch");
const { matchesMovie } = require("./serpapi");

// Harkins Theatres runs on the same Vista-family platform as Cinema
// West (confirmed: identical "HO########" movie ID convention), but a
// different specific product -- their own Next.js-powered site
// (harkins.com) plus a separate ticketing backend
// (ticketingservice.harkins.com) and a separate CMS/catalog backend
// (cmsservice.harkins.com).
//
// CONFIRMED REAL from live captures:
// 1. cmsservice.harkins.com/api/v1/movies -- a nationwide movie catalog
//    (title, slugUrl, runtime, real HO######## movie ID). No auth
//    needed, no theater-specific data, just movie metadata + slugs.
// 2. harkins.com/_next/data/{buildId}/en/movies/{slugUrl}/{date}.json
//    ?recentTheatre={anyTheaterId}&slugUrl={slugUrl}&date={date} --
//    Next.js's own client-side-navigation data route. Confirmed to
//    return EVERY Harkins theater nationwide showing that movie on that
//    date in one response (recentTheatre doesn't filter results down to
//    just that theater, despite the name) -- schedules[], each with a
//    theatreId and movies.performances[] (sessionId, real local
//    showtimeOffset with correct timezone already embedded, format,
//    soldOut).
//
// The {buildId} portion is NOT stable -- it's a Next.js build
// identifier that changes on every site deploy. Confirmed the site
// embeds its current buildId in its own initial page HTML (standard
// Next.js convention, same __NEXT_DATA__ pattern already used for
// Cinema West's token), so it needs to be extracted live rather than
// hardcoded, or this silently breaks whenever Harkins ships an update.
//
// STILL UNCONFIRMED: real ticket pricing. We have ONE fully confirmed
// real pricing response (RequestOrderTotals: $15.50 base + $2.09 real
// service fee for one specific already-in-progress order), but not the
// exact response shape of the step before it (StartTicketingSession),
// which is what actually creates a fresh order and would be this
// adapter's real pricing entry point. Building discovery now since it's
// fully confirmed and independently valuable; pricing needs one more
// real captured response before it can be built with confidence rather
// than guessed.

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
};

// Real per-format signal, confirmed from live data: "CINÉXL" is
// Harkins' premium large-format screen (their equivalent of AMC's
// premium formats), "3D" is exactly what it says, "Digital" is the
// standard/base format. Using the real `format` field directly rather
// than re-deriving it from the boolean flags (cineXL/atmos/in3D/etc.)
// sitting alongside it in each performance object -- simpler and this
// field is already exactly what we'd compute anyway.

// CONFIRMED REAL pricing endpoint, found via a real captured URL list
// (not the StartTicketingSession endpoint originally guessed at, which
// turned out to be an unconfirmed assumption -- GetTicketTypes is a
// simpler, read-only ticket-price lookup, no order/cart needed at all):
// ticketingservice.harkins.com/api/Theatre/GetTicketTypes/cinemaid/
// {cinemaId}/sessionid/{sessionId}?includeRedemptionTickets=true
//
// Field names follow the same convention already confirmed real from
// RequestOrderTotals on this same backend (PriceInCents, description-
// style fields) -- same API family, same controller pattern
// (ticketingservice.harkins.com/api/{Controller}/{Method}), so this is
// a well-grounded extrapolation, not a blind guess. Extraction logic
// mirrors extractAdultPriceCents() in lib/priceAdapters/regal-scrapedo.js
// (same "prefer explicit Adult wording" pattern), since Harkins' ticket
// type naming looks the same shape as Regal's.
function extractAdultPrice(ticketTypes) {
  const nonDiscounted = (ticketTypes || []).filter((t) => {
    const name = (t.description || t.name || "").toLowerCase();
    return !/child|senior|student|military|kid|junior/.test(name);
  });

  const explicitAdult = nonDiscounted.find((t) =>
    (t.description || t.name || "").toLowerCase().includes("adult")
  );
  const chosen = explicitAdult || nonDiscounted[0];
  if (!chosen) return { price: null, ticketTypeName: null };

  const cents = chosen.priceInCents ?? chosen.PriceInCents ?? null;
  return {
    price: cents != null ? cents / 100 : null,
    ticketTypeName: chosen.description || chosen.name || null,
  };
}

// Real ticket-price lookup for one specific showing. No order/cart
// needed -- this is a plain read-only price query, confirmed simpler
// than the order-creation flow originally assumed.
async function getTicketPricing({ cinemaId, sessionId }) {
  const url = `https://ticketingservice.harkins.com/api/Theatre/GetTicketTypes/cinemaid/${cinemaId}/sessionid/${sessionId}?includeRedemptionTickets=true`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Harkins GetTicketTypes request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();

  // CONFIRMED REAL BUG, found from a real report of Harkins showings
  // appearing but never getting priced: this used to guess the ticket
  // array lived at json.data.ticketTypes (extrapolated from a
  // DIFFERENT endpoint's response shape, GetTheatreShowtime, before a
  // real GetTicketTypes response had actually been captured). Once a
  // real response was captured -- during the separate fee investigation
  // -- the array turned out to live somewhere else entirely, but this
  // extraction path was never revisited at the time since that
  // investigation was only checking for a fee field, not re-verifying
  // the whole structure. Rather than guess a second specific path and
  // risk being wrong again, this now searches the response recursively
  // for whatever array actually contains ticket-shaped objects
  // (identified by having a real priceInCents field) -- works
  // regardless of the exact nesting/key name, and won't silently break
  // again if that ever changes.
  const ticketTypes = findTicketArray(json) || [];
  return extractAdultPrice(ticketTypes);
}

// Recursively searches a parsed JSON object for the first array whose
// entries look like real ticket types (an object with a priceInCents
// field) -- see the real-bug comment above for why this exists instead
// of a fixed field path.
function findTicketArray(node, depth = 0) {
  if (depth > 6 || node == null || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    if (node.length > 0 && typeof node[0] === "object" && node[0] != null && "priceInCents" in node[0]) {
      return node;
    }
    for (const item of node) {
      const found = findTicketArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const value of Object.values(node)) {
    const found = findTicketArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

const BUILD_ID_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // deploys are infrequent, unlike Cinema West's 12hr token
let buildIdCache = null; // { buildId, fetchedAt }

async function getFreshBuildId() {
  if (buildIdCache && Date.now() - buildIdCache.fetchedAt < BUILD_ID_CACHE_TTL_MS) {
    return buildIdCache.buildId;
  }

  const res = await fetch("https://www.harkins.com/movies", { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Harkins build-id page request failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();

  // Next.js's own standard convention: every page embeds a
  // <script id="__NEXT_DATA__" type="application/json"> blob with a
  // top-level "buildId" field. Same extraction pattern already proven
  // for Cinema West's gasToken.
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) {
    throw new Error("Couldn't find __NEXT_DATA__ on the Harkins page -- either the page structure changed, or this hit a bot-detection/challenge page instead of real content.");
  }

  let nextData;
  try {
    nextData = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`__NEXT_DATA__ found but wasn't valid JSON: ${err.message}`);
  }

  const buildId = nextData?.buildId;
  if (!buildId) {
    throw new Error("__NEXT_DATA__ parsed fine but had no top-level buildId field.");
  }

  buildIdCache = { buildId, fetchedAt: Date.now() };
  return buildId;
}

const MOVIE_CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let movieCatalogCache = null; // { movies, fetchedAt }

async function getMovieCatalog() {
  if (movieCatalogCache && Date.now() - movieCatalogCache.fetchedAt < MOVIE_CATALOG_CACHE_TTL_MS) {
    return movieCatalogCache.movies;
  }

  const res = await fetch("https://cmsservice.harkins.com/api/v1/movies", { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Harkins movie catalog request failed: ${res.status} ${res.statusText}`);
  }
  const movies = await res.json();
  movieCatalogCache = { movies, fetchedAt: Date.now() };
  return movies;
}

// Reuses matchesMovie from lib/priceAdapters/serpapi.js -- the same
// normalize-then-bidirectional-substring approach already proven
// throughout this project for exactly this kind of "titles from two
// different sources are worded slightly differently" problem. A naive
// direct substring match without normalization was tested and
// confirmed too fragile for real punctuation differences (e.g.
// "Spider-Man: Brand New Day" vs "spider-man brand new day" didn't
// match without it).
function findSlugForMovie(movies, movieTitle) {
  const found = movies.find((m) => matchesMovie(m.title, movieTitle));
  return found ? found.slugUrl : null;
}

// A free, general-purpose runtime source -- Harkins' movie catalog is
// nationwide, not theater-specific, so this works even when no Harkins
// theater is actually in the user's search range. Confirmed real field:
// runTime, a string of digits (e.g. "147" for Spider-Man: Brand New Day
// at a specific screen, seen in a real GetTheatreShowtime capture; the
// catalog-level field is presumably the same shape). Used as a
// preferred alternative to the SerpApi-based lookup in
// lib/movie-runtime.js, which makes its own real API call per movie and
// silently falls back to a hardcoded default if that call fails (e.g.
// SerpApi's monthly credits running out) -- a real bug this was built
// to fix, caught from a live search reporting The Odyssey's runtime as
// 128 minutes (the fallback constant) instead of its real 172.
async function getRuntimeForMovie(movieTitle) {
  try {
    const movies = await getMovieCatalog();
    const found = movies.find((m) => matchesMovie(m.title, movieTitle));
    if (!found || !found.runTime) return null;
    const minutes = parseInt(found.runTime, 10);
    return Number.isNaN(minutes) ? null : minutes;
  } catch (err) {
    console.error(`Harkins runtime lookup failed for "${movieTitle}":`, err.message);
    return null;
  }
}

// Real discovery call -- confirmed to return every Harkins theater
// nationwide showing this movie on this date, not just one theater,
// despite the recentTheatre parameter's name. anyTheaterId can be any
// real Harkins theater ID (it's required by the URL but doesn't appear
// to actually filter results); a theater we already know about (e.g.
// Cerritos, harkinsid 63) works fine here.
async function getShowtimesForMovie({ movieTitle, dateISO, anyTheaterId = "63" }) {
  const buildId = await getFreshBuildId();
  const movies = await getMovieCatalog();
  const slugUrl = findSlugForMovie(movies, movieTitle);
  if (!slugUrl) {
    return []; // movie not found in Harkins' own catalog -- not an error, just nothing to show
  }

  const url = `https://www.harkins.com/_next/data/${buildId}/en/movies/${slugUrl}/${dateISO}.json?recentTheatre=${anyTheaterId}&slugUrl=${slugUrl}&date=${dateISO}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Harkins showtimes request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  const schedules = data?.pageProps?.schedules || [];
  const performances = [];
  for (const theaterSchedule of schedules) {
    const theatreId = theaterSchedule.theatreId;
    for (const p of theaterSchedule.movies?.performances || []) {
      if (p.soldOut) continue;
      performances.push({
        theatreId,
        sessionId: p.sessionId,
        movieId: p.movieId,
        format: p.format,
        showtimeOffset: p.showtimeOffset,
        // Real confirmed URL: harkins.com/movies/{slugUrl} -- movie-page
        // level, not session-specific (Harkins' real session-deep-link
        // pattern needs a token this data doesn't include), but still a
        // real working link to buy from.
        slugUrl,
      });
    }
  }
  return performances;
}

module.exports = { getFreshBuildId, getMovieCatalog, findSlugForMovie, getShowtimesForMovie, getTicketPricing, extractAdultPrice, getRuntimeForMovie };
