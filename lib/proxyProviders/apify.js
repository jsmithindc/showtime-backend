const fetch = require("node-fetch");

const NAME = "apify";

// CONFIRMED real shape, straight from the user's own working code
// example against this exact actor:
//   GET https://super-scraper-api.apify.actor/?url=...&...
//   Authorization: Bearer <APIFY_API_TOKEN>
// This is a *.apify.actor "Standby" endpoint, NOT the run-sync-get-
// dataset-items pattern most Apify actors use -- meaningfully different
// and much closer in shape to Scrape.do/ZenRows: base URL + url param +
// auth header, not a fixed JSON envelope like Firecrawl. That matters
// because Super Scraper API "supports most of ScrapingBee's API
// parameters" (the user's own words), and ScrapingBee's own docs
// confirm real proxy behavior: "ScrapingBee proxies forward your HTTP
// method and body to the target site" when you POST directly to their
// endpoint with your own body attached. If Super Scraper genuinely
// mirrors that, it can likely handle Regal's createOrder step (POST
// with a JSON body) -- something Firecrawl categorically cannot do.
// UNCONFIRMED specifically for Super Scraper: whether it mirrors this
// exact forwarding behavior, since "supports most of the parameters"
// doesn't guarantee identical mechanics. Needs a real live test against
// Regal's actual createOrder endpoint to know for sure.
function isConfigured() {
  return !!process.env.APIFY_API_TOKEN;
}

function buildUrl(targetUrl, { needsRender } = {}) {
  const params = new URLSearchParams({ url: targetUrl });
  // Param names CONFIRMED directly from Apify's own actor page
  // (apify.com/apify/super-scraper-api), not just inferred anymore --
  // fetched and read directly. Their docs describe these as ScrapingBee-
  // compatible parameter names that this actor genuinely implements.
  //
  // CONFIRMED REAL BUG, caught reading that same page: render_js
  // DEFAULTS TO TRUE on this actor -- the opposite of what was assumed
  // here. Only ever setting it to "true" when needed, and never setting
  // it to "false" otherwise, meant every single call (including the
  // createOrder/getTickets steps that don't need rendering at all)
  // silently fell back to Apify's own default of true. Their own
  // published pricing table shows this is a real cost difference, not
  // just a performance one: $1/1000 (no render, basic proxy) vs
  // $5/1000 (render + premium proxy) -- up to 5x more expensive than
  // necessary on every call that didn't actually need rendering.
  params.set("render_js", needsRender ? "true" : "false");
  params.set("premium_proxy", "true");
  params.set("country_code", "us");
  return `https://super-scraper-api.apify.actor/?${params.toString()}`;
}

// Literal-HTTP-proxy shape (same as Scrape.do/ZenRows) -- IF Super
// Scraper genuinely mirrors ScrapingBee's method/body forwarding, this
// works unmodified for all three Regal steps including createOrder. If
// it doesn't, createOrder will fail here with a real, visible error
// from Apify's own response rather than silently miscarrying the way a
// wrong assumption about Firecrawl would have -- worth watching the
// first real createOrder attempt through this provider closely.
async function fetchViaProvider(targetUrl, options = {}) {
  const url = buildUrl(targetUrl, options);
  return fetch(url, {
    method: options.method || "GET",
    headers: {
      ...options.headers,
      "Authorization": `Bearer ${process.env.APIFY_API_TOKEN}`,
    },
    body: options.body,
  });
}

// UNCONFIRMED: no known response header reporting real per-request cost
// for this actor specifically (unlike Scrape.do's scrape.do-request-cost
// or ZenRows' x-request-cost). Apify's general pricing model is compute-
// unit-based per actor run, not a flat per-call credit -- so there may
// not be a simple per-request number to read at all. Returning null
// (honest "couldn't determine cost") rather than guessing a flat rate
// the way firecrawl.js does, since Apify's own docs don't support even
// that level of confidence here. Revisit once a real response has
// actually been inspected for cost-related headers.
function readCreditCost(res) {
  return null;
}

// 401 added alongside 402/429 as a general principle -- see
// scrapedo.js's looksLikeQuotaExceeded for the real, live-observed case
// (a genuinely exhausted account returned 401, not 402) this pattern
// was added for. Not yet independently confirmed for Apify itself.
function looksLikeQuotaExceeded(res) {
  return res.status === 402 || res.status === 429 || res.status === 401;
}

module.exports = { NAME, isConfigured, buildUrl, fetchViaProvider, readCreditCost, looksLikeQuotaExceeded };
