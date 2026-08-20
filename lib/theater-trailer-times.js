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
};
