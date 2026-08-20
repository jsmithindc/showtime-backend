// Straight-line distance as a stand-in for "minutes away."
// Replace with Google Distance Matrix / Mapbox Directions for real drive times
// once you're past the prototype stage — this will systematically
// under-estimate travel time in areas with rivers, highways, one-way grids, etc.

const EARTH_RADIUS_MI = 3958.8;
const ASSUMED_AVG_SPEED_MPH = 22; // rough city/suburban driving average

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function milesBetween(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MI * c;
}

function estimatedMinutesAway(originLat, originLng, destLat, destLng) {
  const miles = milesBetween(originLat, originLng, destLat, destLng);
  return Math.round((miles / ASSUMED_AVG_SPEED_MPH) * 60);
}

// Inverse of the above -- used to size the Overpass search radius from a
// "within N minutes" filter. Pads by 25% since straight-line distance
// under-counts real road distance, so this over-fetches slightly rather
// than risking missing a theater that's genuinely in range.
function minutesToMeters(minutes) {
  const miles = (minutes / 60) * ASSUMED_AVG_SPEED_MPH;
  const paddedMiles = miles * 1.25;
  return Math.round(paddedMiles * 1609.34);
}

module.exports = { milesBetween, estimatedMinutesAway, minutesToMeters };
