const fetch = require("node-fetch");

const NAME = "camofox-regal";

// Camofox-based provider for Regal's Cloudflare-protected API.
//
// Instead of routing API calls through an external proxy service, this
// provider uses Camofox's `evaluate` endpoint to execute fetch() calls
// from within a real browser tab that already has a cleared Cloudflare
// session at regmovies.com. This means:
//   - createOrder returns in ~0.5s (vs Bright Data's 20s async poll)
//   - No per-request credit cost
//   - No US-geo-restriction (browser IP is the tunnel host's IP)
//
// A POOL of regmovies.com tabs is kept open and reused across calls (lazy
// open, TTL-refreshed). If a tab disappears (Camofox restart, TTL) it is
// transparently replaced on the next request.
//
// WHY A POOL: a browser tab runs one `evaluate` at a time, so a single tab
// serialized every call no matter how much concurrency the caller had. Measured
// on a 5-theater Denver search: 21 getTicketsForSession calls took ~41s of a
// 52s search -- ~1.95s each, back to back -- while the same search with Regal
// switched off finished in 1.5s. The app was already asking for concurrency
// (pLimit(3) across theaters, all of a theater's performances at once); the
// serialization was here.
//
// Only GETs benefit. createOrder stays serialized on the POST queue below,
// because Cloudflare's limit is on POST volume and running those in parallel
// is precisely what the cart-sharing work removed.
//
// Each tab clears Cloudflare independently when it opens (waitUntil
// networkidle at regmovies.com), which is the same mechanism the single tab
// always used -- so a pooled tab is not relying on cookies leaking from
// another one.
//
// Required env vars:
//   CAMOFOX_URL         -- e.g. https://camofox.flimcrickets.com
//   CAMOFOX_USER_ID     -- arbitrary shared secret (namespaces sessions)
//   CAMOFOX_SESSION_KEY -- second auth param required by Camofox API
// Optional:
//   CAMOFOX_TAB_POOL    -- max concurrent tabs (default 4; 1 = old behaviour)

const REGAL_BASE = "https://www.regmovies.com";
// Keep the tab alive as long as requests come in regularly. Camofox's
// own idle timeout is longer, but we recreate proactively at 20 min.
// 5 minutes, not 20. The pool exists to amortise tab opens ACROSS ONE SEARCH;
// holding them for twenty afterwards buys almost nothing and costs resident
// memory on the Camofox host the whole time. That host was measured at 1.2G
// resident / 1.9G peak with 1.9G of swap peak, and its browser crashed and
// restarted mid-search -- which is what produced the openTab 500/503 storm.
// A re-open costs a few seconds; a crashed browser cost 124.7s.
// Tunable, because it is a straight memory-vs-latency trade on YOUR host and
// the right answer depends on how that box is doing:
//   lower  -> tabs freed sooner, less resident memory, but a search more than
//             this many minutes after the last one re-opens the pool
//             (roughly 5s per tab, so ~20s on a pool of 4)
//   higher -> more reuse across spaced-out searches, more memory held
// Irrelevant WITHIN a search: the pool opens once and reuses those tabs for
// every pricing call. 5 is deliberately conservative after the host crashed.
const TAB_TTL_MS = Math.max(1, Number(process.env.CAMOFOX_TAB_TTL_MIN) || 5) * 60 * 1000;

// How often idle tabs are swept. Without this, an expired tab was only ever
// closed when the NEXT request happened to acquire it (see acquireTab), so a
// single search left its whole pool resident indefinitely -- nobody searches
// again just to trigger the cleanup.
const REAP_INTERVAL_MS = 60 * 1000;

// Tab pool. `permits` bounds how many tabs can exist at once; a caller holding
// a permit is guaranteed room for one. Free tabs are parked in `freeTabs` and
// reused, so a steady stream of requests opens at most POOL_SIZE tabs total.
// 4, not 8. Raising it to 8 was predicted to halve the Regal tail and instead
// made a real Denver search SLOWER -- 32.5s at 4 tabs, 53.7s at 8, same
// workload (21 pricing calls, 5 theaters).
//
// The reason is that opening a tab is not free: each one loads regmovies.com
// with waitUntil:networkidle to clear Cloudflare, and the Camofox host appears
// to serialize those opens. So tabs are bought one at a time, up front, while
// the calls they would parallelise are waiting. At 21 calls the extra opens
// cost more than the extra concurrency saves, and the crossover is below 8.
//
// This only bites on a COLD pool. Tabs live TAB_TTL_MS (20 min) and are
// reused, so a second search inside that window pays nothing -- but a Render
// redeploy resets this process's pool and re-opens everything, which is why
// production sees the cold cost more often than a local test would.
const POOL_SIZE = Math.max(1, Number(process.env.CAMOFOX_TAB_POOL) || 4);
let permits = POOL_SIZE;
const permitWaiters = [];
const freeTabs = [];   // { id, expiresAt }, all idle and believed live
let liveTabCount = 0;  // open tabs, busy or idle -- for logging only

// Circuit breaker. When the Camofox host itself is down, every request paid a
// full openTab round trip before falling through to the next provider.
// Observed live: openTab returning 500 then 503 for a whole search, ten doomed
// attempts, first Regal result at 86.6s and the search taking 124.7s -- most of
// it re-asking a host that had already refused three times. The pool made this
// worse rather than better: more tabs meant more independent opens to fail.
//
// After CIRCUIT_THRESHOLD consecutive open failures this provider declines
// everything for CIRCUIT_COOLDOWN_MS via supports(), so the chain skips it
// instantly and without opening a socket. Any single success resets it.
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60 * 1000;
let consecutiveOpenFailures = 0;
let circuitOpenUntil = 0;

function circuitIsOpen() {
  return Date.now() < circuitOpenUntil;
}

function noteOpenFailure(err) {
  consecutiveOpenFailures++;
  if (consecutiveOpenFailures >= CIRCUIT_THRESHOLD && !circuitIsOpen()) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    console.error(
      `camofox-regal: ${consecutiveOpenFailures} consecutive tab-open failures ` +
      `(last: ${err.message}) -- skipping this provider for ${CIRCUIT_COOLDOWN_MS / 1000}s ` +
      `so requests fall straight through instead of re-paying the timeout.`
    );
  }
}

function noteOpenSuccess() {
  if (circuitOpenUntil) console.error("camofox-regal: back up, resuming normal use.");
  consecutiveOpenFailures = 0;
  circuitOpenUntil = 0;
}

// POST serialization queue -- see fetchViaProvider comment.
//
// Cloudflare's createOrder limit responds to BOTH volume and cadence, and
// volume is much the stronger of the two. Everything measured so far:
//
//   8 POSTs @ 1.5s gap  -> ~2 succeed      (v5.7.3)
//   8 POSTs @ 3s   gap  -> ~3 succeed      (v5.7.8)
//   8 POSTs @ 5s   gap  -> ~3 succeed      (v5.8.1)
//   8 POSTs @ 10s  gap  -> ~3 succeed      (v5.8.2)
//   2 POSTs @ 10s  gap  ->  2 succeed      (v5.8.3, cart sharing)
//   2 POSTs @ 1s   gap  ->  1 succeeds     (v5.8.4 -- too tight)
//
// Read the first four rows and widening the gap looks useless; that was the
// volume ceiling, not a cadence one. Read the last two and cadence clearly
// still matters once volume is under control. Both are true.
//
// 5s is the middle: comfortably inside what worked at 8 POSTs, and it costs
// only (theaters - 1) x 5s now that each theater makes a single POST -- 5s
// for a typical 2-theater search. Don't tune this below ~3s; the 1s attempt
// failed on the second POST of two.
//
// Note that consecutive searches share the window. Two searches a few
// seconds apart draw from the same budget, so an abandoned search still
// spends POSTs against the next one (see the no-disconnect-handler issue).
const POST_GAP_MS = 5000;
let postQueueTail = Promise.resolve();
let lastPostAt = 0;

function isConfigured() {
  return (
    !!process.env.CAMOFOX_URL &&
    !!process.env.CAMOFOX_USER_ID &&
    !!process.env.CAMOFOX_SESSION_KEY
  );
}

function baseParams() {
  return {
    userId: process.env.CAMOFOX_USER_ID,
    sessionKey: process.env.CAMOFOX_SESSION_KEY,
  };
}

async function openRegalTab() {
  const res = await fetch(`${process.env.CAMOFOX_URL}/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...baseParams(),
      url: REGAL_BASE,
      waitUntil: "networkidle",
    }),
    timeout: 45000,
  });
  if (!res.ok) throw new Error(`camofox-regal: openTab HTTP ${res.status}`);
  const { tabId } = await res.json();
  if (!tabId) throw new Error("camofox-regal: openTab returned no tabId");
  console.error(`camofox-regal: opened tab ${tabId} at ${REGAL_BASE}`);
  return tabId;
}

async function closeTab(tabId) {
  try {
    await fetch(`${process.env.CAMOFOX_URL}/tabs/${tabId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseParams()),
      timeout: 5000,
    });
  } catch {
    // best-effort
  }
}

// Closes idle tabs that have aged out. Only touches FREE tabs -- a busy one is
// mid-request and its owner will release it.
let reaperTimer = null;
function startReaper() {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    for (let i = freeTabs.length - 1; i >= 0; i--) {
      if (freeTabs[i].expiresAt > now) continue;
      const [dead] = freeTabs.splice(i, 1);
      liveTabCount--;
      closeTab(dead.id);
    }
    if (liveTabCount === 0) {
      clearInterval(reaperTimer);
      reaperTimer = null;
    }
  }, REAP_INTERVAL_MS);
  // Never hold the process open just to sweep tabs.
  if (reaperTimer.unref) reaperTimer.unref();
}

function takePermit() {
  if (permits > 0) { permits--; return Promise.resolve(); }
  return new Promise((resolve) => permitWaiters.push(resolve));
}

// Hands the permit straight to the next waiter rather than incrementing and
// letting it race -- otherwise a burst can oversubscribe the pool.
function givePermit() {
  const next = permitWaiters.shift();
  if (next) next();
  else permits++;
}

// Returns a tab record the caller owns until it calls releaseTab().
async function acquireTab() {
  await takePermit();
  try {
    const now = Date.now();
    while (freeTabs.length > 0) {
      const rec = freeTabs.pop();
      if (rec.expiresAt > now) return rec;
      liveTabCount--;
      closeTab(rec.id); // expired -- fire-and-forget cleanup
    }
    let openedId;
    try {
      openedId = await openRegalTab();
      noteOpenSuccess();
    } catch (err) {
      noteOpenFailure(err);
      throw err;
    }
    const rec = { id: openedId, expiresAt: Date.now() + TAB_TTL_MS };
    liveTabCount++;
    startReaper();
    console.error(`camofox-regal: tab pool now ${liveTabCount}/${POOL_SIZE} open`);
    return rec;
  } catch (err) {
    givePermit(); // never strand a permit on a failed open
    throw err;
  }
}

// discard: the tab is believed unusable (gone, or wedged), so drop it rather
// than parking it for the next caller to trip over.
function releaseTab(rec, { discard = false } = {}) {
  if (discard) {
    liveTabCount--;
    if (rec.id) closeTab(rec.id);
  } else {
    rec.expiresAt = Date.now() + TAB_TTL_MS; // TTL refreshes on use
    freeTabs.push(rec);
  }
  givePermit();
}

// A tab that vanished (Camofox restart, its own idle timeout) or that returns
// a server error is worth replacing and retrying once. The 500 case is not
// theoretical -- `evaluate HTTP 500` showed up in production logs and, with a
// single tab, took the whole request down to the next (paid) provider.
function isTabUnusable(message) {
  return /tab.*not.*found|no.*tab|evaluate.*404|evaluate HTTP 5\d\d/i.test(message);
}

// Execute a fetch() call from within the browser tab's CF-cleared context.
// expression must be a complete JS expression that resolves to the response
// object. We wrap it in an async IIFE so await works and Firefox doesn't
// throw "cross-compartment wrapper" errors from plain .then() chains.
async function evaluate(tabId, expression) {
  const res = await fetch(`${process.env.CAMOFOX_URL}/tabs/${tabId}/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...baseParams(), expression }),
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`camofox-regal: evaluate HTTP ${res.status}`);
  return res.json(); // { ok, result }
}

// Build the JS expression that fetch()es the target URL from inside the tab.
// options mirrors the node-fetch API: { method, body, headers }.
function buildFetchExpression(targetUrl, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const initParts = [`method: ${JSON.stringify(method)}`];
  if (options.headers && Object.keys(options.headers).length > 0) {
    initParts.push(`headers: ${JSON.stringify(options.headers)}`);
  }
  if (method === "POST" && options.body) {
    initParts.push(`body: ${JSON.stringify(options.body)}`);
  }
  const init = initParts.length > 0 ? `{ ${initParts.join(", ")} }` : "{}";
  return `(async () => {
    const r = await fetch(${JSON.stringify(targetUrl)}, ${init});
    const text = await r.text();
    return { status: r.status, ok: r.ok, body: text };
  })()`;
}

// fetchViaProvider implements the proxy provider interface.
// Returns a response-like object with ok, status, text(), json().
async function fetchViaProvider(targetUrl, options = {}) {
  const method = (options.method || "GET").toUpperCase();

  // POST (createOrder): serialized with POST_GAP_MS between calls. If CF
  // challenges start reappearing, count the POSTs per search FIRST -- volume
  // is the stronger lever and a regression there (something reintroducing a
  // per-showtime cart) will not be fixed by widening the gap. See the
  // measurement table above POST_GAP_MS.
  if (method === "POST") {
    const result = postQueueTail.then(async () => {
      const wait = POST_GAP_MS - (Date.now() - lastPostAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastPostAt = Date.now();
      return doEvaluate(targetUrl, options);
    });
    postQueueTail = result.catch(() => {});
    return result;
  }

  return doEvaluate(targetUrl, options);
}

async function doEvaluate(targetUrl, options = {}) {
  // On first failure due to a stale/wedged tab, replace it and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    let rec = null;
    try {
      rec = await acquireTab();
      const expr = buildFetchExpression(targetUrl, options);
      const { ok: evalOk, result } = await evaluate(rec.id, expr);

      if (!evalOk || !result) {
        // evaluate call itself failed (Camofox-level error, not target 4xx/5xx)
        throw new Error(`camofox-regal: evaluate returned ok=false for ${targetUrl.split("?")[0]}`);
      }

      const { status, body } = result;

      // Safety net: if a GET somehow gets CF-challenged, fall through without
      // invalidating the tab (the tab itself is fine; CF challenged a specific
      // request, not the session).
      if (body && body.includes("Just a moment...")) {
        console.error(
          `camofox-regal: Cloudflare challenge on ${targetUrl.split("?")[0]} ` +
          `(status ${status}) -- falling through to next provider`
        );
        throw new Error(`camofox-regal: Cloudflare challenge (status ${status}) -- falling through`);
      }

      releaseTab(rec); // back to the pool, TTL refreshed
      rec = null;

      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status >= 200 && status < 300 ? "OK" : `HTTP ${status}`,
        headers: { get: () => null },
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    } catch (err) {
      const unusable = isTabUnusable(err.message);
      // A Cloudflare challenge is a verdict on the request, not the tab (see
      // the note above), so that tab goes back to the pool intact.
      if (rec) releaseTab(rec, { discard: unusable });
      if (attempt === 0 && unusable) {
        console.error(`camofox-regal: tab unusable (${err.message}), replacing...`);
        continue;
      }
      throw err;
    }
  }
}

// This provider is Regal-only, by construction: its tab is parked on
// regmovies.com and every request runs as a fetch() from inside that page.
// Anything else is cross-origin, so the browser rejects it and Camofox
// reports `evaluate HTTP 500`. Landmark pricing was doing exactly that on
// every call -- failing here first, then falling through to a real provider
// with most of its 10s budget already gone.
function supports(targetUrl) {
  // Declining while the circuit is open is what makes the skip free: the chain
  // moves on without opening a socket to a host that is already known down.
  if (circuitIsOpen()) return false;
  try {
    // Exact host or a real subdomain -- a bare endsWith would also match
    // "evilregmovies.com".
    const host = new URL(targetUrl).hostname;
    return host === "regmovies.com" || host.endsWith(".regmovies.com");
  } catch {
    return false;
  }
}

// No per-request credit cost -- Camofox is self-hosted.
function readCreditCost() {
  return 0;
}

function looksLikeQuotaExceeded() {
  return false; // no quota
}

module.exports = { NAME, isConfigured, supports, fetchViaProvider, readCreditCost, looksLikeQuotaExceeded };
