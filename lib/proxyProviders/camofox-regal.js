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
const TAB_TTL_MS = 20 * 60 * 1000;

// Tab pool. `permits` bounds how many tabs can exist at once; a caller holding
// a permit is guaranteed room for one. Free tabs are parked in `freeTabs` and
// reused, so a steady stream of requests opens at most POOL_SIZE tabs total.
// 8 measured against a real 5-theater Denver search: 21 pricing calls at ~2s
// each ran ~11s four-wide and ~5-6s eight-wide. Each tab is a real Firefox tab
// on the Camofox host, so this trades that host's RAM for search latency --
// dial it down if that box is tight (1 restores fully-serialized behaviour).
const POOL_SIZE = Math.max(1, Number(process.env.CAMOFOX_TAB_POOL) || 8);
let permits = POOL_SIZE;
const permitWaiters = [];
const freeTabs = [];   // { id, expiresAt }, all idle and believed live
let liveTabCount = 0;  // open tabs, busy or idle -- for logging only

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
    const rec = { id: await openRegalTab(), expiresAt: Date.now() + TAB_TTL_MS };
    liveTabCount++;
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
