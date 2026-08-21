const { matchesMovie } = require("./serpapi");
const { fetchWithRotation } = require("../proxyProviders");

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
async function getShowtimesForTheater({ cinemaCode, dateISO, costTracker }) {
  const dateMMDDYYYY = toMMDDYYYY(dateISO);
  const listingUrl = `https://www.regmovies.com/api/getShowtimes?theatres=${cinemaCode}&date=${dateMMDDYYYY}&hoCode=&ignoreCache=false&moviesOnly=false`;
  const { res, provider, creditsUsed } = await fetchWithRotation(listingUrl, { needsRender: true });
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
      performances.push({
        movieName: film.Title,
        // Confirmed real field name from a live capture -- gives the
        // same "HO########" ID convention used across the whole
        // Vista-family platform (Cinema West, Harkins), needed to
        // construct a real booking link.
        movieId: film.MasterMovieCode,
        performanceId: perf.PerformanceId,
        showTime: perf.CalendarShowTime.split("T")[1], // "HH:MM:SS"
      });
    }
  }
  return performances;
}

// Step 2: create a temporary order session -- required before ticket
// prices are reachable, per Regal's own booking flow.
async function createOrderSession({ cinemaCode, costTracker }) {
  const orderUrl = "https://www.regmovies.com/api/createOrder";
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
  const { res, provider, creditsUsed } = await fetchWithRotation(ticketsUrl);
  costTracker.total += creditsUsed;
  costTracker.byProvider[provider] = (costTracker.byProvider[provider] || 0) + creditsUsed;

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "(could not read body)");
    throw new Error(`${provider} getTicketsForSession failed: ${res.status} ${res.statusText} -- body: ${bodyText.slice(0, 500)}`);
  }

  const json = await res.json();
  return json.Tickets || [];
}

// Only the adult ticket type, per what you actually need. Two layers:
// 1. Explicit "adult" wording (works for some theaters/chains).
// 2. Vista-style age-inclusive phrasing that functions as the standard/
//    adult ticket without using the word "adult" -- confirmed against a
//    live Regal response where tickets were labeled "Valid for all
//    persons 12 and older" / "Valid for all children under 12" instead.
//    The "X and older" ticket (excluding anything that also mentions
//    child/junior/under) is the general-admission-equivalent price.
function extractAdultPriceCents(tickets) {
  const explicitAdult = tickets.find((t) =>
    (t.LongDescription || "").toLowerCase().includes("adult")
  );
  if (explicitAdult) return explicitAdult.PriceInCents ?? null;

  const ageBasedAdult = tickets.find((t) => {
    const desc = (t.LongDescription || "").toLowerCase();
    const isAgeInclusive = /\d+\s*(and|&)\s*(older|above|up|over)/.test(desc);
    const isChildSpecific = /under|child|junior|kid/.test(desc);
    return isAgeInclusive && !isChildSpecific;
  });
  return ageBasedAdult?.PriceInCents ?? null;
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
async function getPricedShowtimes({ cinemaCode, movieTitle, dateISO, candidateMinutes, preDiscoveredPerformances, costTracker: externalCostTracker }) {
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

async function createOrderAndGetTicketsWithRetry({ cinemaCode, performanceId, costTracker }) {
  const creditsAtStart = costTracker ? costTracker.total : 0;
  let sessionAttempts = 0;
  let ticketAttempts = 0;
  let lastError;

  for (;;) {
    try {
      // Always a genuinely fresh createOrder call on every attempt --
      // never reuse a cartId that came from a failed attempt.
      const cartId = await createOrderSession({ cinemaCode, costTracker });
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
  for (const perf of matching) {
    try {
      const tickets = await createOrderAndGetTicketsWithRetry({
        cinemaCode,
        performanceId: perf.performanceId,
        costTracker,
      });
      const cents = extractAdultPriceCents(tickets);
      if (cents == null && tickets.length > 0) {
        console.error(
          `Regal [${cinemaCode}]: got ${tickets.length} ticket types for performance ${perf.performanceId} but none matched "adult". Types seen: ${tickets
            .map((t) => t.LongDescription)
            .join(", ")}`
        );
      } else if (tickets.length === 0) {
        console.error(
          `Regal [${cinemaCode}]: getTicketsForSession returned zero ticket types for performance ${perf.performanceId}.`
        );
      }
      results.push({
        time: perf.showTime,
        price: cents != null ? cents / 100 : null,
        movieId: perf.movieId,
        performanceId: perf.performanceId,
      });
    } catch (err) {
      console.error(
        `Regal: pricing failed for performance ${perf.performanceId} at ${cinemaCode}:`,
        err.message
      );
      results.push({ time: perf.showTime, price: null, movieId: perf.movieId, performanceId: perf.performanceId });
    }
  }

  console.error(
    `Regal [${cinemaCode}]: REAL credit cost this call: ${costTracker.total} total (${JSON.stringify(costTracker.byProvider)}).`
  );

  return { results, creditsUsed: costTracker.total, creditsByProvider: costTracker.byProvider };
}

module.exports = { getPricedShowtimes, getShowtimesForTheater };
