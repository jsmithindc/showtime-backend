// Manual fallback for movie runtimes, in minutes. Same pattern as
// lib/regal-cinema-map.js and the Cinemark theater/movie maps -- a safety
// net for cases where the automated lookup in lib/movie-runtime.js misses
// or returns something wrong (its Google Knowledge Graph parsing is
// unverified against a live response, so treat it as unreliable until
// you've checked it against a few real titles).
//
// Key must match the exact movie title as it appears in SerpApi's
// showtimes results (same title string used elsewhere in this app).
module.exports = {
  "Spider-Man: Brand New Day": 145, // confirmed real, from MediaStinger's own page data ("Running Time: 145 minutes")
  "The Odyssey": 172, // confirmed real -- the automated SerpApi lookup was silently falling back to 128 (the hardcoded default) once SerpApi's monthly credits ran low/out
};
