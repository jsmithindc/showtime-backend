// Maps a theater name (as it comes back from Overpass/OSM) to AMC's own
// numeric theatre id, which the official API needs.
//
// HOW TO FILL THIS IN, once you have an AMC_VENDOR_KEY:
//   node find-amc-theatre.js "fullerton"
// This searches AMC's real theatre list and prints matching id/name
// pairs -- no guessing involved, unlike Regal's URL-digit trick.
//
// Only theaters listed here get real AMC pricing. Add any theater
// whose OSM name doesn't match the AMC API name closely enough for
// the auto-match to work (rebrands, proximity misses, etc.).
// IDs confirmed from AMC's own API: GET /v2/theatres?state=XX
// Keys are OSM theater names (which may be stale/pre-rebrand).
// Values are { id, name } where name is the current AMC marketing name.
// Used as a fallback when getAmcTheatersByState() fails (API key missing,
// network error, etc.) -- OSM finds the theater by location, this map
// corrects the display name to what AMC actually calls it today.
module.exports = {
  // Pennsylvania
  "New Vision Theatres Tilghman Square 8": { id: 594,  name: "AMC Tilghman Square 8" },
  "AMC Center Valley 16":                  { id: 4401, name: "AMC Center Valley 16" },
};
