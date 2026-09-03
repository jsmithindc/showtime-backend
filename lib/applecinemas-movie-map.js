// Maps a movie title to Apple Cinemas' C360 movieId.
//
// This exists for the same reason lib/cinemark-movie-map.js does: their
// schedule endpoint is MOVIE-scoped and no location-scoped "what's playing
// here" call has been found -- GetAllCompanyMoviesOptimized,
// GetLocationMoviesOptimized and GetAllCompanyLocationMoviesOptimized all
// answer 200 with an empty array. Without an id there is nothing to ask for,
// and the 70mm panel falls back to Atom for that venue.
//
// HOW TO FIND ONE: open the film at applecinemas.com and read the last path
// segment of the URL --
//   /The-Odyssey---The-IMAX-70MM-Experience--2026-/{locationId}/{movieId}
//
// Note the 70mm presentation is its own entry, distinct from the standard one,
// exactly as with Cinemark.
module.exports = {
  "The Odyssey": "6a206fa037200b3febb37398",
};
