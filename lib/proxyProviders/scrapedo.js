const fetch = require("node-fetch");

const NAME = "scrape.do";

function isConfigured() {
  return !!process.env.SCRAPEDO_TOKEN;
}

function buildUrl(targetUrl, { needsRender } = {}) {
  const token = process.env.SCRAPEDO_TOKEN;
  const encoded = encodeURIComponent(targetUrl);
  const renderParam = needsRender ? "&render=true" : "";
  return `https://api.scrape.do/?token=${token}&url=${encoded}&geoCode=us&super=true${renderParam}`;
}

// Scrape.do is a literal HTTP proxy -- whatever method/headers/body the
// caller wants sent to targetUrl just gets relayed verbatim once the
// caller fetches this wrapped URL. So fetchViaProvider here is just
// buildUrl + a plain fetch with the original options passed straight
// through, unlike Firecrawl (see firecrawl.js), which can't work this
// way at all since it's a fixed-endpoint API wrapper, not a proxy.
async function fetchViaProvider(targetUrl, options = {}) {
  const url = buildUrl(targetUrl, options);
  return fetch(url, {
    method: options.method || "GET",
    headers: options.headers,
    body: options.body,
  });
}

// CONFIRMED real, live: Scrape.do reports the exact credit cost of every
// request in this response header. Verified against a real screenshot of
// their own dashboard log this session -- getShowtimes (super+render) =
// 25, createOrder/getTicketsForSession (super only) = 10 each, matching
// this header exactly.
function readCreditCost(res) {
  const raw = res.headers.get("scrape.do-request-cost");
  if (raw == null) return null;
  const cost = Number(raw);
  return Number.isNaN(cost) ? null : cost;
}

// CONFIRMED from a real live log, not just the standard convention
// anymore: once this Scrape.do account was genuinely out of real
// credits, it returned repeated 401 Unauthorized -- NOT 402 Payment
// Required, which is what this function was previously only watching
// for. That's a real, observed gap: every Regal pricing attempt in that
// log died on Scrape.do's 401 and NEVER rotated to Apify or Firecrawl,
// because fetchWithRotation only treats a response as "try the next
// provider" when looksLikeQuotaExceeded returns true -- a 401 was
// treated as a normal (if unsuccessful) response, so the caller threw
// its own error instead of the rotation loop moving on. Each retry
// attempt re-tries the full provider list from the top, so this
// repeated on every single performance without ever reaching the two
// newer, untested providers.
function looksLikeQuotaExceeded(res) {
  return res.status === 402 || res.status === 429 || res.status === 401;
}

module.exports = { NAME, isConfigured, buildUrl, fetchViaProvider, readCreditCost, looksLikeQuotaExceeded };
