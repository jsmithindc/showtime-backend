const fetch = require("node-fetch");
const scrapedo = require("./scrapedo");
const zenrows = require("./zenrows");

// Ordered by preference. Temporarily ZenRows first, Scrape.do second --
// Scrape.do is down to 5 real credits (confirmed from the account
// dashboard), below the cost of even a single listing call (25
// credits), so every Regal search right now would hit it and immediately
// fail on the first request. Rather than rely on the quota-exceeded
// fallback logic (never verified against a real exhausted account -- see
// looksLikeQuotaExceeded in scrapedo.js), just skip straight to the
// provider that can actually complete the request. Swap this order back
// once Scrape.do has real balance again, or just leave it -- ZenRows'
// free tier is more generous anyway.
const ALL_PROVIDERS = [zenrows, scrapedo];

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
      "No proxy provider is configured -- set SCRAPEDO_TOKEN and/or ZENROWS_API_KEY in start.sh"
    );
  }

  let lastError = null;
  for (const provider of providers) {
    try {
      const url = provider.buildUrl(targetUrl, options);
      const res = await fetch(url, {
        method: options.method || "GET",
        headers: options.headers,
        body: options.body,
      });

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
