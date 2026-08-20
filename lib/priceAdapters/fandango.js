const { chromium } = require("playwright");

// This is a *pattern*, not a verified-against-fandango.com implementation —
// I don't have network access to fandango.com from this environment to
// confirm the exact endpoint, so treat step 0 below as something you do
// once, by hand, before this will work.
//
// STEP 0 (manual, one-time, per site):
//   1. Open the theater's Fandango page in Chrome.
//   2. DevTools -> Network tab -> filter to Fetch/XHR.
//   3. Click a showtime / open the ticket picker.
//   4. Find the request that returns JSON containing a price field.
//   5. Note its URL pattern -- put that pattern in RESPONSE_URL_MATCH below.
//   6. Note the JSON field path for price -- update extractPrice() below.
//
// Until you've done that, this file intercepts *every* JSON response on
// the page and heuristically looks for something price-shaped, which is
// slower and less reliable than targeting the real endpoint directly, but
// works as a fallback / a way to discover the right endpoint by logging
// what it finds.

const RESPONSE_URL_MATCH = /fandango\.com\/.*(ticket|price|showtime)/i;

function extractPrice(json) {
  // Heuristic fallback: walk the object looking for a plausible ticket
  // price. Replace this with a direct field access (e.g. json.data.
  // ticketTypes[0].price) once you've identified the real shape in
  // DevTools -- that will be far more reliable than guessing.
  const found = [];
  function walk(node) {
    if (node && typeof node === "object") {
      for (const [key, val] of Object.entries(node)) {
        if (
          typeof val === "number" &&
          val > 3 &&
          val < 60 &&
          /price|amount|cost/i.test(key)
        ) {
          found.push(val);
        } else {
          walk(val);
        }
      }
    }
  }
  walk(json);
  return found.length ? Math.min(...found) : null;
}

async function getPrice(showing) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let capturedPrice = null;

    page.on("response", async (response) => {
      if (capturedPrice !== null) return;
      if (!RESPONSE_URL_MATCH.test(response.url())) return;
      const type = response.headers()["content-type"] || "";
      if (!type.includes("application/json")) return;

      try {
        const json = await response.json();
        const price = extractPrice(json);
        if (price !== null) capturedPrice = price;
      } catch {
        // not JSON, or already consumed -- ignore
      }
    });

    // TODO: replace with the real deep link once you have it. MovieGlu's
    // API (see lib/movieglu.js) can often return a deep link per showing
    // that lands you close to this page already.
    const searchUrl = `https://www.fandango.com/search?q=${encodeURIComponent(
      showing.theaterName
    )}`;
    await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 15000 });

    // Give any late XHRs a moment to land.
    await page.waitForTimeout(1500);

    return capturedPrice;
  } finally {
    await browser.close();
  }
}

module.exports = { getPrice };
