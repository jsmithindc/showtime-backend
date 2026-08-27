const scrapedo = require("./scrapedo");
const zenrows = require("./zenrows");
const firecrawl = require("./firecrawl");
const apifyCfBypass = require("./apify-cfbypass");
const brightdata = require("./brightdata");
const byparr = require("./byparr");
const camofoxRegal = require("./camofox-regal");

// Ordered by preference.
//
// Camofox-Regal FIRST: uses Camofox's evaluate endpoint to run fetch() inside
// a real browser tab that already has a cleared Cloudflare session at
// regmovies.com. createOrder returns in ~0.5s (vs Bright Data's 20s async
// poll). No per-request credit cost. Self-hosted. Only active when
// CAMOFOX_URL + CAMOFOX_USER_ID + CAMOFOX_SESSION_KEY are set.
//
// Byparr second: self-hosted FlareSolverr-compatible Cloudflare bypass.
// Free (no per-request credits), persistent named session. Handles both GET
// and POST with body relay. Only active when BYPARR_URL + BYPARR_SECRET set.
// Note: Byparr visits JSON API endpoints in a real browser, which can return
// HTML (site redirects) instead of raw JSON; throws so the next provider runs.
//
// Bright Data third: architecturally strong (explicit method/body relay).
// Real credentials confirmed working against Bright Data's own test endpoint.
// createOrder against Regal specifically not confirmed end-to-end -- still the
// best paid fallback if Camofox and Byparr are unreachable.
//
// apify-cfbypass fourth: the one PAID provider confirmed, from a real captured
// response, to have cleared Regal's createOrder step end-to-end.
//
// Firecrawl fifth: still real and usable for GET-only steps, but cannot
// relay a POST body so it can never be the sole working provider for Regal.
//
// ZenRows and Scrape.do last: genuinely exhausted for the month, kept in case
// a trickle of credits appears on a free-tier reset.
//
// Apify's Super Scraper (apify.js) is REMOVED entirely -- confirmed blocked
// by Regal's own bot detection (real 403s in that actor's own log).
const ALL_PROVIDERS = [camofoxRegal, byparr, brightdata, apifyCfBypass, firecrawl, zenrows, scrapedo];

// DISABLED_PROXY_PROVIDERS: comma-separated provider names to skip even when
// their credentials are present (use when monthly credits are exhausted).
// e.g. DISABLED_PROXY_PROVIDERS=apify-cfbypass,zenrows,scrape.do
const DISABLED_PROVIDERS = new Set(
  (process.env.DISABLED_PROXY_PROVIDERS || "").split(",").map((s) => s.trim()).filter(Boolean)
);

function configuredProviders() {
  return ALL_PROVIDERS.filter((p) => p.isConfigured() && !DISABLED_PROVIDERS.has(p.NAME));
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
      "No proxy provider is configured -- set CAMOFOX_URL+CAMOFOX_USER_ID+CAMOFOX_SESSION_KEY, BYPARR_URL+BYPARR_SECRET, BRIGHTDATA_API_KEY+BRIGHTDATA_ZONE, APIFY_API_TOKEN, FIRECRAWL_API_KEY, ZENROWS_API_KEY, and/or SCRAPEDO_TOKEN in start.sh"
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
