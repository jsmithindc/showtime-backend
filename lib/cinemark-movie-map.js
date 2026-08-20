// Maps a movie title (matching the "movie" search parameter exactly) to
// Cinemark's internal cinemarkMovieId -- a different number from the
// generic "movie id" shown on cinemark.com pages (confirmed: Spider-Man's
// page-level id is 320559, but its cinemarkMovieId used in showtimes/
// ticketing is 107537).
//
// HOW TO FIND THIS for a new movie:
//   Visit the movie's page on cinemark.com, e.g.
//   cinemark.com/movies/<slug>?showDate=YYYY-MM-DD
//   Open DevTools -> Network -> filter "GetByMovieId" -> the request URL
//   itself contains cinemarkMovieId=XXXXX.
module.exports = {
  "Spider-Man: Brand New Day": "107537",
};
