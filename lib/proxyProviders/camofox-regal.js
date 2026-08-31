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
// A single regmovies.com tab is kept open and reused across calls (lazy
// open, TTL-refreshed). If the tab disappears (Camofox restart, TTL), it
// is transparently recreated on the next request.
//
// Required env vars:
//   CAMOFOX_URL         -- e.g. https://camofox.flimcrickets.com
//   CAMOFOX_USER_ID     -- arbitrary shared secret (namespaces sessions)
//   CAMOFOX_SESSION_KEY -- second auth param required by Camofox API

const REGAL_BASE = "https://www.regmovies.com";
// Keep the tab alive as long as requests come in regularly. Camofox's
// own idle timeout is longer, but we recreate proactively at 20 min.
const TAB_TTL_MS = 20 * 60 * 1000;

let activeTabId = null;
let tabExpiresAt = 0;
// Mutex: if a tab-open is in progress, subsequent callers wait for the same
// promise rather than opening a second tab in parallel.
let tabOpeningPromise = null;

// POST serialization queue -- see fetchViaProvider comment.
const POST_GAP_MS = 10000;
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

async function ensureTab() {
  if (activeTabId && Date.now() < tabExpiresAt) return activeTabId;
  // If another concurrent caller is already opening a tab, wait for it.
  if (tabOpeningPromise) return tabOpeningPromise;
  tabOpeningPromise = (async () => {
    try {
      if (activeTabId) {
        closeTab(activeTabId); // fire-and-forget old tab cleanup
        activeTabId = null;
      }
      activeTabId = await openRegalTab();
      tabExpiresAt = Date.now() + TAB_TTL_MS;
      return activeTabId;
    } finally {
      tabOpeningPromise = null;
    }
  })();
  return tabOpeningPromise;
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

  // POST (createOrder): serialize with a gap between calls to avoid CF rate-limiting.
  // 1.5s gaps (v5.7.3) were too short -- CF still challenged after ~2 calls.
  // Trying 3s. With 6 showtimes that's ~15s total, still well under Bright Data's
  // current ~60s timeout. Falls through to Bright Data if CF challenges anyway.
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
  // On first failure due to stale/missing tab, recreate and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    let tabId;
    try {
      tabId = await ensureTab();
      const expr = buildFetchExpression(targetUrl, options);
      const { ok: evalOk, result } = await evaluate(tabId, expr);

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

      tabExpiresAt = Date.now() + TAB_TTL_MS; // refresh TTL on success

      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status >= 200 && status < 300 ? "OK" : `HTTP ${status}`,
        headers: { get: () => null },
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    } catch (err) {
      if (attempt === 0 && /tab.*not.*found|no.*tab|evaluate.*404/i.test(err.message)) {
        console.error(`camofox-regal: tab gone (${err.message}), recreating...`);
        activeTabId = null;
        tabExpiresAt = 0;
        continue;
      }
      throw err;
    }
  }
}

// No per-request credit cost -- Camofox is self-hosted.
function readCreditCost() {
  return 0;
}

function looksLikeQuotaExceeded() {
  return false; // no quota
}

module.exports = { NAME, isConfigured, fetchViaProvider, readCreditCost, looksLikeQuotaExceeded };
