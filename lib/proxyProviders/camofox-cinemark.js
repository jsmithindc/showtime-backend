const { createCamofoxProvider } = require("./camofox-factory");

// Cinemark's TicketSeatMap pages are Cloudflare-fronted, and as of 2026-09-03
// Render's datacenter IP is challenged outright: the failure moved from HTTP
// 429 (a real rate limit, where 14 of 18 showtimes still priced) to a
// challenge served as HTTP 200 on the FIRST request of a search, with all ~20
// failing. Pacing could not clear that, because it is an IP-reputation verdict
// rather than a verdict on request rate.
//
// Camofox runs on a residential connection -- which is precisely why Regal
// works from the same host while Cinemark, the one chain still going direct
// from Render, does not.
//
// postGapMs is small rather than Regal's 5s: everything here is a GET (the
// seat map is a page fetch), so no POST volume limit has ever been measured
// for Cinemark and inheriting Regal's would be cargo-culting a number.
module.exports = createCamofoxProvider({
  name: "camofox-cinemark",
  base: "https://www.cinemark.com",
  host: "cinemark.com",
  postGapMs: 1000,
  // Two at a time inside each batch. The seat map is a full HTML page, not
  // Regal's small JSON: ten in parallel from one tab exhausted the browser's
  // per-origin connections and only 12 of ~19 priced, the rest returning
  // NetworkError/aborted. Still ONE evaluate round trip per batch -- this
  // limits concurrency within it, not the batching itself.
  batchConcurrency: 2,
  // ...and a gap between them. Lanes alone still drew 429 challenges on
  // TicketSeatMap even from the residential IP -- the tab-location probe
  // confirmed the tab was on the real cinemark.com homepage, so this is the
  // endpoint's own rate limit rather than reputation. Costs no extra round
  // trips: the whole batch is still one evaluate.
  batchGapMs: 400,
});
