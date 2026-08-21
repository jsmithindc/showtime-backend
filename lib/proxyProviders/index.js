const scrapedo = require("./scrapedo");
const zenrows = require("./zenrows");
const firecrawl = require("./firecrawl");
const apifyCfBypass = require("./apify-cfbypass");
const brightdata = require("./brightdata");

// Ordered by preference. Bright Data goes FIRST -- architecturally the
// strongest-fit provider found this session: its own documented schema
// has explicit `method`/`data` fields for relaying an arbitrary request
// to the target (confirmed from their own docs, a GitHub reference
// implementation, and an independent OpenAPI spec, all agreeing), unlike
// Firecrawl (no method/body relay at all) or apify-cfbypass (needed a
// whole browser-session workaround to send a POST). If it works as
// documented, it should also be meaningfully faster than apify-cfbypass,
// which spins up a real browser container per call.
//
// Real credentials confirmed working (a live test against Bright Data's
// own test endpoint returned real content) -- but createOrder against
// Regal specifically, and whether the outer response's status code
// correctly reflects the target's real status, are NOT yet confirmed.
// See the long comment in brightdata.js. First real search through this
// build is the actual test.
//
// apify-cfbypass second: the one provider CONFIRMED, from a real
// captured response, to have cleared Regal's createOrder step
// end-to-end. If Bright Data can't do it (or gets something subtly
// wrong, like the status-passthrough question above), this is what
// catches the request instead of the search failing outright.
//
// Firecrawl third: still real and still usable for the GET-only steps,
// just no longer the first thing tried now that two stronger-fit
// options exist ahead of it.
//
// Apify's Super Scraper (the old apify.js) is REMOVED from this list
// entirely, not just deprioritized -- confirmed blocked by Regal's own
// bot detection (real 403s in that actor's own log), and there's no
// remaining reason to keep spending an attempt on it.
//
// ZenRows and Scrape.do last: genuinely exhausted for the month, not
// removed in case a trickle of credits appears (e.g. a free-tier
// monthly reset).
const ALL_PROVIDERS = [brightdata, apifyCfBypass, firecrawl, zenrows, scrapedo];

function configuredProviders() {
  return ALL_PROVIDERS.filter((p) => p.isConfigured());
}

// In-memory usage log, resets on server restart. Not persisted to disk --
// this project already surfaces real per-search credit usage in the API
// response (see server.js), which is the more actionable place to watch
// it. This log exists mainly for the cross-provider breakdown.
const usageLog = [];

function recordUsage(providerName, credits) {
  usageLog.push({ provider: providerName, credits, timestamp: Date.now() });
}

function getUsageSummary() {
  const byProvider = {};
  for (const entry of usageLog) {
    byProvider[entry.provider] = (byProvider[entry.provider] || 0) + entry.credits;
  }
  return byProvider;
}

// Fetches a URL through whichever configured provider is next in line,
// falling through to the next one if the current provider's quota looks
// exhausted or the request otherwise fails. Returns { res, provider,
// creditsUsed } -- callers use res exactly like a normal fetch response
// (res.ok, res.text(), res.json(), etc.), and creditsUsed/provider for
// logging/accounting.
async function fetchWithRotation(targetUrl, options = {}) {
  const providers = configuredProviders();
  if (providers.length === 0) {
    throw new Error(
      "No proxy provider is configured -- set SCRAPEDO_TOKEN, ZENROWS_API_KEY, APIFY_API_TOKEN, FIRECRAWL_API_KEY, and/or BRIGHTDATA_API_KEY+BRIGHTDATA_ZONE in start.sh"
    );
  }

  let lastError = null;
  for (const provider of providers) {
    try {
      // Each provider now fully owns how it makes its own request --
      // NOT just "return a URL for the caller to generically fetch."
      // That change was necessary to support Firecrawl, which is a
      // fixed-endpoint API wrapper rather than a literal HTTP proxy
      // like Scrape.do/ZenRows -- see the comment on ALL_PROVIDERS
      // above and the long comment in firecrawl.js for why.
      const res = await provider.fetchViaProvider(targetUrl, options);

      if (provider.looksLikeQuotaExceeded(res)) {
        console.error(
          `${provider.NAME}: quota appears exhausted (HTTP ${res.status}) -- trying the next configured provider.`
        );
        lastError = new Error(`${provider.NAME} quota exhausted (HTTP ${res.status})`);
        continue;
      }

      const creditsUsed = provider.readCreditCost(res);
      if (creditsUsed == null) {
        console.error(
          `${provider.NAME}: couldn't read a real credit cost from the response -- usage tracking for this request will under-report.`
        );
      }
      recordUsage(provider.NAME, creditsUsed ?? 0);

      return { res, provider: provider.NAME, creditsUsed: creditsUsed ?? 0 };
    } catch (err) {
      console.error(`${provider.NAME} request failed:`, err.message);
      lastError = err;
      // fall through to the next provider
    }
  }

  throw new Error(
    `All configured proxy providers failed or exhausted their quota. Last error: ${lastError?.message}`
  );
}

module.exports = { fetchWithRotation, getUsageSummary, configuredProviders };
