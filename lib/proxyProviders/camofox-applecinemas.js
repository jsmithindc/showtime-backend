const { createCamofoxProvider } = require("./camofox-factory");

// Apple Cinemas' API is Cloudflare-fronted: every call 403s with a challenge
// from a datacenter IP, confirmed against both robots.txt and the schedule
// endpoint from this project's sandbox. The real browser session carries a
// cf_clearance cookie, which is exactly what a Camofox tab has.
//
// Everything here is a GET of small JSON, so it batches like Regal rather than
// needing Cinemark's lanes-and-gap treatment. Left at the defaults until a real
// run says otherwise.
module.exports = createCamofoxProvider({
  name: "camofox-applecinemas",
  base: "https://www.applecinemas.com",
  host: "applecinemas.com",
  postGapMs: 1000,
});
