// Maps a theater name (as it comes back from Overpass/OSM) to AMC's own
// numeric theatre id, which the official API needs.
//
// HOW TO FILL THIS IN, once you have an AMC_VENDOR_KEY:
//   node find-amc-theatre.js "fullerton"
// This searches AMC's real theatre list and prints matching id/name
// pairs -- no guessing involved, unlike Regal's URL-digit trick.
//
// Only theaters listed here get real AMC pricing.
module.exports = {
  // "AMC Fullerton 20": 0000,  <- fill in once you've looked it up
};
