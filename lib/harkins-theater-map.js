// Maps a theater name (as it comes back from Overpass/OSM) to Harkins'
// own two ID conventions for the same theater -- confirmed real from a
// live capture (GetTheatreShowtime) that harkinsid and cinemaId are the
// same theater, just two different numbering systems Harkins uses in
// different parts of their API:
//   harkinsId: used in discovery (Next.js data route's recentTheatre
//              param) and GetTicketTypes' sessionid-adjacent calls
//   cinemaId:  the zero-padded 10-digit form, used specifically by
//              GetTicketTypes and RequestOrderTotals
module.exports = {
  "Harkins Cerritos 16": { harkinsId: "63", cinemaId: "0000000010" },
};
