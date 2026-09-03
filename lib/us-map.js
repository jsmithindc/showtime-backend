// Albers Equal Area Conic for the contiguous US, plus the viewBox the
// projected outline is drawn into.
//
// ONE source of truth on purpose: scripts/build-us-map-path.js generates the
// state outline with this exact function, and server.js projects the IMAX 70mm
// venues with it too. If the projection lived in two places the dots would
// drift off the map the first time either was touched, and the drift would be
// small enough to look plausible.
//
// Contiguous US only. All 25 venues in lib/imax-70mm-venues.js are lower-48,
// so the Alaska/Hawaii insets a full albersUsa needs would be dead weight.

const PHI_1 = 29.5 * Math.PI / 180;   // standard parallels, the usual CONUS pair
const PHI_2 = 45.5 * Math.PI / 180;
const PHI_0 = 37.5 * Math.PI / 180;   // reference latitude
const LAMBDA_0 = -96 * Math.PI / 180; // reference longitude

const n = (Math.sin(PHI_1) + Math.sin(PHI_2)) / 2;
const C = Math.cos(PHI_1) ** 2 + 2 * n * Math.sin(PHI_1);
const RHO_0 = Math.sqrt(C - 2 * n * Math.sin(PHI_0)) / n;

function raw(lat, lng) {
  const phi = lat * Math.PI / 180;
  const lambda = lng * Math.PI / 180;
  const rho = Math.sqrt(C - 2 * n * Math.sin(phi)) / n;
  const theta = n * (lambda - LAMBDA_0);
  return [rho * Math.sin(theta), RHO_0 - rho * Math.cos(theta)];
}

// Fit to a fixed box by projecting the CONUS bounding box's edges. Sampled
// rather than using the four corners alone: the top and bottom edges bow under
// a conic projection, so corners alone would clip Maine and the Gulf coast.
const WIDTH = 960;
const HEIGHT = 600;
const PAD = 12;

const bounds = (() => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let lng = -125; lng <= -66; lng += 0.5) {
    for (const lat of [24.5, 49.5]) {
      const [x, y] = raw(lat, lng);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  for (let lat = 24.5; lat <= 49.5; lat += 0.5) {
    for (const lng of [-125, -66]) {
      const [x, y] = raw(lat, lng);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  return { minX, maxX, minY, maxY };
})();

const scale = Math.min(
  (WIDTH - PAD * 2) / (bounds.maxX - bounds.minX),
  (HEIGHT - PAD * 2) / (bounds.maxY - bounds.minY)
);
const offsetX = PAD + ((WIDTH - PAD * 2) - (bounds.maxX - bounds.minX) * scale) / 2;
const offsetY = PAD + ((HEIGHT - PAD * 2) - (bounds.maxY - bounds.minY) * scale) / 2;

/** lat/lng -> [x, y] in the viewBox below. Rounded: sub-pixel precision here
 *  is noise, and it keeps the generated path a third smaller. */
function project(lat, lng) {
  const [x, y] = raw(lat, lng);
  return [
    Math.round(((x - bounds.minX) * scale + offsetX) * 10) / 10,
    // Y is FLIPPED. The projection's y grows northward; SVG's grows downward,
    // so without this the country is drawn upside down -- and plausibly enough
    // that it reads as a projection bug rather than an axis one.
    Math.round(((bounds.maxY - y) * scale + offsetY) * 10) / 10,
  ];
}

module.exports = { project, VIEWBOX: `0 0 ${WIDTH} ${HEIGHT}`, WIDTH, HEIGHT };
