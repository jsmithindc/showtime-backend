// True IMAX 70mm (15/70) film venues in the US.
//
// WHY A CURATED LIST: 15/70 film projection is rare and shrinking -- most IMAX
// screens are digital or laser, and the app already shows an "IMAX" format chip
// that means exactly that. Anyone reaching for the chip expecting film would be
// misled, and there is no API anywhere that distinguishes them, so this is data
// rather than discovery.
//
// SOURCE: Engadget's list of theaters able to play The Odyssey in true 70mm
// (2026). IMAX's own site is the authoritative source but its robots.txt
// carries "User-agent: ClaudeBot / Disallow: /", so it was not scraped.
//
// KNOWN GAP: that article states there are 30 such theaters in the US but names
// 24. The missing 6 are not identified anywhere in it. Treat this list as "the
// venues we can name", not "every venue".
//
// COORDINATES: where a venue belongs to a chain this app already has a theater
// list for, the coordinates come from that list and are exact (16 of 24). The
// rest are geocoded from "name, city, state" and can be city-level -- accurate
// enough to rank by distance, not to navigate to. coordSource records which.
//
// chain/chainCode are set when the venue is one this app can already fetch real
// showtimes and prices for.
//
// COORDINATE ACCURACY, venue by venue. 16 come from the chain's own theater
// list and are exact. Of the 8 geocoded, 7 resolved to the venue itself and
// carry the street in coordSource. ONE did not:
//
//   (none -- all 24 are now venue-level or exact.)
//
// Brenden Palms was the last holdout: name-based queries returned Concord CA,
// the wrong casino, and Natick MA, because it sits inside the Palms Casino
// Resort. Resolved by geocoding its street address (4321 W Flamingo Rd)
// instead, which moved it 4.5mi from the Las Vegas city centroid.
//
// AutoNation/Museum of Discovery is a deliberate exception. Do NOT "correct"
// it to its postal address. IMAX lists the venue at 401 SW 2nd St, Fort
// Lauderdale, FL 33312 -- that address is right, but Geoapify cannot resolve
// it: the string returns 401 Southwest 2nd AVENUE, and reverse-geocoding that
// point gives ZIP 33301. Reverse-geocoding the coordinate stored here gives
// "Museum of Discovery and Science, 401 Himmarshee Street, ... FL 33312" --
// the venue by name, in the ZIP IMAX publishes. Himmarshee Street is the
// historic name for SW 2nd Street in that district. Including the museum's
// name in the query does not help; it still returns the Avenue.
//
// The ZIP is the tell: 33312 matches IMAX, 33301 does not.
//
// Providence went the OTHER way, on the same kind of evidence: the published
// address (10 Providence Place) resolves to "Providence Place Cinemas 16 and
// IMAX" by name, while the earlier query had matched "Providence Place Mall,
// 1 Providence Place" -- the right complex, wrong tenant, 0.07mi off. Taking
// the published address was correct there and wrong in Fort Lauderdale, which
// is the point: check what the coordinate resolves to, don't apply a rule.
//
// Lesson if you extend this: requiring a street in the geocoder response is
// NOT enough validation. "TCL Chinese Theatre" first resolved to a bare point
// on Hollywood Boulevard 2.3mi from the real building, and Brenden to the
// wrong plaza on the right street. Require the returned name to contain the
// venue name, and sanity-check the distance moved.

const IMAX_70MM_VENUES = [
  { name: "Harkins Arizona Mills & IMAX", city: "Tempe", state: "AZ", lat: 33.3857002258301, lng: -111.966003417969, chain: "harkins", chainName: "Arizona Mills 18 w/ IMAX", coordSource: "harkins list" },
  { name: "Regal Hacienda Crossings & IMAX", city: "Dublin", state: "CA", lat: 37.705, lng: -121.886, chain: "regal", chainName: "Hacienda Stadium 20 IMAX & RPX", chainCode: "0347", coordSource: "regal list" },
  { name: "TCL Chinese Theatres IMAX", city: "Hollywood", state: "CA", lat: 34.102073, lng: -118.3409501, coordSource: "geocoded (venue: 6925 Hollywood Blvd)" },
  { name: "Regal Irvine Spectrum & IMAX", city: "Irvine", state: "CA", lat: 33.6512, lng: -117.7444, chain: "regal", chainName: "Irvine Spectrum 20 IMAX & RPX", chainCode: "1010", coordSource: "regal list" },
  { name: "Regal LA Live & IMAX", city: "Los Angeles", state: "CA", lat: 34.0461, lng: -118.267, chain: "regal", chainName: "Regal LA Live", chainCode: "1484", coordSource: "regal list" },
  { name: "Regal Edwards Ontario Palace Stadium & IMAX", city: "Ontario", state: "CA", lat: 34.0767, lng: -117.5486, chain: "regal", chainName: "Ontario Palace 22 IMAX & RPX", chainCode: "1026", coordSource: "regal list" },
  { name: "Esquire IMAX Theatre", city: "Sacramento", state: "CA", lat: 38.5785457, lng: -121.490406, coordSource: "geocoded (venue: 1211 K St)" },
  { name: "AMC Metreon 16 & IMAX", city: "San Francisco", state: "CA", lat: 37.78409516, lng: -122.4036164, chain: "amc", chainName: "AMC Metreon 16", chainCode: "2325", coordSource: "amc list" },
  { name: "Universal Cinema AMC at CityWalk Hollywood & IMAX", city: "Universal City", state: "CA", lat: 34.1370311799, lng: -118.3526099987, chain: "amc", chainName: "Universal Cinema - an AMC Theatre", chainCode: "2416", coordSource: "amc list" },
  { name: "Cinemark Carefree Circle & IMAX", city: "Colorado Springs", state: "CO", lat: 38.8808973, lng: -104.7161451, chain: "cinemark", chainName: "Movie Theater Cimarron Hills Cinemark Carefree Circle IMAX", chainCode: "301", coordSource: "cinemark list" },
  { name: "Regal Colorado Center 9 & IMAX", city: "Denver", state: "CO", lat: 39.6803, lng: -104.9402, chain: "regal", chainName: "Colorado Center Stm 9 & IMAX", chainCode: "1308", coordSource: "regal list" },
  { name: "AutoNation IMAX, Museum of Discovery & Science", city: "Fort Lauderdale", state: "FL", lat: 26.1211083, lng: -80.1479323, coordSource: "geocoded (venue: 401 Himmarshee St)" },
  { name: "Regal Mall of Georgia & IMAX", city: "Buford", state: "GA", lat: 34.0665, lng: -83.9834, chain: "regal", chainName: "Regal Mall of Georgia IMAX", chainCode: "0701", coordSource: "regal list" },
  { name: "Cinemark Seven Bridges & IMAX", city: "Woodridge", state: "IL", lat: 41.7563344, lng: -88.045559, chain: "cinemark", chainName: "Cinemark Seven Bridges and IMAX", chainCode: "276", coordSource: "cinemark list" },
  { name: "IMAX, Indiana State Museum", city: "Indianapolis", state: "IN", lat: 39.7688297, lng: -86.1693361, coordSource: "geocoded (venue: 650 W Washington St)" },
  { name: "Celebration! Cinema Grand Rapids North & IMAX", city: "Grand Rapids", state: "MI", lat: 43.0011934, lng: -85.59339, coordSource: "geocoded (venue: 2121 Celebration Dr NE)" },
  { name: "Brenden Palms 14 & IMAX", city: "Las Vegas", state: "NV", lat: 36.1142332, lng: -115.194245, coordSource: "geocoded (venue: 4321 W Flamingo Rd)" },
  { name: "AMC Lincoln Square 13 & IMAX", city: "New York", state: "NY", lat: 40.775116, lng: -73.981747, chain: "amc", chainName: "AMC Lincoln Square 13", chainCode: "2116", coordSource: "amc list" },
  { name: "Cinemark Tinseltown Rochester & IMAX", city: "Rochester", state: "NY", lat: 43.1429026, lng: -77.713702, chain: "cinemark", chainName: "Cinemark Tinseltown Rochester and IMAX", chainCode: "202", coordSource: "cinemark list" },
  { name: "Regal UA King of Prussia & IMAX", city: "King of Prussia", state: "PA", lat: 40.0908, lng: -75.3866, chain: "regal", chainName: "REG King of Prussia 4DX & IMAX", chainCode: "1329", coordSource: "regal list" },
  { name: "Apple Cinemas Providence Place & IMAX", city: "Providence", state: "RI", lat: 41.8267783, lng: -71.4166846, coordSource: "geocoded (venue: 10 Providence Place)" },
  { name: "IMAX, Tennessee Aquarium", city: "Chattanooga", state: "TN", lat: 35.0544992, lng: -85.3123582, coordSource: "geocoded (venue: W Aquarium Way)" },
  { name: "Regal Opry Mills & IMAX", city: "Nashville", state: "TN", lat: 36.2008, lng: -86.6905, chain: "regal", chainName: "Regal Opry Mills 4DX & IMAX", chainCode: "0615", coordSource: "regal list" },
  { name: "Cinemark Dallas & IMAX", city: "Dallas", state: "TX", lat: 32.9101374, lng: -96.8725859, chain: "cinemark", chainName: "Cinemark Dallas XD and IMAX", chainCode: "207", coordSource: "cinemark list" },
];

module.exports = { IMAX_70MM_VENUES };

/**
 * The nearest 15/70 venues to an origin, by real driving time where routing is
 * available and straight-line estimate otherwise.
 *
 * Deliberately NOT radius-filtered: for a format with 24 venues nationwide,
 * "your nearest is 340 minutes away" is a useful answer and "none found" is
 * not. The caller decides what to do with the distance.
 */
async function nearestImax70mm({ originLat, originLng, limit = 3, getDriveMinutes }) {
  const { milesBetween, estimatedMinutesAway } = require("./distance");
  // Rank by straight line first so routing is asked about a handful of venues
  // rather than all 24 -- the nearest by road is always among the nearest few
  // by air at these distances.
  const ranked = IMAX_70MM_VENUES
    .map((v) => ({ ...v, miles: milesBetween(originLat, originLng, v.lat, v.lng) }))
    .sort((a, b) => a.miles - b.miles)
    .slice(0, Math.max(limit, 5));

  let minutes = ranked.map((v) => estimatedMinutesAway(originLat, originLng, v.lat, v.lng));
  let measured = false;
  if (typeof getDriveMinutes === "function") {
    try {
      const real = await getDriveMinutes({ originLat, originLng, destinations: ranked });
      if (real && real.some((m) => m != null)) {
        minutes = real.map((m, i) => (m == null ? minutes[i] : m));
        measured = true;
      }
    } catch {
      // fall back to the estimate -- a missing drive time must not lose the venue
    }
  }
  return ranked
    .map((v, i) => ({ ...v, distanceMin: minutes[i], distanceMi: Math.round(v.miles), driveTimeMeasured: measured }))
    .sort((a, b) => a.distanceMin - b.distanceMin)
    .slice(0, limit);
}

module.exports.nearestImax70mm = nearestImax70mm;
