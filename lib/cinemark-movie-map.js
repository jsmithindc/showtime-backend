// Maps a movie title (matching the "movie" search parameter exactly) to
// Cinemark's internal cinemarkMovieId used in showtimes/ticketing URLs.
// For newer releases this matches the page-level movieId (e.g. The Odyssey:
// both are 108919). For older movies they may differ (Spider-Man's page id
// is 320559, but cinemarkMovieId is 107537).
//
// HOW TO FIND THIS for a new movie:
//   Option 1: Visit cinemark.com/theatres/{slug} and look in DevTools ->
//   Network -> filter "GetByMovieId" -> URL contains cinemarkMovieId=XXXXX.
//   Option 2: Visit cinemark.com/movies/{slug}, look in DevTools -> Network
//   -> filter "TicketSeatMap" to find CinemarkMovieId= in the href.
//   Option 3: Add the page-level movieId (from /Membership/SignIn?movieId=)
//   as a starting guess; for recent releases it often matches.
module.exports = {
  "Spider-Man: Brand New Day": "107537",
  "The Odyssey": "108919",
  "Tony": "111118",
};
