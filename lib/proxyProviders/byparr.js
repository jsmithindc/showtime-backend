const fetch = require("node-fetch");

const NAME = "byparr";

// Self-hosted FlareSolverr-compatible Cloudflare bypass running on a local
// LXC, exposed via a Cloudflare Tunnel at BYPARR_URL. An nginx reverse proxy
// sits in front of Byparr on the LXC and requires the X-Byparr-Token header,
// so any request missing it gets a 403 at the edge before reaching Byparr.
//
// FlareSolverr API (POST /v1):
//   GET:  { cmd: "request.get",  url, session? }
//   POST: { cmd: "request.post", url, postData, session? }
//   Response: { status: "ok", solution: { status, response, cookies, ... } }
//   solution.response is always a string (the raw body).
//   solution.status is the target's HTTP status code.
//
// Sessions: Byparr supports named browser sessions that persist Cloudflare
// cookies across requests. Using a fixed session name ("regal") so the
// challenge is only solved once per session lifetime rather than per call.
//
// Required env vars:
//   BYPARR_URL    -- full URL of the tunnel, e.g. https://byparr.flimcrickets.com
//   BYPARR_SECRET -- value of the X-Byparr-Token header checked by nginx

const SESSION_NAME = "regal";
// Byparr/FlareSolverr default session timeout is 15 minutes of inactivity.
// Keep our own TTL slightly under that so we recreate before it expires.
const SESSION_TTL_MS = 12 * 60 * 1000;
let sessionExpiresAt = 0;

function isConfigured() {
  return !!process.env.BYPARR_URL && !!process.env.BYPARR_SECRET;
}

async function callByparr(body) {
  const res = await fetch(`${process.env.BYPARR_URL}/v1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Byparr-Token": process.env.BYPARR_SECRET,
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function ensureSession() {
  if (Date.now() < sessionExpiresAt) return;
  // Create (or re-create) the named session. Byparr ignores this if the
  // session already exists, so it's safe to call unconditionally.
  await callByparr({ cmd: "sessions.create", session: SESSION_NAME });
  sessionExpiresAt = Date.now() + SESSION_TTL_MS;
}

async function fetchViaProvider(targetUrl, options = {}) {
  // Byparr uses a real browser, which is the right tool for Cloudflare-
  // protected endpoints that need JS rendering. For plain JSON API calls
  // (no needsRender flag), a direct HTTP request (Bright Data sync, etc.)
  // is both faster and more correct -- a browser visiting a JSON API
  // endpoint may get the HTML website back instead of the raw JSON.
  if (!options.needsRender) {
    throw new Error("byparr: skipping non-render request (needsRender not set) -- falling through to direct HTTP providers");
  }

  await ensureSession();

  const method = (options.method || "GET").toUpperCase();
  const cmd = method === "POST" ? "request.post" : "request.get";
  const body = {
    cmd,
    url: targetUrl,
    session: SESSION_NAME,
  };
  if (method === "POST" && options.body) {
    body.postData = options.body; // already a JSON string from the caller
  }

  const res = await callByparr(body);

  if (!res.ok) {
    throw new Error(`byparr: /v1 returned HTTP ${res.status} ${res.statusText}`);
  }

  const envelope = await res.json();

  if (envelope.status !== "ok") {
    throw new Error(`byparr: solution status "${envelope.status}" -- ${envelope.message || "(no message)"}`);
  }

  const solution = envelope.solution;
  const bodyText = solution.response ?? "";
  const targetStatus = solution.status ?? 200;

  // Reset session TTL on a successful call -- the session is active.
  sessionExpiresAt = Date.now() + SESSION_TTL_MS;

  // JSON API endpoints visited in a real browser can return the site's HTML
  // (redirect to homepage, auth page, etc.) rather than the raw JSON response.
  // Throw so fetchWithRotation falls through to Bright Data's sync path, which
  // sends a direct HTTP request and gets the actual JSON.
  if (bodyText && bodyText.trimStart().startsWith("<")) {
    throw new Error(
      `byparr: target returned HTML instead of JSON for ${targetUrl.split("?")[0]} ` +
      `(status ${targetStatus}) -- falling through to direct HTTP providers`
    );
  }

  return {
    ok: targetStatus >= 200 && targetStatus < 300,
    status: targetStatus,
    statusText: targetStatus >= 200 && targetStatus < 300 ? "OK" : `HTTP ${targetStatus}`,
    headers: { get: () => null }, // FlareSolverr doesn't relay all headers; callers don't need them
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  };
}

// Byparr is self-hosted -- no credit cost per request.
function readCreditCost() {
  return 0;
}

function looksLikeQuotaExceeded(res) {
  // 403 means our secret header was rejected (nginx gate); treat as a
  // configuration error rather than quota, but fall through so other
  // providers can still handle the request.
  return res.status === 403 || res.status === 429;
}

module.exports = { NAME, isConfigured, fetchViaProvider, readCreditCost, looksLikeQuotaExceeded };
