const fetch = require("node-fetch");

const NAME = "firecrawl";

// Firecrawl is NOT a literal HTTP proxy like Scrape.do/ZenRows -- it's a
// fixed-endpoint API wrapper. Confirmed from Firecrawl's own current
// docs (docs.firecrawl.dev/api-reference/endpoint/scrape): every call is
// always POST https://api.firecrawl.dev/v2/scrape with an
// "Authorization: Bearer <key>" header and a JSON body describing what
// to scrape (url, formats, proxy mode, etc.), regardless of what method
// the ORIGINAL target request would have used. There is no documented
// field for relaying an arbitrary outbound method/body to the target --
// Firecrawl's schema is built around "give me a URL, get back page
// content," not "make this exact HTTP request for me."
//
// That's a real, structural limitation for this app's use of it:
// getShowtimesForTheater and getTicketsForSession are plain GETs (the
// target URL alone, with query params, is the whole request) -- those
// work fine through Firecrawl. createOrder is a POST with a JSON body
// ({cinemaId}) -- Firecrawl has no way to relay that to the target, so
// fetchViaProvider below deliberately THROWS for any request with a
// body, rather than silently mis-sending Regal's order body to
// Firecrawl's own /v2/scrape endpoint (which would fail confusingly,
// misread as a Firecrawl error rather than an unsupported request
// shape). Throwing here is intentional and compatible with the existing
// fetchWithRotation loop in index.js: a thrown error there just moves
// on to the next configured provider, so Firecrawl naturally
// self-excludes from the one step it can't do, without needing any
// special-casing in the caller.
function isConfigured() {
  return !!process.env.FIRECRAWL_API_KEY;
}

// UNCONFIRMED: the exact allowed values for `proxy` beyond "auto" (the
// only one shown literally in Firecrawl's own schema example). A
// third-party description mentioned "stealth" mode for anti-bot bypass,
// but that's not from Firecrawl's own docs directly -- using "stealth"
// here since Regal's endpoints are Cloudflare-protected and need real
// bypass, but this is the single most likely thing to be wrong if
// Firecrawl starts rejecting requests with a 4xx about this field.
const PROXY_MODE = "stealth";

async function fetchViaProvider(targetUrl, options = {}) {
  const method = options.method || "GET";
  if (options.body) {
    throw new Error(
      `firecrawl: cannot relay a ${method} request with a body -- Firecrawl's API has no field for an ` +
      `arbitrary outbound method/body to the target (confirmed from their own docs schema). This is expected ` +
      `to happen for Regal's createOrder step specifically; falling through to the next configured provider.`
    );
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: targetUrl,
      // rawHtml, not markdown -- the targets here are JSON APIs
      // (Regal's listing/ticket endpoints), not human-readable pages.
      // Firecrawl's markdown conversion is built for the latter and
      // would likely mangle raw JSON; rawHtml is the closest documented
      // option to "give me back what the origin server actually sent."
      // UNCONFIRMED: whether Firecrawl's rendering pipeline passes a
      // non-HTML/JSON response through cleanly at all, since its whole
      // design center is web pages, not API endpoints. This is the
      // single biggest open question about whether Firecrawl can
      // actually replace Scrape.do/ZenRows for this app's real use
      // case -- needs a live test against a real Regal URL to know for
      // sure, not something resolvable from documentation alone.
      formats: ["rawHtml"],
      proxy: PROXY_MODE,
    }),
  });

  // Firecrawl's OWN response is always 200-with-a-success-flag or a real
  // error status -- but the caller (fetchWithRotation) expects a
  // response object shaped like a plain fetch of the TARGET url (i.e.
  // res.text()/res.json() should yield the target's content, not
  // Firecrawl's wrapper envelope). Unwrap that here so this provider is
  // a drop-in for the rest of the pipeline, which was written assuming
  // res.text() returns Regal's raw response body directly.
  if (!res.ok) {
    return res; // let the caller's !res.ok / looksLikeQuotaExceeded handling deal with it
  }

  const json = await res.json();
  if (!json.success) {
    // Wrap Firecrawl's own reported error into something that still
    // behaves like a Response for the caller's !res.ok check.
    return {
      ok: false,
      status: 502,
      statusText: `Firecrawl reported failure: ${json.error || "unknown error"}`,
      headers: res.headers,
      text: async () => JSON.stringify(json),
      json: async () => json,
    };
  }

  const rawContent = json.data?.rawHtml ?? "";
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: res.headers,
    text: async () => rawContent,
    json: async () => JSON.parse(rawContent),
  };
}

// Firecrawl's publicly documented pricing is a flat rate -- 1 credit per
// /scrape call (confirmed consistently across their own site and
// several independent write-ups) -- NOT a per-response header value the
// way Scrape.do/ZenRows report. So unlike those two adapters, this is a
// documented-rate assumption, not something read off the response.
// Flagging that distinction explicitly rather than presenting it with
// the same confidence as a confirmed header value.
function readCreditCost(res) {
  return 1;
}

// 401 added alongside 402/429 as a general principle -- see
// scrapedo.js's looksLikeQuotaExceeded for the real, live-observed case
// (a genuinely exhausted account returned 401, not 402) this pattern
// was added for. Not yet independently confirmed for Firecrawl itself.
function looksLikeQuotaExceeded(res) {
  return res.status === 402 || res.status === 429 || res.status === 401;
}

module.exports = { NAME, isConfigured, fetchViaProvider, readCreditCost, looksLikeQuotaExceeded };
