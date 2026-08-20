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

// UNCONFIRMED: never actually tested against a genuinely exhausted
// Scrape.do account. 402 (Payment Required) is the standard convention
// across this category of API for "out of credits" -- treating it (and
// 429, standard rate-limit) as a signal to fail over to the next
// provider rather than erroring the whole search out.
function looksLikeQuotaExceeded(res) {
  return res.status === 402 || res.status === 429;
}

module.exports = { NAME, isConfigured, buildUrl, readCreditCost, looksLikeQuotaExceeded };
