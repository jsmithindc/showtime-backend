// Straight-line distance as a stand-in for "minutes away."
// Replace with Google Distance Matrix / Mapbox Directions for real drive times
// once you're past the prototype stage.
//
// The error runs in BOTH directions, and the highway case is the bigger one:
//   - Straight-line under-counts road distance where rivers, one-way grids or
//     a lack of through-streets force a detour -> under-estimates time.
//   - The flat 22mph over-counts time for anything reached by highway, and
//     this dominates. Measured against a real Denver search: AMC Brighton 12
//     is 18.8mi straight-line, so this model calls it 51 minutes and drops it
//     from a 30-minute search -- but it's a ~25-30min drive up I-76. Every
//     exurban theater is penalised the same way, which makes the radius
//     filter quietly too STRICT at the edges, not too loose.
// So don't "fix" a surprising exclusion by widening the radius; the speed
// assumption is what's wrong.

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
