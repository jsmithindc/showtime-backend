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
});
