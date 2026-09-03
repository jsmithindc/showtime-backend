const { matchesMovie } = require("./serpapi");
const { fetchWithRotation } = require("../proxyProviders");
const { readCache, writeCache } = require("../disk-cache");

// In-process memory cache for listing results: cinemaCode+dateISO → performances[].
// Avoids re-fetching when multiple movies at the same theater are searched
// in the same request, or when the same search is retried.
const listingMemCache = new Map();

// Exact endpoint pattern documented at:
// https://scrape.do/blog/regmovies-com-scraping/
// Regal's real backend, reached through a rotating set of proxy
// providers (see lib/proxyProviders/) so Cloudflare and the US-only
// geo-restriction are handled server-side instead of us fighting them
// with a local Playwright session. Originally built against Scrape.do
// only (hence the filename); now routes through whichever configured
// provider (Scrape.do, ZenRows, ...) is next in line, falling over
// automatically if one's quota is exhausted.

// The listing endpoint, when fetched with rendering enabled (needed
// since it's behind Cloudflare's JS challenge), came back from Scrape.do
// wrapped in a rendered HTML page with the raw JSON sitting inside a
// <pre> tag -- unwrap it rather than trying to JSON.parse the whole HTML
// document. UNCONFIRMED whether other providers (e.g. ZenRows) wrap a
// rendered JSON endpoint's response the same way -- falls back to a
// direct JSON.parse of the raw text if no <pre> tag is found, so this
// isn't Scrape.do-specific, but hasn't been proven against a real
// ZenRows response yet.
function extractJson(text) {
  const preMatch = text.split("<pre>")[1]?.split("</pre>")[0];
  if (preMatch) {
    return JSON.parse(preMatch);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    // CONFIRMED REAL from a live report: this error's "First 200
    // chars" showed up completely empty -- meaning the response body
    // was genuinely zero-length, not just malformed/unparseable
    // content. Those are different failures with different likely
    // causes (an empty body points at the target or the proxy provider
    // itself returning nothing despite a 200, vs malformed content
    // pointing at a real parsing/format mismatch) and the old message
    // reported both identically, indistinguishable from each other.
    if (text.length === 0) {
      throw new Error(
        `Response body was completely empty (0 chars) despite an outer 200 -- not a parsing problem, ` +
        `the provider or target returned nothing to parse in the first place.`
      );
    }
    throw new Error(
      `Couldn't find JSON in the response, either <pre>-wrapped or raw (${text.length} chars). First 200 chars: ${text.slice(0, 200)}`
    );
  }
}

function toMMDDYYYY(dateISO) {
  const [y, m, d] = dateISO.split("-");
  return `${m}-${d}-${y}`;
}

// Step 1: get the day's full showtime listing for a theater (all movies,
// not just the one we want -- filtered client-side, same pattern as the
// SerpApi adapter).
//
// Cached by cinemaCode+dateISO. TTL is time until midnight at the theater
// (showtime listings don't change intraday). Falls back to a 4-hour TTL
// if somehow called without the timezone offset available -- in practice
// always called with a dateISO so the midnight calculation always fires.
// Disk cache survives Node restarts within the same Render container.
async function getShowtimesForTheater({ cinemaCode, dateISO, costTracker }) {
  const cacheKey = `regal-listing-${cinemaCode}-${dateISO}`;
  // TTL: ms until midnight tonight (listings are stale after the day rolls over).
  const [cy, cm, cd] = dateISO.split("-").map(Number);
  const midnight = new Date(Date.UTC(cy, cm - 1, cd + 1)).getTime();
  const ttlMs = Math.max(midnight - Date.now(), 5 * 60 * 1000); // at least 5 min

  // Validate that a cache hit has the `format` field added in v4.4.1 --
  // stale entries from before that version lack it, causing all showings
  // to display as "Standard" regardless of actual screen type.
  function isCacheValid(entries) {
    return Array.isArray(entries) && entries.length > 0 && entries[0].format !== undefined;
  }

  const memHit = listingMemCache.get(cacheKey);
  if (memHit && Date.now() < memHit.expiresAt && isCacheValid(memHit.data)) {
    console.error(`Regal listing [${cinemaCode}] ${dateISO}: memory cache hit (${memHit.data.length} performances)`);
    return memHit.data;
  }
  const diskHit = await readCache(cacheKey, ttlMs);
  if (diskHit && isCacheValid(diskHit)) {
    console.error(`Regal listing [${cinemaCode}] ${dateISO}: disk cache hit (${diskHit.length} performances)`);
    listingMemCache.set(cacheKey, { data: diskHit, expiresAt: Date.now() + ttlMs });
    return diskHit;
  }

  const dateMMDDYYYY = toMMDDYYYY(dateISO);
  const listingUrl = `https://www.regmovies.com/api/getShowtimes?theatres=${cinemaCode}&date=${dateMMDDYYYY}&hoCode=&ignoreCache=false&moviesOnly=false`;
  const { res, provider, creditsUsed } = await fetchWithRotation(listingUrl, {});
  costTracker.total += creditsUsed;
  costTracker.byProvider[provider] = (costTracker.byProvider[provider] || 0) + creditsUsed;

  if (!res.ok) {
    // CONFIRMED REAL GAP: a live report showed Apify returning 500 on
    // both the listing GET and the createOrder POST, inconsistently --
    // sometimes the exact same kind of call succeeded, sometimes it
    // didn't. That mixed pattern rules out a clean "GET works, POST
    // doesn't" theory, but the response body (which would actually say
    // why) was being discarded here, leaving no way to tell a request-
    // shape problem apart from Apify's own instability (their Standby
    // mode is explicitly labeled "experimental" in their own docs).
    // Logging it now so the next failure is diagnosable instead of a
    // bare status code.
    const bodyText = await res.text().catch(() => "(could not read body)");
    throw new Error(`${provider} listing request failed: ${res.status} ${res.statusText} -- body: ${bodyText.slice(0, 500)}`);
  }

  const text = await res.text();
  const json = extractJson(text);
  const shows = json.shows || [];
  const films = shows[0]?.Film || [];

  const performances = [];
  for (const film of films) {
    for (const perf of film.Performances || []) {
      if (!perf.PerformanceId || !perf.CalendarShowTime) continue;

      // CONFIRMED real field names from a live response:
      //   Auditorium -- string, e.g. "RPX Theatre 1" or "Auditorium 5"
      //   PerformanceAttributes -- array of attribute objects
      const attrs = perf.PerformanceAttributes || [];
      const attrNames = Array.isArray(attrs)
        ? attrs.map((a) => a.Description || a.Name || a.AttributeDescription || String(a)).filter(Boolean)
        : [];
      const screenName = perf.Auditorium || null;

      performances.push({
        movieName: film.Title,
        movieId: film.MasterMovieCode,
        performanceId: perf.PerformanceId,
        showTime: perf.CalendarShowTime.split("T")[1], // "HH:MM:SS"
        screenName,
        attrNames,
        format: deriveRegalFormat({ attrNames, screenName }),
      });
    }
  }

  listingMemCache.set(cacheKey, { data: performances, expiresAt: Date.now() + ttlMs });
  writeCache(cacheKey, performances, ttlMs);
  return performances;
}

// Step 2: create a temporary order session -- required before ticket
// prices are reachable, per Regal's own booking flow.
async function createOrderSession({ cinemaCode, costTracker }) {
  const orderUrl = "https://www.regmovies.com/api/createOrder";
  // needsRender intentionally NOT set: byparr's browser gets an HTML Cloudflare
  // challenge page back from Regal's API endpoint (confirmed from live logs --
  // createOrder POST triggers a CF challenge even in a real browser session).
  // Skipping byparr entirely so we go straight to Bright Data async, which is
  // the only provider that can relay a POST body to this endpoint.
  const { res, provider, creditsUsed } = await fetchWithRotation(orderUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cinemaId: cinemaCode }),
  });
  costTracker.total += creditsUsed;
  costTracker.byProvider[provider] = (costTracker.byProvider[provider] || 0) + creditsUsed;

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "(could not read body)");
    throw new Error(`${provider} createOrder failed: ${res.status} ${res.statusText} -- body: ${bodyText.slice(0, 500)}`);
  }

  const json = await res.json();
  // CONFIRMED DISCREPANCY, caught before it could break things: a real
  // captured response via the new apify-cfbypass provider showed
  // order.user_session_id (snake_case), while this code has only ever
  // checked order.userSessionId (camelCase) -- and that camelCase
  // version DID work for real Scrape.do/ZenRows responses earlier this
  // session. Genuinely unclear whether Regal's raw API uses snake_case
  // and Scrape.do/ZenRows were somehow normalizing it, or Apify's
  // console dataset viewer reformatted the key for display and the raw
  // JSON is actually camelCase like everywhere else. Rather than guess,
  // checking both so this can't silently break either way.
  const cartId = json?.order?.userSessionId ?? json?.order?.user_session_id;
  if (!cartId) {
    throw new Error(`createOrder response missing order.userSessionId (checked both camelCase and snake_case): ${JSON.stringify(json).slice(0, 200)}`);
  }
  return cartId;
}

// Step 3: the actual ticket prices for one specific performance.
async function getTicketsForPerformance({ cinemaCode, performanceId, cartId, costTracker }) {
  const ticketsUrl = `https://www.regmovies.com/api/getTicketsForSession?theatreCode=${cinemaCode}&vistaSession=${performanceId}&cartId=${cartId}&sessionToken=false`;
  const { res, provider, creditsUsed } = await fetchWithRotation(ticketsUrl, {});
  costTracker.total += creditsUsed;
  costTracker.byProvider[provider] = (costTracker.byProvider[provider] || 0) + creditsUsed;

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "(could not read body)");
    throw new Error(`${provider} getTicketsForSession failed: ${res.status} ${res.statusText} -- body: ${bodyText.slice(0, 500)}`);
  }

  const json = await res.json();
  return json.Tickets || [];
}

// Derive a display format string from the fields we captured. Field
// names are unconfirmed, so this is best-effort until a real response
// confirms what Regal actually sends (see the key-logging above).
function deriveRegalFormat(perf) {
  // Known premium identifiers to watch for in any text field.
  const PREMIUM = /\b(rpx|imax|4dx|screenx|d-?box|dolby|prime|bigd|ultra)\b/i;
  // 3D is a modifier, not premium on its own, but should be appended when
  // it appears alongside a premium format (e.g. attrNames ["4DX","3D"] -> "4DX 3D").
  const IS_3D = /\b3d\b/i;

  // Check PerformanceAttributes array first (confirmed real field name).
  // Collect ALL relevant attrs -- premium identifiers + 3D qualifier -- so
  // "4DX 3D" doesn't collapse to just "4DX" because find() stopped early.
  const attrNames = perf.attrNames || [];
  const relevant = attrNames.filter((n) => PREMIUM.test(n) || IS_3D.test(n));
  if (relevant.length > 0) {
    // Put the primary premium format before the 3D modifier so the label
    // reads "4DX 3D" not "3D 4DX" when attrNames comes in the wrong order.
    relevant.sort((a, b) => {
      const aP = PREMIUM.test(a), bP = PREMIUM.test(b);
      return aP === bP ? 0 : aP ? -1 : 1;
    });
    return relevant.join(" ");
  }

  // Then Auditorium string (confirmed real: "RPX Theatre 1", "Auditorium 5", etc.).
  if (perf.screenName && PREMIUM.test(perf.screenName)) {
    const m = perf.screenName.match(PREMIUM);
    return m ? m[0].toUpperCase() : perf.screenName;
  }
  return "Standard";
}

// Regal does not always fill LongDescription. Colorado Center 9's IMAX 70mm
// ticket arrives as {Description: "General Admission", LongDescription: ""},
// so reading LongDescription alone saw an empty string and priced nothing.
// Read both.
function ticketDesc(t) {
  return `${t.LongDescription || ""} ${t.Description || ""}`.trim().toLowerCase();
}

// A ticket the general public can actually buy. These structural flags are
// more dependable than the wording, which varies by theater and is sometimes
// blank -- so they back up the text layers rather than replacing them.
function isBuyableTicket(t) {
  return !t.IsChildOnlyTicket && !t.IsPackageTicket && !t.IsRedemptionTicket && !t.IsComplimentaryTicket;
}

// Only the adult ticket type, per what you actually need. Four layers,
// most-specific first:
// 1. Explicit "adult" wording (works for some theaters/chains).
// 2. Vista-style age-inclusive phrasing that functions as the standard/
//    adult ticket without using the word "adult" -- confirmed against a
//    live Regal response where tickets were labeled "Valid for all
//    persons 12 and older" / "Valid for all children under 12" instead.
//    The "X and older" ticket (excluding anything that also mentions
//    child/junior/under) is the general-admission-equivalent price.
// 3. "General Admission"/"Standard", which carries no age wording at all --
//    confirmed live at Colorado Center 9 (0004, $31.99, IMAX 70mm).
// 4. Structural last resort: exactly ONE buyable ticket type. Unambiguous
//    only when there is a single candidate -- with several we cannot tell
//    which is the adult one, so return null rather than guess a price.
function extractAdultPriceCents(tickets) {
  const explicitAdult = tickets.find((t) => ticketDesc(t).includes("adult"));
  if (explicitAdult) return explicitAdult.PriceInCents ?? null;

  const ageBasedAdult = tickets.find((t) => {
    const desc = ticketDesc(t);
    const isAgeInclusive = /\d+\s*(and|&)\s*(older|above|up|over)/.test(desc);
    const isChildSpecific = /under|child|junior|kid/.test(desc);
    return isAgeInclusive && !isChildSpecific;
  });
  if (ageBasedAdult) return ageBasedAdult.PriceInCents ?? null;

  const general = tickets.find((t) => {
    const desc = ticketDesc(t);
    return /general admission|standard/.test(desc) && !/child|junior|kid|senior|student|military/.test(desc);
  });
  if (general) return general.PriceInCents ?? null;

  const buyable = tickets.filter(isBuyableTicket);
  if (buyable.length === 1) return buyable[0].PriceInCents ?? null;

  return null;
}

// Full orchestration for one theater: list the day's showtimes, filter to
// the target movie AND to the specific candidate times already surfaced
// by the main search (not every showing of the movie that day at that
// theater). This is the credit-usage-critical part -- pricing a
// theater's full day instead of just the 1-2 showings that actually
// survived your deadline/radius filter can burn through a provider's
// quota fast, which is now exactly what the provider-rotation layer
// exists to absorb gracefully rather than just failing the search.
//
// preDiscoveredPerformances/costTracker are optional -- when the caller
// has ALREADY called getShowtimesForTheater itself (to filter against
// the search window before deciding what's worth pricing), pass the
// result back in here to skip a second, duplicate 25-credit listing
// call. Pass the SAME costTracker object through too, so the listing
// cost and the pricing costs accumulate into one real total instead of
// costTracker resetting to 0 here and undercounting.

// ---- Cart sharing across performances (v5.8.3) ----
//
// CONFIRMED LIVE, not assumed: one cart serves every performance at its
// theater. Tested against Regal directly through Camofox -- a single
// createOrder for cinema 1413 answered SIX getTicketsForSession calls
// across three performances, all HTTP 200, with genuinely per-performance
// prices ($18.49 / $18.49 / $22.49 -- the third differing is what rules
// out a cached or identical response). The cart did not go stale across
// those six reads.
//
// This matters because createOrder is the ONLY step Cloudflare rate-limits
// (~3 POSTs per IP window, measured over many live searches). Before this
// change, a theater with 5 showtimes opened 5 carts, so a normal 2-theater
// search spent 8 POSTs against a 3-POST budget and most of them failed.
// One cart per theater brings that to 2 -- inside the budget.
//
// CONFIRMED LIVE (v6.5.0): the cart is not theater-scoped EITHER. A cart opened
// against cinema 1308 priced performances at 1315 and 1943 too, returning
// genuinely different prices ($15.49 / $16.49 / $13.49) -- so those were real
// per-theater lookups, not a cached response. The cinemaId in createOrder is
// effectively just initialization.
//
// That matters in dense markets. Denver has five Regal theaters in range, so
// one-cart-per-theater meant five POSTs against a ~3-POST Cloudflare window:
// every price failed, each fell through to Bright Data's 60s timeout, and the
// search took 127s and returned no Regal prices at all. One cart per SEARCH
// makes that a single POST regardless of how many theaters are in range.
//
// The cart is minted LAZILY on first use rather than eagerly, so a search whose
// showtimes all get filtered out never opens one at all.
function makeCartProvider({ cinemaCode, costTracker }) {
  let cartPromise = null;
  let generation = 0;

  return {
    // Shared across all performances at this theater. Concurrent callers
    // await the same in-flight createOrder rather than each opening one.
    // Returns the generation alongside the id so a failing caller can say
    // WHICH cart went bad -- see invalidate.
    get() {
      if (!cartPromise) {
        generation++;
        console.error(
          // Says "opened via" rather than naming a theater the cart belongs to:
          // since v6.5.0 one cart serves the whole search, and cinemaCode is
          // just whichever theater happened to open it. The old wording read as
          // though the cart were scoped to that theater, which is exactly the
          // wrong mental model to leave in the log -- it's the assumption that
          // cost two rounds of rework already.
          `Regal: opening cart (generation ${generation}) via theatre ${cinemaCode} -- shared by every theater in this search`
        );
        cartPromise = createOrderSession({ cinemaCode, costTracker });
      }
      const gen = generation;
      return cartPromise.then((cartId) => ({ cartId, gen }));
    },

    // Called only on a session-stage 422, where a genuinely fresh cart has
    // a real chance of working. Guarded by generation: when several
    // performances fail on the SAME bad cart, they all try to invalidate
    // it, and without this guard the second one would throw away the fresh
    // cart the first one just minted -- costing exactly the extra
    // createOrder POSTs this whole change exists to avoid.
    invalidate(gen) {
      if (gen !== generation) return; // already replaced by another caller
      cartPromise = null;
    },
  };
}

async function getPricedShowtimes({ cinemaCode, movieTitle, dateISO, candidateMinutes, preDiscoveredPerformances, costTracker: externalCostTracker, onResult, isAborted, cart: sharedCart }) {
  const costTracker = externalCostTracker || { total: 0, byProvider: {} };
  const performances = preDiscoveredPerformances || await getShowtimesForTheater({ cinemaCode, dateISO, costTracker });
  const movieMatches = performances.filter((p) => matchesMovie(p.movieName, movieTitle));

  const matching = candidateMinutes
    ? movieMatches.filter((p) => {
        const [h, m] = p.showTime.split(":").map(Number);
        const pMin = h * 60 + m;
        return candidateMinutes.some((c) => Math.abs(pMin - c) <= 3);
      })
    : movieMatches;

  // Log a summary when this function did its OWN listing fetch -- a
  // silent zero-match result (site returned real data, but nothing
  // matched) looks identical to "nothing ran at all" from the outside
  // otherwise.
  //
  // CONFIRMED REAL BUG, fixed here: when preDiscoveredPerformances is
  // passed, the caller (server.js) has ALREADY logged this exact same
  // sentence against the full, unfiltered listing -- so logging again
  // here printed a second, near-identical line describing the caller's
  // own already-filtered output ("found 2 total performances" right
  // after "found 31 total performances" for the same theater). That
  // looked exactly like a duplicate theater entry or a double-submitted
  // search, and cost real time chasing both. It was neither: just two
  // copies of the same log line living at two different layers. An
  // earlier investigation grepped only server.js for the phrasing,
  // found one hit, and wrongly concluded the code path had genuinely
  // run twice -- the second copy was here in the adapter all along.
  if (!preDiscoveredPerformances) {
    console.error(
      `Regal [${cinemaCode}]: found ${performances.length} total performances, ` +
        `${movieMatches.length} matching "${movieTitle}", ${matching.length} within your search window ` +
        `(pricing only these). Movies seen: ${[...new Set(performances.map((p) => p.movieName))].join(", ") || "(none)"}`
    );
  }

// DELIBERATE, don't "fix" this: a NON-422 createOrder failure (a Cloudflare
// 429 being the common one) leaves the rejected promise memoized, so every
// other performance at this theater fails fast on it instead of each firing
// its own createOrder. That is the correct response -- a 429 means the IP's
// POST window is already spent, so those extra calls would fail anyway, and
// firing them just deepens the rate limit for the NEXT theater. Only a
// session-stage 422, where a fresh cart genuinely might work, clears the memo.

// Wraps the createOrder -> getTicketsForSession sequence with retries
// for HTTP 422 -- confirmed real from multiple live searches: either
// step can fail with 422 (Regal's own backend rejecting the request,
// not a network/proxy issue), while other performances in the same
// search succeed normally.
//
// The original hypothesis (concurrent theater processing causing
// session/cart staleness) was tested directly and DISPROVEN: a search
// that matched only one Regal theater -- so concurrency literally
// couldn't have been a factor, nothing else was running alongside it --
// still hit this exact failure, immediately on createOrder itself (the
// very first call, no prior step to have gone stale). Current best
// understanding: this looks like genuine intermittent flakiness on
// Regal's own backend, not something triggered by how this app calls
// it -- there may not be a root-cause fix available on this end.
//
// CORRECTION, confirmed real from a live search's own credit log: the
// earlier claim here that failed attempts "consistently cost 0 real
// credits" was WRONG, and it was the entire justification for raising
// the attempt count. What actually costs 0 is the FAILING call itself
// -- but every retry opens a genuinely fresh createOrder first, and
// those bill at the normal rate (x-request-cost 0.01 -> 10 credits).
// So each extra attempt costs ~10 real credits, not nothing. Retrying
// is a real spend and has to be justified per-step, not blanket-
// applied because it was believed free.
//
// THE KEY DISTINCTION, read straight off a real failure log: 422 can
// come from either step, and the two mean very different things.
//
//   createOrder 422        -- session-level. Nothing about this request
//                             is specific to a performance; it's just
//                             opening a cart. A 422 here really does
//                             look like backend flakiness, and a fresh
//                             attempt has a genuine chance of working.
//                             Confirmed to happen on its own (a
//                             single-theater search hit it immediately,
//                             ruling out concurrency as the cause).
//
//   getTicketsForSession 422 -- performance-level. By this point
//                             createOrder has ALREADY SUCCEEDED, so the
//                             session is known good and freshly made.
//                             Regal is rejecting this specific
//                             performanceId, which is what you'd expect
//                             from a showing that isn't sellable (sold
//                             out, too close to showtime, pulled). A
//                             brand-new cart cannot fix that, and the
//                             real log bears this out: performance
//                             299758 was handed two independently
//                             created fresh sessions and 422'd at this
//                             same step both times before the third
//                             attempt died at createOrder. Three
//                             attempts bought nothing but ~20 wasted
//                             credits and ~3 seconds.
//
// Hence two separate caps rather than one. The session stage keeps its
// 3 attempts, since that's the case where retrying is actually
// plausible. The ticket stage gets 2 -- one retry, to stay honest about
// the possibility of a genuine blip, then it stops instead of paying
// for a third createOrder to ask an unchanged question.
//
// NOT retrying on other error types, since a fundamentally invalid
// request (wrong cinemaCode, malformed performanceId, etc.) won't
// succeed on a second try and would just waste time chasing a dead end.
const REGAL_MAX_SESSION_ATTEMPTS = 3;
const REGAL_MAX_TICKET_ATTEMPTS = 2;
const REGAL_RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Which step threw, read off the error message the two throw sites
// build (`${provider} createOrder failed: ...` and `${provider}
// getTicketsForSession failed: ...`). Returns null for anything that
// isn't a 422, so non-422 errors keep propagating untouched.
function classifyRegal422(err) {
  if (!/\b422\b/.test(err.message)) return null;
  if (/getTicketsForSession/.test(err.message)) return "ticket";
  if (/createOrder/.test(err.message)) return "session";
  return "session";
}

async function createOrderAndGetTicketsWithRetry({ cinemaCode, performanceId, cart, costTracker }) {
  const creditsAtStart = costTracker ? costTracker.total : 0;
  let sessionAttempts = 0;
  let ticketAttempts = 0;
  let lastError;
  // Which cart generation this attempt used, so a session-stage failure
  // invalidates the cart it actually saw fail and not a newer one.
  let usedGen = null;

  for (;;) {
    try {
      // Shared theater cart, minted on first use. A cartId from a FAILED
      // session attempt is never reused -- invalidate() below clears the
      // memo so the next get() opens a genuinely fresh one.
      const { cartId, gen } = await cart.get();
      usedGen = gen;
      return await getTicketsForPerformance({ cinemaCode, performanceId, cartId, costTracker });
    } catch (err) {
      lastError = err;
      const stage = classifyRegal422(err);
      if (!stage) throw err;

      let attemptsUsed;
      let maxAttempts;
      if (stage === "ticket") {
        ticketAttempts++;
        attemptsUsed = ticketAttempts;
        maxAttempts = REGAL_MAX_TICKET_ATTEMPTS;
      } else {
        sessionAttempts++;
        attemptsUsed = sessionAttempts;
        maxAttempts = REGAL_MAX_SESSION_ATTEMPTS;
        // Session-stage failure: this cart is bad (or was never created).
        // Drop it so the retry -- and every other performance still waiting
        // on this theater -- picks up a fresh one.
        cart.invalidate(usedGen);
      }

      if (attemptsUsed >= maxAttempts) {
        const spent = costTracker ? costTracker.total - creditsAtStart : null;
        console.error(
          `Regal [${cinemaCode}]: performance ${performanceId} giving up after ` +
          `${attemptsUsed} ${stage}-stage 422${attemptsUsed === 1 ? "" : "s"} ` +
          (stage === "ticket"
            ? "-- createOrder succeeded each time, so this looks like the showing itself isn't sellable (sold out / too close to showtime) rather than a transient fault. "
            : "-- couldn't open a cart at all. ") +
          (spent != null ? `Real credits spent on this performance: ${spent}.` : "")
        );
        throw lastError;
      }

      console.error(
        `Regal [${cinemaCode}]: ${stage}-stage 422 on performance ${performanceId}, ` +
        `attempt ${attemptsUsed} of ${maxAttempts} -- retrying with a fresh session after a short delay:`,
        err.message
      );
      await sleep(REGAL_RETRY_DELAY_MS);
    }
  }
  // No trailing throw needed: the loop is unbounded and every exit path
  // above either returns, rethrows a non-422, or throws on hitting that
  // stage's cap.
}

  const results = [];
  // Prefer a caller-supplied cart shared across the whole search; fall back to
  // a per-theater one so this function still works standalone (the on-demand
  // /api/price-regal-showing path calls it that way).
  const cart = sharedCart || makeCartProvider({ cinemaCode, costTracker });

  // Price all performances in parallel. The first to arrive triggers the
  // single createOrder; the rest await that same promise, so this is one
  // POST per theater no matter how many showtimes there are.
  // Array.push is synchronous; parallel pushes are safe here.
  await Promise.all(matching.map(async (perf) => {
    // Skip anything still queued once the client has gone. This is the part
    // that actually matters: each remaining performance would otherwise spend
    // a getTicketsForSession call, and a re-minted cart spends a createOrder
    // POST against the same per-IP Cloudflare window the user's NEXT search
    // needs. Checked per performance rather than once, since the queue drains
    // over several seconds.
    if (isAborted && isAborted()) return;

    let result;
    try {
      const tickets = await createOrderAndGetTicketsWithRetry({
        cinemaCode,
        performanceId: perf.performanceId,
        cart,
        costTracker,
      });
      const cents = extractAdultPriceCents(tickets);
      if (cents == null && tickets.length > 0) {
        console.error(
          `Regal [${cinemaCode}]: got ${tickets.length} ticket types for performance ${perf.performanceId} but none matched "adult". Types seen: ${tickets
            .map((t) => t.LongDescription)
            .join(", ")} -- RAW: ${JSON.stringify(tickets).slice(0, 600)}`
        );
      } else if (tickets.length === 0) {
        console.error(
          `Regal [${cinemaCode}]: getTicketsForSession returned zero ticket types for performance ${perf.performanceId}.`
        );
      }
      result = {
        time: perf.showTime,
        price: cents != null ? cents / 100 : null,
        movieId: perf.movieId,
        performanceId: perf.performanceId,
        format: deriveRegalFormat(perf),
      };
    } catch (err) {
      console.error(
        `Regal: pricing failed for performance ${perf.performanceId} at ${cinemaCode}:`,
        err.message
      );
      result = { time: perf.showTime, price: null, movieId: perf.movieId, performanceId: perf.performanceId, format: deriveRegalFormat(perf) };
    }
    results.push(result);
    if (onResult) onResult(result);
  }));

  console.error(
    `Regal [${cinemaCode}]: REAL credit cost this call: ${costTracker.total} total (${JSON.stringify(costTracker.byProvider)}).`
  );

  return { results, creditsUsed: costTracker.total, creditsByProvider: costTracker.byProvider };
}

// Runtime for one film, read off Regal's own movie page.
//
// Regal's getShowtimes response carries only Title, MasterMovieCode and
// Performances -- confirmed by dumping a real film object -- so runtime has to
// come from somewhere else. The movie page embeds it as schema.org markup:
// "duration":"PT118M". Confirmed live for The Dog Stars (118 min), a film
// showing at Regal and at no Cinemark in range, which is exactly the case that
// was falling through to the hardcoded 128-minute constant.
//
// Same URL the booking links already use, so the slug format is known-good.
// A GET, so it costs nothing through the camofox provider.
const regalRuntimeCache = new Map();

async function getRuntimeForRegalMovie({ movieTitle, movieId, toUrlSlug }) {
  if (!movieId || !movieTitle) return null;
  const key = String(movieId).toLowerCase();
  if (regalRuntimeCache.has(key)) return regalRuntimeCache.get(key);

  try {
    const url = `https://www.regmovies.com/movies/${toUrlSlug(movieTitle)}-${key}`;
    const { res } = await fetchWithRotation(url, {});
    if (!res.ok) return null;
    const html = await res.text();
    // ISO 8601 duration. PT118M, and PT1H58M defensively.
    let minutes = null;
    const m = /"duration"\s*:\s*"PT(?:(\d+)H)?(?:(\d+)M)?"/i.exec(html);
    if (m) minutes = (Number(m[1] || 0) * 60) + Number(m[2] || 0);
    const value = minutes && minutes > 0 ? minutes : null;
    regalRuntimeCache.set(key, value);
    return value;
  } catch (err) {
    console.error(`Regal runtime lookup failed for "${movieTitle}":`, err.message);
    return null;
  }
}

// Returns cached showtime data for a theater+date if it's in memory,
// null otherwise. Used by /api/movies to avoid a fresh proxy request.
function getCachedShowtimesForTheater({ cinemaCode, dateISO }) {
  const cacheKey = `regal-listing-${cinemaCode}-${dateISO}`;
  const hit = listingMemCache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt && Array.isArray(hit.data) && hit.data.length > 0) {
    return hit.data;
  }
  return null;
}

module.exports = { getPricedShowtimes, getShowtimesForTheater, getCachedShowtimesForTheater, getRuntimeForRegalMovie, makeCartProvider };
