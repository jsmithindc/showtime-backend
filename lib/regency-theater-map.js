// Maps a theater name (as it comes back from Overpass/OSM) to Regency's
// own IDs for that location -- confirmed real from live captures.
//
// "chain" is confirmed a UNIVERSAL constant across Regency, not
// per-theater -- verified identical across two different real theaters
// (Buena Park and Santa Paula both use "00001-00003-00066").
//
// Regency uses TWO DIFFERENT representations of the same per-theater ID
// (same pattern already seen with Harkins' harkinsId vs cinemaId):
//   site:        plain numeric ID, used by the API calls themselves
//                (getFilmShowtimesByLocation.php, getSeatData.php)
//   seatsSiteId: hyphenated form (e.g. "00001-00001-00024"), used
//                specifically in the real booking/seat-selection URL
//                (regencymovies.com/seats/{seatsSiteId}/{perf}/{movie})
// Neither is derivable from the other -- confirmed no predictable
// pattern between them. seatsSiteId values below were recovered
// directly from the siteID cookie present in each real captured
// request, not separately re-captured.
const REGENCY_CHAIN_ID = "00001-00003-00066";

// ---------------------------------------------------------------------
// SITE REBUILD -- read this before trusting anything below.
//
// Every `site` and `seatsSiteId` in this file is CONFIRMED STILL VALID
// against the rebuilt site (Buena Park's 915209 and 00001-00001-00024
// both appear verbatim in the live page source and as the `sitePOS`
// argument in a real captured call). The API is ALSO STILL THE SAME --
// getFilmShowtimesByLocation.php / getSeatData.php -- confirmed
// straight from Regency's own client (js/master.js). An earlier round
// wrongly concluded this endpoint was retired; that was wrong. See the
// long correction note in lib/priceAdapters/regency-official.js for
// what was actually broken (missing film ID and zeroed lat/lon in the
// request body, not a dead endpoint).
//
// regencymovies.com ALSO now serves per-theater/per-movie pages at:
//   /locations/{locationSlug}
//   /locations/{locationSlug}/movie/{movieSlug}
// The locationSlug data below remains useful for other purposes (e.g.
// building links, or resolving a filmId per movie -- see below), but is
// no longer believed necessary just to fetch showtimes.
//
// So a rebuilt adapter needs a locationSlug per theater, NOT the numeric
// site ID. The slugs below were read DIRECTLY off the real page's own
// location nav (the mobileLocationNav hrefs in a captured view-source),
// not guessed -- which matters, because several are genuinely
// underivable from the display name. "Director's Cut & DCX" is
// /locations/rancho-niguel. Buena Park's slug still says
// "cgv-buena-park-cinemas" while the theatre is now displayed as "Buena
// Park 8 and 4DX @ The Source". Any attempt to generate these from
// names would have produced wrong values that fail silently.
//
// FOUR ARE STILL MISSING -- Foothill Cinema Stadium 10, Granada Hills 9,
// CGV Los Angeles, and Van Nuys Plant 16 & REX. Their hrefs were cut off
// at the right edge of the captured source (foothill-cinem..., granada-
// hills..., regency-cgv-lo..., van-nuys-plant...). The visible prefixes
// make the full values look obvious, but "rancho-niguel" is proof that
// obvious is not safe here, so they are deliberately left blank rather
// than completed by eye. Recover them from any Regency page's location
// menu when convenient.
//
// Two more locations exist that this map has never covered at all:
// /locations/main-street-cinemas (Yuma, AZ) and /locations/kihei-cinemas
// (Maui, HI). Both out of range for now.
//
// ALSO NOTE: OSM names in this file are now doubly stale. Regency has
// renamed several locations since these keys were written -- their own
// current menu lists "Buena Park 8 and 4DX @ The Source", "Commerce 14 &
// REX", and "Koreatown" where we have "CGV Buena Park", "Regency
// Commerce 14", and "CGV Los Angeles". Matching is against OSM's name,
// not Regency's, so these keys aren't automatically wrong -- but if a
// theater stops matching, the chain renaming is now a live suspect
// alongside the hidden-Unicode issue documented in server.js.
//
// DO NOT ADD "Regency Norwalk 8". It came up as a candidate because a
// real search surfaced it as an unknown-chain theater, but Regency's own
// current location menu (Arizona + California + Hawaii, all of it) does
// NOT list any Norwalk location, and third-party listings now call that
// address "Milagro Norwalk 8". It appears to have changed operators.
// Adding it here would send requests for a theater Regency no longer
// runs.
// ---------------------------------------------------------------------

module.exports = {
  "CGV Buena Park": { chain: REGENCY_CHAIN_ID, site: 915209, seatsSiteId: "00001-00001-00024", locationSlug: "regency-cgv-buena-park-cinemas" },
  "Santa Paula 7": { chain: REGENCY_CHAIN_ID, site: 39280, seatsSiteId: "00001-00001-00003", locationSlug: "santa-paula-7" },
  // The following 12 were captured in one batch, all confirmed real
  // requests -- but their OSM name mappings are best-guess based on how
  // Regency itself names each location, not individually confirmed
  // against real OSM data the way Buena Park was. If one of these never
  // shows up in a real search near its city, that's the first thing to
  // check -- OSM may tag it slightly differently.
  "Regency Academy Cinemas": { chain: REGENCY_CHAIN_ID, site: 64374, seatsSiteId: "00001-00001-00021", locationSlug: "academy-cinemas" }, // Pasadena -- OSM name confirmed real via overpass-turbo
  "BLVD Cinemas": { chain: REGENCY_CHAIN_ID, site: 21211, seatsSiteId: "00001-00001-00004", locationSlug: "blvd-cinemas" }, // Lancaster -- GENUINELY UNCERTAIN, not just unconfirmed: the real OSM node at this address has no "name" tag at all, and a possible "Laemmle BLVD Theaters" association raises a real question of whether this is even the same location under a different/former operator. This entry likely won't match anything in a real search right now. Revisit with a live debug search near Lancaster when convenient.
  "Regency Commerce 14": { chain: REGENCY_CHAIN_ID, site: 26828, seatsSiteId: "00001-00001-00022", locationSlug: "commerce-14" }, // City of Commerce -- OSM name confirmed real via overpass-turbo
  "Director's Cut & DCX": { chain: REGENCY_CHAIN_ID, site: 34550, seatsSiteId: "00001-00001-00014", locationSlug: "rancho-niguel" }, // Laguna Niguel
  "Fontana 8": { chain: REGENCY_CHAIN_ID, site: 47329, seatsSiteId: "00001-00001-00018", locationSlug: "fontana-8" },
  "Foothill Cinema Stadium 10": { chain: REGENCY_CHAIN_ID, site: 38557, seatsSiteId: "00001-00001-00008" },
  "Granada Hills 9": { chain: REGENCY_CHAIN_ID, site: 58596, seatsSiteId: "00001-00001-00010" },
  "CGV Los Angeles": { chain: REGENCY_CHAIN_ID, site: 201604, seatsSiteId: "00001-00001-00025" }, // Koreatown -- real page title says "Regency Theatres - Koreatown", but the URL slug is "regency-cgv-los-angeles", same CGV co-branding pattern as Buena Park, so this is the more likely OSM name
  "Sterling 6": { chain: REGENCY_CHAIN_ID, site: 43518, seatsSiteId: "00001-00001-00011", locationSlug: "sterling-6" }, // San Bernardino
  "Towngate 8": { chain: REGENCY_CHAIN_ID, site: 70207, seatsSiteId: "00001-00001-00005", locationSlug: "towngate-8" }, // Moreno Valley
  "Van Nuys Plant 16 & REX": { chain: REGENCY_CHAIN_ID, site: 77151, seatsSiteId: "00001-00001-00016" },
  "Westminster 10": { chain: REGENCY_CHAIN_ID, site: 4018, seatsSiteId: "00001-00001-00009", locationSlug: "westminster-10" },
};
