const { createCamofoxProvider } = require("./camofox-factory");

// Regal's API is Cloudflare-protected and US-geo-restricted. Tabs park on
// regmovies.com so every request runs same-origin from a session that has
// already cleared the challenge, and from the Camofox host's residential IP
// rather than a datacenter one.
//
// postGapMs 5000: Cloudflare's limit here is on POST VOLUME (createOrder),
// which is why sharing one cart per search mattered more than widening the
// gap. See the measurement table in the factory before changing it.
module.exports = createCamofoxProvider({
  name: "camofox-regal",
  base: "https://www.regmovies.com",
  host: "regmovies.com",
  postGapMs: 5000,
});
