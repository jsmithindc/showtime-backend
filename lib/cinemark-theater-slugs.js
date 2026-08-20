// Maps a theater name (same OSM-name keys as lib/cinemark-theater-map.js)
// to its cinemark.com URL slug, e.g. "ca-sacramento/cinemark-century-
// doco-and-xd". Needed to fetch a theater's full page (for runtime
// harvesting, or re-deriving its theaterId) -- confirmed real slugs
// extracted directly from https://www.cinemark.com/full-theatre-list.
module.exports = {
  "Century DOCO and XD": "ca-sacramento/cinemark-century-doco-and-xd",
  "Century 16 Greenback Lane and XD": "ca-sacramento/cinemark-century-greenback-lane-16-and-xd",
  "Cinemark Century Arden XD and SCREENX": "ca-sacramento/cinemark-century-arden-xd-and-screenx",
  "Cinemark Century Laguna 16 and XD": "ca-elk-grove/cinemark-century-laguna-16-and-xd",
  "Cinemark Century Folsom 14": "ca-folsom/cinemark-century-folsom-14",
};
