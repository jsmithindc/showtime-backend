// Maps a theater name (as it comes back from Overpass/OSM) to Regal's own
// 4-digit theater code, which the scraper needs to hit the right endpoint.
//
// HOW TO FILL THIS IN (one-time, per theater, ~30 seconds each):
//   1. Go to regmovies.com/theatres
//   2. Search/find the theater
//   3. Its URL looks like regmovies.com/theatres/regal-village-park-0147
//   4. The last 4 digits (0147 above) are the code you need
//
// Only theaters listed here get real Regal pricing -- anything not in this
// map just keeps whatever SerpApi returned (usually null).
module.exports = {
  "Regal La Habra Stadium 16": "0704",
  "Regal Yorba Linda & IMAX": "1430",
  // "Brea Edwards Cinema" in Overpass/OSM is actually Regal Edwards Brea
  // East -- OSM just tags it generically. Code confirmed directly from
  // its regmovies.com URL: regal-edwards-brea-east-1028.
  "Brea Edwards Cinema": "1028",
  // Same pattern: "Edwards Cerritos Stadium 10" in OSM is actually Regal
  // Edwards Cerritos. Code confirmed earlier this project from a real
  // regmovies.com URL (regal-edwards-cerritos-1018) during the CA
  // theater list build -- this OSM name just never got its own static
  // entry, so it fell through the CA auto-lookup's proximity match
  // (likely just outside the match radius) and got excluded entirely.
  "Edwards Cerritos Stadium 10": "1018",
  // Both of these were CONFIRMED being silently dropped from real
  // searches: they showed up in the "Skipping SerpApi entirely for
  // theater(s) not in our known chain set" log alongside genuinely
  // non-chain theaters (Krikorian, Starlight, Paramount Drive-in), so
  // they looked like correct exclusions rather than the bug they were.
  // Root cause: they're absent from this static map, and the CA
  // proximity auto-lookup that would otherwise have caught them can't
  // run at all because lib/regal-theaters-ca.js has never been
  // generated -- leaving no path by which they'd ever be recognized as
  // Regal. Adding them statically fixes them independently of whether
  // the generated CA list ever gets built.
  //
  // Codes confirmed from real regmovies.com URLs, the documented method
  // above: regal-garden-grove-0364 and regal-edwards-long-beach-1042.
  // Note the second one's OSM name still uses the old Edwards branding
  // ("Edwards Long Beach Stadium 26 & IMAX") while Regal itself now
  // calls it Regal Edwards Long Beach -- the same OSM-lags-rebranding
  // pattern already seen with Brea and Cerritos above.
  "Regal Garden Grove": "0364",
  "Edwards Long Beach Stadium 26 & IMAX": "1042",
  // Geoapify returns old stadium-style names for these two Inland Empire
  // theaters -- OSM hasn't caught up to the Regal/Edwards rebrand. Codes
  // from regmovies.com URLs: regal-edwards-corona-crossings-rpx-0665 and
  // regal-edwards-eastvale-gateway-1916.
  "Edwards Stadium 14 Theatres": "0665",
  // Edwards Stadium 18 has badly wrong OSM coordinates (33.82, -117.51)
  // that put it ~9 miles from its real location -- far enough that it
  // gets filtered out by the distanceMin <= radiusMin check even when the
  // user is right next door. Real location confirmed from Google Maps /
  // Regal's own site: Eastvale Gateway, ~33.975, -117.567. Stored as an
  // object so server.js can override the OSM coordinates before the
  // distance filter runs.
  "Edwards Stadium 18 Theatre": { code: "1916", lat: 33.9747067, lng: -117.566541 },
};
