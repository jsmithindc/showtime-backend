// Maps a theater name (as it comes back from Overpass/OSM) to Cinemark's
// own numeric theaterId.
//
// IMPORTANT: OSM's theater names often drop the "Cinemark" brand prefix
// entirely and can use different word order than Cinemark's own site --
// confirmed from a real search: OSM returns "Century DOCO and XD" (no
// "Cinemark" prefix) and "Century 16 Greenback Lane and XD" (not
// "Cinemark Century Greenback Lane 16 and XD"). Always match against
// what a real debug=true search actually returns in theatersInRange, not
// against Cinemark's own branded name.
module.exports = {
  "Century DOCO and XD": "448", // confirmed against real OSM output
  "Century 16 Greenback Lane and XD": "476", // confirmed against real OSM output
  // Below: IDs confirmed real (from your DevTools capture), but the OSM
  // name is NOT yet confirmed -- these are still guesses and likely wrong
  // the same way the two above were. Verify with a debug=true search that
  // surfaces these theaters, then fix the key to match exactly.
  "Cinemark Century Arden XD and SCREENX": "1137",
  "Cinemark Century Laguna 16 and XD": "417",
  "Cinemark Century Folsom 14": "416",
  // Downey's ID was found a DIFFERENT way than the four above, worth
  // recording because it changes what the build script should look for.
  // The page loads fine now (no queue), but a real full-page network
  // capture confirmed the raw HTML never contains a literal
  // "TheaterId=NNN" substring anywhere -- that's a real find, not a
  // failed search. The ID is instead exposed through the site's own
  // Google Analytics calls, in the ep.theater_id tracking parameter:
  //   .../g/collect?...&ep.theater_id=1134&...
  // sent while the Downey theatre page is loaded. So the regex in
  // scripts/build-cinemark-theater-map.js (which only looks for
  // TheaterId=) will never find this theater even with the page
  // rendering correctly -- it's not a queue problem or a parsing bug,
  // it's that the ID moved to a different, analytics-only channel for
  // at least this theater. Confirmed real, not a guess.
  "Cinemark Downey 14 and XD": "1134",
};
