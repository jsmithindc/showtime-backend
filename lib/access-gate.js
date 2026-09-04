// Two independent protections for an app that deliberately has NO password.
//
// The point of this app is that a friend can use it from a link, so a login
// prompt would defeat it. But it spends real money per search (SerpApi,
// Firecrawl credits, Geoapify, OMDb) and, since moving to a clean hostname on
// a shared domain, it is far more discoverable than an unlinked onrender.com
// URL ever was. robots.txt and a noindex meta keep it out of search results;
// these two cover what those can't.
//
//   createAccessGate   WHO gets in -- an unguessable key carried in the link
//   createDailyBudget  HOW MUCH gets spent in total, whoever is asking
//
// They are deliberately separate. The first fails if a link is forwarded; the
// second holds regardless, because it caps the total rather than the person.
// Both are inert when their env var is unset, so the default is the current
// behaviour: wide open.

const crypto = require("crypto");

const COOKIE_NAME = "stf_access";
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// The cookie holds a hash, not the key. Same access either way -- anyone
// holding the cookie is in -- but the raw secret is then not sitting in
// devtools or a screenshot, and rotating ACCESS_KEY invalidates every cookie
// for free, since the stored hash simply stops matching.
function tokenFor(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 32);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const DENIED_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Showtime Finder</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#14121a;color:#f4efe6;font-family:Georgia,serif;text-align:center;padding:24px}
  h1{color:#e2a545;font-size:24px;font-weight:normal;margin:0 0 10px}
  p{color:#b8ada0;font-size:15px;line-height:1.55;margin:0;max-width:34em}
</style>
<h1>Showtime Finder</h1>
<p>This one's invite-only — ask for the link and you'll be let straight in.</p>`;

/**
 * Access by capability link: /?k=<ACCESS_KEY> once, then a cookie.
 *
 * The friction lands on the sharer once rather than on every visitor forever,
 * which is the whole reason this is preferred to a password here: the link is
 * already the thing being shared, so the key rides along for free.
 *
 * robots.txt stays exempt on purpose. RFC 9309 says a 4xx on robots.txt lets a
 * crawler assume NO restrictions -- so gating it would invert its meaning and
 * invite exactly the crawling it exists to prevent.
 */
function createAccessGate({ key, exempt = ["/robots.txt"] } = {}) {
  if (!key) return function accessGateDisabled(req, res, next) { next(); };
  const token = tokenFor(key);

  return function accessGate(req, res, next) {
    if (exempt.includes(req.path)) return next();
    if (sameSecret(readCookie(req, COOKIE_NAME), token)) return next();

    const offered = typeof req.query.k === "string" ? tokenFor(req.query.k) : null;
    if (sameSecret(offered, token)) {
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,          // nothing in the page needs to read it
        sameSite: "lax",         // so following the link from a chat app works
        secure: !!req.secure,    // set on https; stays unset for local http
        maxAge: COOKIE_MAX_AGE_MS,
      });
      // Redirect so the key doesn't linger in the address bar, in history, or
      // in whatever the visitor pastes to the next person. Other query params
      // are preserved -- the key is the only one removed.
      const url = new URL(req.originalUrl, "http://placeholder");
      url.searchParams.delete("k");
      return res.redirect(302, url.pathname + url.search);
    }

    // Deliberately says nothing about what would work. An API caller gets
    // JSON so a failed fetch reports something intelligible.
    if (req.path.startsWith("/api/")) {
      return res.status(403).json({ error: "This instance is invite-only." });
    }
    return res.status(403).type("html").send(DENIED_PAGE);
  };
}

function nextMidnight(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/**
 * A ceiling on total spend, across everyone.
 *
 * The per-IP limiter in server.js caps one visitor; it cannot cap a hundred,
 * or one visitor on a hundred addresses. This bounds the worst case outright,
 * which is the protection that still holds if a link leaks.
 *
 * Resets at local midnight rather than on a rolling window -- unlike the
 * per-IP limiter -- because a budget you cannot predict the reset of is one
 * you cannot reason about, and the daily provider quotas it protects (OMDb's
 * 1000/day, the midnight-TTL caches) roll over the same way.
 */
function createDailyBudget({ limit, onTrip } = {}) {
  if (!limit || limit <= 0) {
    const noop = function dailyBudgetDisabled(req, res, next) { next(); };
    noop.usage = () => ({ used: 0, limit: 0, resetsAt: null });
    return noop;
  }
  let used = 0;
  let resetsAt = nextMidnight();
  let warned = false;

  const mw = function dailyBudget(req, res, next) {
    const now = Date.now();
    if (now >= resetsAt) { used = 0; resetsAt = nextMidnight(now); warned = false; }

    if (used >= limit) {
      if (!warned && onTrip) { onTrip({ used, limit, resetsAt }); warned = true; }
      const minutes = Math.ceil((resetsAt - now) / 60000);
      // 503 rather than the per-IP limiter's 429: this is a service-side
      // ceiling, not a verdict on the caller, and the logs should say which.
      return res.status(503).json({
        error: `Showtime Finder has hit its daily search budget. It resets in about ${minutes} minutes.`,
      });
    }
    used += 1;
    next();
  };
  mw.usage = () => ({ used, limit, resetsAt });
  return mw;
}

module.exports = { createAccessGate, createDailyBudget, tokenFor, nextMidnight, COOKIE_NAME };
