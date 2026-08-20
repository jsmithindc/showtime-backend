// Maps a theater name (as it comes back from Overpass/OSM) to Cinema
// West's siteId and full URL sitePath. Confirmed real: "Country Club
// Cinema" (OSM name, seen repeatedly in real Sacramento-area searches
// this project) -> siteId 2101, from a real captured request. sitePath
// is the two-segment URL Cinema West's own site uses (confirmed via its
// catch-all route "/sites/[...siteId]" capturing both segments) --
// needed to fetch a live access token (see getFreshToken in
// cinemawest-official.js).
module.exports = {
  "Country Club Cinema": { siteId: "2101", sitePath: "Country-Club-Cinema/2101" },
};
