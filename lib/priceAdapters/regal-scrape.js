const { chromium } = require("playwright");

// Real Regal ticket prices, via the same pattern documented publicly for
// regmovies.com's internal flow: create an order session (gets a cart_id),
// find the specific showtime's session id, then call the tickets endpoint
// with both. Reference pattern:
// https://scrape.do/blog/regmovies-com-scraping/
//
// IMPORTANT, untested-live caveat: regmovies.com is Cloudflare-protected.
// That write-up routes through a paid scraping proxy specifically to get
// past Cloudflare's bot detection -- a bare Playwright session (even
// non-headless) may still get blocked. This is the thing your first real
// run will actually tell us; if it gets stuck on a Cloudflare challenge
// page instead of reaching regmovies.com content, that's the signal to
// either switch to a proxy service or fall back to the official Regal
// partner API instead (see README).

// Confirmed via a live run: regmovies.com throws up popups with a stable
// id="popup-wrapper" (at least two different kinds seen so far -- a
// location-confirmation one, and what looks like a showtime-details
// overlay) that intercept clicks on the actual page content underneath.
// Rather than guess at each popup's specific close-button text/markup
// (which varies per popup type), force-hide the wrapper directly via JS
// before every interaction -- more robust across whichever popup happens
// to be showing at that moment.
async function dismissPopupWrapper(page) {
  await page.evaluate(() => {
    const popup = document.getElementById("popup-wrapper");
    if (popup) {
      popup.style.display = "none";
      popup.style.pointerEvents = "none";
    }
  }).catch(() => {});
}

async function getRegalPricing({ cinemaCode, movieTitle, dateISO }) {
  if (!cinemaCode) {
    throw new Error("No Regal cinema code configured for this theater -- see lib/regal-cinema-map.js");
  }

  const browser = await chromium.launch({ headless: false }); // non-headless: less likely to trip Cloudflare than headless
  try {
    const page = await browser.newPage();
    const capturedResponses = [];

    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("regmovies.com/api/")) return;
      const type = response.headers()["content-type"] || "";
      if (!type.includes("application/json")) return;
      try {
        const json = await response.json();
        capturedResponses.push({ url, json });
      } catch {
        // not JSON, or already consumed -- ignore
      }
    });

    // "networkidle" was the wrong wait condition here -- ticketing pages
    // like this tend to have continuous background polling/analytics
    // traffic that never lets the network go fully idle, so the page was
    // actually loading fine while Playwright sat waiting for a condition
    // that was never going to become true. "domcontentloaded" reflects
    // when the page is actually usable.
    const theaterUrl = `https://www.regmovies.com/theatres/theatre-${cinemaCode}`;
    await page.goto(theaterUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000); // let client-side rendering/redirects settle

    await dismissPopupWrapper(page);

    // Click through to the target movie's row, then click an actual
    // showtime within it -- getTicketsForSession is very likely triggered
    // by selecting a specific time, not just landing on the movie's row.
    const movieLink = page.locator(`text=${movieTitle}`).first();
    if (await movieLink.count()) {
      await movieLink.click({ force: true }); // force: bypass any residual overlay still animating out
      await page.waitForTimeout(2000);

      // A new popup (showtime details, based on your last run) may have
      // appeared as a result of that click -- dismiss again before the
      // next interaction.
      await dismissPopupWrapper(page);

      // Look for anything that reads like a showtime (e.g. "7:00 PM") and
      // click the first one, to trigger the actual ticket-selection flow.
      const timeButton = page.locator("text=/\\d{1,2}:\\d{2}\\s*(AM|PM)/i").first();
      if (await timeButton.count()) {
        await timeButton.click({ force: true });
      }
    }

    // Give any ticket-related XHRs a moment to fire after interaction.
    await page.waitForTimeout(3000);

    const ticketResponses = capturedResponses.filter((r) =>
      r.url.includes("getTicketsForSession")
    );

    if (ticketResponses.length === 0 && capturedResponses.length > 0) {
      // We didn't find the specific endpoint we expected, but we did see
      // *some* API traffic -- log what actually happened so the real
      // endpoint name/shape can be identified instead of guessed again.
      console.error(
        `Regal: getTicketsForSession not seen for cinema ${cinemaCode}. Other API calls observed:`,
        capturedResponses.map((r) => r.url).slice(0, 10)
      );
    } else if (capturedResponses.length === 0) {
      console.error(
        `Regal: no regmovies.com/api/ calls observed at all for cinema ${cinemaCode} -- the click-through likely isn't reaching a showtime selection step.`
      );
    }

    return extractPricedShowtimes(ticketResponses);
  } finally {
    await browser.close();
  }
}

// Best-effort flatten of whatever the tickets endpoint actually returns
// into {time, format, price}. Written against the documented example
// shape (showtimes[].price.adult) -- the real response may differ, since
// this hasn't been run against a live page yet. If matching comes back
// empty on your first real run, log a raw capturedResponses entry and
// adjust this function to match its actual shape.
function extractPricedShowtimes(ticketResponses) {
  const results = [];
  for (const { json } of ticketResponses) {
    for (const showtime of json.showtimes || []) {
      if (showtime.price?.adult == null) continue;
      results.push({
        time: showtime.startTime,
        format: showtime.format || "Standard",
        price: showtime.price.adult,
      });
    }
  }
  return results;
}

module.exports = { getRegalPricing };
