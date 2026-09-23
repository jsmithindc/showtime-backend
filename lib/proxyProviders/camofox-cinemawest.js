const { createCamofoxProvider } = require("./camofox-factory");

// Cinema West's site (web.cinemawest.com) is Cloudflare-fronted and 403s
// Render's datacenter IP on the token page -- every search, from the day the
// adapter shipped. The same page answers 200 with a live gasToken from a
// residential browser (confirmed 2026-09-22), which is what a Camofox tab is.
//
// host is the bare domain so the API on digital-api.cinemawest.com (a Vista
// host, also on Cloudflare's network) passes supports() too. From a tab on
// web.cinemawest.com that API is a CORS-permitted cross-origin call -- exactly
// how the site's own JS reaches it, confirmed with the Authorization header's
// preflight included.
//
// Everything here is a GET, and a search touches one theater sequentially, so
// the defaults are left alone.
module.exports = createCamofoxProvider({
  name: "camofox-cinemawest",
  base: "https://web.cinemawest.com",
  host: "cinemawest.com",
  postGapMs: 1000,
});
