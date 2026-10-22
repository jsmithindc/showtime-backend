// Real, reported observations of how long trailers/ads actually run
// before the movie starts, per theater. Falls back to the general
// TRAILER_BUFFER_MIN_LOW/HIGH range in server.js when a theater has no
// entry here yet.
//
// HOW TO ADD AN ENTRY: after actually sitting through trailers at a
// theater, note how many minutes elapsed between the advertised
// showtime and the movie itself starting, then add a line below with
// the theater's exact name (matching what shows up in search results)
// and that many minutes. A single observation is still just one data
// point -- worth treating skeptically until confirmed by a second visit
// to the same theater, but still more real than the generic 20-30
// fallback used everywhere else.
module.exports = {
  // Confirmed real: a full 30 minutes of trailers/ads before The
  // Odyssey, observed directly.
  "AMC Norwalk 20": 30,

  // Reported firsthand: ~20 minutes of actual trailers after the listed time,
  // then ~5 minutes of Regal's own promos before the film. Listed under both
  // names it appears as -- the Regal code-0774 name the Regal search uses, and
  // OpenStreetMap's, which the free-time search uses.
  "Regal Natomas Marketplace": 25,
  "Regal Natomas Marketplace Stadium 16": 25,

  // Same report, same split: ~20 min of trailers, then ~5 of theater ads.
  // "Regal Delta Shores" is the Regal code-1413 name; the second is how
  // OpenStreetMap lists it.
  "Regal Delta Shores": 25,
  "Regal Delta Shores 17": 25,
};
