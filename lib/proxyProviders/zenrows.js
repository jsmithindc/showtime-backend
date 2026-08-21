const fetch = require("node-fetch");

const NAME = "zenrows";

// Confirmed real API shape from ZenRows' own documentation (docs.zenrows.com):
// base URL https://api.zenrows.com/v1/, params url/apikey/premium_proxy/
// js_render/proxy_country. Their own docs quote premium_proxy alone as
// 10 credits and js_render alone as 5 credits, but don't publish an exact
// combined number the way Scrape.do does (one source said premium_proxy
// "consumes 10-25 credits" depending on target) -- so DON'T hardcode an
// assumed combined cost here. Read the real cost from the response
// instead, same principle as the Scrape.do adapter.
function isConfigured() {
  return !!process.env.ZENROWS_API_KEY;
}

function buildUrl(targetUrl, { needsRender } = {}) {
  const apikey = process.env.ZENROWS_API_KEY;
  const params = new URLSearchParams({
    url: targetUrl,
    apikey,
    premium_proxy: "true",
    proxy_country: "us",
  });
  if (needsRender) params.set("js_render", "true");
  return `https://api.zenrows.com/v1/?${params.toString()}`;
}

// Same literal-HTTP-proxy shape as Scrape.do -- see the comment on
// scrapedo.js's fetchViaProvider for why this works here but can't work
// for Firecrawl.
async function fetchViaProvider(targetUrl, options = {}) {
  const url = buildUrl(targetUrl, options);
  return fetch(url, {
    method: options.method || "GET",
    headers: options.headers,
    body: options.body,
  });
}

// CONFIRMED WRONG a second time, via a real ZenRows dashboard log: 3
// Regal theaters, 9 real requests (3 listing calls at 25 credits, 6
// pricing calls at 10 credits each) totaled 135 real credits on
// ZenRows' own dashboard -- this app reported 0.135. Exactly 1000x off,
// the identical precise ratio as the earlier bug, just on a different
// endpoint this time (api.zenrows.com, the one actually used for Regal
// pricing -- not serp.api.zenrows.com, which is where x-request-cost
// was first confirmed to exist as a real header name). Most likely
// explanation: this endpoint reports the SAME header but in a different
// unit -- a fraction (e.g. "0.025" for a 25-credit request) rather than
// a whole credit count. Scaling by 1000 to correct for this, and now
// logging the raw header value on every call (not just failures) so
// this can be verified directly against a real value instead of
// inferred from totals again if it's still off.
function readCreditCost(res) {
  const primary = res.headers.get("x-request-cost");
  if (primary != null) {
    const raw = Number(primary);
    if (!Number.isNaN(raw)) {
      const scaled = raw * 1000;
      console.error(`ZenRows: x-request-cost raw="${primary}" -> scaled to ${scaled} credits (x1000 correction).`);
      return scaled;
    }
  }

  const allHeaders = {};
  res.headers.forEach((value, name) => { allHeaders[name] = value; });
  console.error(
    "ZenRows: x-request-cost header not found or not numeric on this endpoint -- full response headers:",
    JSON.stringify(allHeaders)
  );
  return null;
}

// 401 added alongside 402/429 as a general principle, not (yet)
// independently confirmed for ZenRows specifically -- see scrapedo.js's
// looksLikeQuotaExceeded for the real, live-observed case this was
// added for (that account returned repeated 401s once genuinely out of
// credits, not the expected 402). Reasoning still applies here: a
// persistently-401ing key is just as dead as an explicitly-quota-
// exceeded one, and retrying it will never succeed, so treating it as a
// rotate-away signal is the correct default regardless of which
// specific provider is doing it.
function looksLikeQuotaExceeded(res) {
  return res.status === 402 || res.status === 429 || res.status === 401;
}

module.exports = { NAME, isConfigured, buildUrl, fetchViaProvider, readCreditCost, looksLikeQuotaExceeded };
