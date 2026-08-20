// Venues that show up in OpenStreetMap's cinema data but aren't actually
// operating commercial theaters -- historic/landmark buildings, permanently
// closed locations, etc. Excluding them here saves a wasted SerpApi call
// per search and stops them cluttering results with theaters that will
// never show anything.
module.exports = new Set([
  // Historic movie palace, closed since 1987, under restoration by a
  // preservation foundation -- not a working cinema. Confirmed via
  // foxfullerton.org and Wikipedia.
  "Fox Theatre",
]);
