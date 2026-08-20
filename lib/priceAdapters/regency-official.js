const fetch = require("node-fetch");

// Regency Theatres runs on "Mobile Moviegoing" -- a PHP-based platform
// (confirmed: plain .php endpoints, not a modern JSON API framework),
// genuinely different from the Vista-family platform (Cinema West,
// Harkins, Regal) this project has otherwise been building against.
//
// CONFIRMED REAL from a live capture (Buena Park 8 & 4DX @ The Source):
// POST https://www.regencymovies.com/include/getSeatData.php
// body: {"perf": performanceId, "site": siteId}
// Returns a full seat map (not needed for our purposes) plus, critically,
// ticketClassArray -- the real per-showing ticket price menu.
//
// Regency's ticket-type naming is genuinely unusual compared to every
// other chain in this project: types are named after the DAY/SHOWING
// ("Tuesday") rather than a generic "Adult" label, confirmed from a
// real response. "Reward" (bonus: true) is a loyalty-only discount
// tier -- excluding anything with bonus:true is the right filter here,
// analogous to excluding child/senior elsewhere, just a different axis.
//
// STILL MISSING: a discovery endpoint (find real performance IDs for a
// movie/theater/date without already knowing one). getSeatData.php
// needs a `perf` ID already in hand -- confirmed real captures only
// show this endpoint being called AFTER a specific showtime was already
// clicked. The showtimes listing is very likely server-rendered
// directly into the theater/movie page's HTML (this being a
// traditional PHP site, not a JS SPA) rather than a separate API call
// -- but a direct fetch of that page was blocked (405) from this
// project's own sandbox, so this needs either a raw page-source capture
// from a real browser, or a discovered API endpoint, to close out.

const crypto = require("crypto");

// CONFIRMED REAL FINDING: getFilmShowtimesByLocation.php was returning
// a literal "Error loading showtimes." (26 characters, not real data)
// for every request -- not a parsing bug at all, a request rejection.
// Every real captured request throughout this project's Regency
// investigation included cookies (visitID, hasSeenPopup, siteID,
// siteNoticeDetails) that this adapter was never sending.
//
// FIRST hypothesis (a bare random visitID alone is enough) was tested
// directly and DISPROVEN -- a real search with that fix in place still
// got the exact same "Error loading showtimes." rejection.
//
// SECOND hypothesis, now being tested: siteID specifically needs to be
// present and match the theater actually being requested -- every real
// capture's siteID cookie was the theater's own hyphenated ID
// (seatsSiteId in our theater map), not some arbitrary value. Building
// the cookie per-call now, theater-specific, instead of a single static
// header shared across every request regardless of which theater it's
// for.
function buildCookieHeader(seatsSiteId) {
  const visitID = crypto.randomUUID();
  const parts = [`visitID=${visitID}`, "hasSeenPopup=yes"];
  if (seatsSiteId) parts.push(`siteID=${seatsSiteId}`);
  return parts.join("; ");
}

function buildHeaders(seatsSiteId) {
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Content-Type": "application/json",
    "Cookie": buildCookieHeader(seatsSiteId),
  };
}

// Picks the real standard ticket price from a real ticketClassArray.
// Excludes bonus/loyalty-only tiers (bonus: true) and the usual
// age-discount keywords, then prefers the lowest dispOrder among what's
// left (confirmed real: the actual "primary" ticket type in a live
// response had a low dispOrder of 20, while the loyalty-only "Reward"
// tier was sorted last at 99 -- lower dispOrder tracking with "more
// standard" is a reasonable, if not 100% certain, read of the pattern).
function extractStandardPrice(ticketClassArray) {
  const entries = Object.values(ticketClassArray || {});
  const eligible = entries.filter((t) => {
    if (t.bonus === true) return false;
    const name = (t.appName || "").toLowerCase();
    if (/child|senior|student|military|kid|junior/.test(name)) return false;
    return true;
  });

  eligible.sort((a, b) => (a.dispOrder ?? 999) - (b.dispOrder ?? 999));
  const best = eligible[0];
  if (!best) return { price: null, ticketTypeName: null };

  const cents = best.pricex100;
  return {
    price: cents != null ? cents / 100 : null,
    ticketTypeName: best.appName || null,
  };
}

// Real pricing lookup for one specific performance. No order/cart step
// needed -- this is the same seat-map request the site itself makes
// when you click into a showtime, and it already carries full pricing.
async function getTicketPricing({ perf, site, seatsSiteId }) {
  const res = await fetch("https://www.regencymovies.com/include/getSeatData.php", {
    method: "POST",
    headers: buildHeaders(seatsSiteId),
    body: JSON.stringify({ perf, site }),
  });
  if (!res.ok) {
    throw new Error(`Regency getSeatData request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return extractStandardPrice(json.ticketClassArray);
}

// Real discovery endpoint, confirmed from a live capture:
// POST https://www.regencymovies.com/include/getFilmShowtimesByLocation.php
// body: {"chain": chainId, "site": siteId, "film": movieId | null,
//        "showDate": YYYYMMDDHHMM (as a number, e.g. 202608180000),
//        "lat": 0, "lon": 0, "filterOpt": null}
//
// Unlike every other chain in this project, the response is NOT clean
// JSON with structured fields -- it's a JSON-wrapped blob of server-
// rendered HTML (confirmed real from a live capture, extracted via
// PDF-to-text since the raw response was too large to paste directly).
// Rather than parse JSON first and guess at the wrapper's exact field
// name (unconfirmed), this works directly against the raw response
// text, matching the literal JSON-escaped HTML (\" and \/) as it
// appears in the raw bytes -- robust regardless of what the outer
// JSON structure actually is.
//
// Two confirmed real patterns pulled from that live capture:
// 1. Movie title: class=\"displayTechnology\" ... >TITLE<\/div>
// 2. Each performance: href=\"seats\/{site}\/{perf}\/{movie}\"
//    aria-label=\"Select the performance starting at {time}\"
//
// Format detection (see extractFormatsPerTitle below) is real, tested
// against the confirmed live structure -- not hardcoded to "Standard"
// anymore.
// Real format detection, confirmed real structure from a live capture:
// each movie's premium-format info shows up as <img title="..."> tags
// in an "attribute bar" between that movie's title and its performance
// links -- mixed in with accessibility/amenity icons (Closed Captioned,
// Assisted Listening Device available, Stadium Seating, Reserved
// Seating, Korean Subtitles) that are NOT formats and need filtering
// out. Confirmed real distance between one movie's title and the next
// is large (~6,450 characters in a live capture), so scoping the
// search to "everything up to the next title" reliably stays within
// one movie's own block without bleeding into an adjacent one's icons.
//
// Only "ScreenX" is directly confirmed real for Regency specifically
// (seen in a live capture). The rest of this keyword list is a
// reasonable extension based on the same industry-standard format
// names already used elsewhere in this project (Cinemark's format
// detection uses the identical keyword set), not individually
// confirmed for Regency -- worth revisiting if a real IMAX/Dolby/etc.
// screening at a Regency theater shows up mislabeled.
// CONFIRMED REAL BUG, found from live checkout data: this list was
// missing "Luxury Electric Recliners" and "LG LED" -- both real
// attribute-icon labels seen verbatim in a captured Regency response,
// each with its own image and title text just like the AMC/Regal-style
// keywords already here. Without these, every Regency performance
// showed up labeled "Standard" regardless of the actual auditorium,
// which is exactly what a real 4-showing sample confirmed: two
// performances of the same movie in a recliner-equipped auditorium
// priced meaningfully higher ($14.50/$17.50) than two others in the
// default room ($10/$11.50), yet all four were indistinguishable in
// this app's output.
const FORMAT_KEYWORDS = /imax|dolby|4dx|rpx|d-box|screenx|prime|3d|recliner|lg led/i;
const NOT_A_FORMAT = /closed caption|assisted listening|stadium seating|reserved seating|subtitle|dubbed/i;

function extractFormatsPerTitle(rawText) {
  const titlePattern = /displayTechnology\\?"[^>]*>([^<]+)</g;
  const titleMatches = [...rawText.matchAll(titlePattern)];

  const formatsByIndex = [];
  for (let i = 0; i < titleMatches.length; i++) {
    const start = titleMatches[i].index;
    const end = i + 1 < titleMatches.length ? titleMatches[i + 1].index : rawText.length;
    const segment = rawText.slice(start, end);

    const imgTitlePattern = /title=\\?"([^"\\]+)/g;
    let imgMatch;
    let format = "Standard";
    while ((imgMatch = imgTitlePattern.exec(segment)) !== null) {
      const label = imgMatch[1];
      if (NOT_A_FORMAT.test(label)) continue;
      if (FORMAT_KEYWORDS.test(label)) {
        format = label; // use the real label text as-is (e.g. "ScreenX"), not a normalized/guessed name
        break;
      }
    }
    formatsByIndex.push({ index: start, format });
  }
  return formatsByIndex;
}

function parseShowtimesHtml(rawText) {
  const performances = [];

  // Movie title blocks appear once per movie, ahead of that movie's
  // performance links -- scan in order and attribute each performance
  // to whichever title block most recently preceded it.
  const titlePattern = /displayTechnology\\?"[^>]*>([^<]+)</g;
  const titleMatches = [...rawText.matchAll(titlePattern)].map((m) => ({
    index: m.index,
    title: m[1],
  }));
  const formatsByIndex = extractFormatsPerTitle(rawText);

  const perfPattern = /seats\\?\/([0-9-]+)\\?\/(\d+)\\?\/(\d+)\\?"[^>]*aria-label=\\?"Select the performance starting at ([0-9:apm]+)/g;
  let match;
  while ((match = perfPattern.exec(rawText)) !== null) {
    const [, siteId, sessionId, movieId, time] = match;
    // Find the closest preceding title block (and its matching format,
    // by the same index) -- same "walk backward to the most recent
    // block" pattern for both, since they're computed from the same
    // title-block boundaries.
    let movieTitle = null;
    let format = "Standard";
    for (let i = titleMatches.length - 1; i >= 0; i--) {
      if (titleMatches[i].index < match.index) {
        movieTitle = titleMatches[i].title;
        format = formatsByIndex[i]?.format ?? "Standard";
        break;
      }
    }
    performances.push({ siteId, sessionId, movieId, time, movieTitle, format });
  }

  // Each performance link appears twice in the real markup (once in the
  // aria-label context, once more as the visible button) -- dedupe by
  // sessionId, keeping the first occurrence.
  const seen = new Set();
  return performances.filter((p) => {
    if (seen.has(p.sessionId)) return false;
    seen.add(p.sessionId);
    return true;
  });
}

// SOLVES THE OPEN filmId PROBLEM from earlier in this project.
//
// A real doShowtimesNew.php?starttime=<date> response (the endpoint
// Regency's own "now playing" calendar view calls) was captured whole.
// Its JSON has a `sortOrders` object keyed BY FILM ID, each entry
// carrying that film's own HTML fragment -- including its title. Cross-
// referencing every key against the title inside its own fragment gives
// a complete, CONFIRMED title -> filmId map for every movie playing at
// that theater that day, from a single request:
//
//   1210 -> Train to Busan - 10th Anniversary Remastered & Revived
//   1218 -> PAW Patrol: The Dino Movie
//   1105 -> The End of Oak Street
//   1188 -> Spider-Man: Brand New Day
//   1174 -> The Odyssey   (matches the single-page sample seen earlier,
//                          independent confirmation of that ID)
//
// This is a much better resolver than scraping one page per movie: one
// call per theater per day yields every film ID showing there, so it
// composes naturally with the per-theater loop this project already
// runs, at no extra request cost per movie.
//
// NOT YET WIRED IN. This function is written and ready, but
// getShowtimesForLocation() above still needs a real caller to run it
// first and pass the resulting id into filmId. Do that before assuming
// Regency pricing works end to end.
async function getFilmIdMap({ dateISO, seatsSiteId, locationSlug }) {
  // TWO REAL BUGS, both confirmed from a live cURL capture of this
  // exact endpoint working in a real browser -- this explains the
  // empty sortOrders seen in every prior attempt, and it wasn't a
  // response-shape problem at all:
  //
  // 1. DATE FORMAT WAS WRONG. The real request sends starttime as an
  //    8-digit YYYYMMDD (e.g. 20260819) -- NOT the 12-digit
  //    YYYYMMDDHHMM used by getShowtimesForLocation's showDate. Those
  //    are two DIFFERENT endpoints with two DIFFERENT date formats;
  //    assuming they matched was the mistake. Sending a 12-digit number
  //    into an 8-digit field is exactly the kind of thing a server
  //    would silently fail to match against anything, explaining the
  //    empty-but-not-erroring response seen before.
  //
  // 2. MISSING HEADERS. The real request sends
  //    "X-Requested-With: XMLHttpRequest" (the standard jQuery AJAX
  //    marker -- master.js's getST() uses $.ajax for this exact call)
  //    and a real "Referer" pointing at the theater's own location
  //    page. Neither was being sent. Endpoints gated on the AJAX header
  //    specifically are common enough that this is a real, distinct
  //    possible cause independent of the date bug above -- both are
  //    fixed here since either alone could have been the blocker.
  const showDate = dateISO.replace(/-/g, ""); // YYYYMMDD, confirmed real
  const referer = locationSlug
    ? `https://www.regencymovies.com/locations/${locationSlug}`
    : "https://www.regencymovies.com/";
  const res = await fetch(`https://www.regencymovies.com/include/doShowtimesNew.php?starttime=${showDate}`, {
    method: "GET",
    headers: {
      ...buildHeaders(seatsSiteId),
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": referer,
    },
  });
  if (!res.ok) {
    throw new Error(`Regency doShowtimesNew request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const sortOrders = json.sortOrders || {};
  const filmIdKeys = Object.keys(sortOrders);
  const map = {};
  let regexMisses = 0;

  if (filmIdKeys.length === 0) {
    // CONFIRMED REAL from a live report: sortOrders can come back as a
    // genuinely empty object -- {} -- even when json.listings contains
    // real showings for real movies at that theater on that date (the
    // person confirmed The Odyssey had multiple real screenings, some
    // well inside the deadline). So this is NOT a quiet-day case and
    // NOT a missing key -- sortOrders is present but empty while
    // listings is populated. Root cause not confirmed (maybe sortOrders
    // only populates after a client-side quick-filter interaction,
    // maybe it's device/viewport-gated) -- rather than keep guessing at
    // why, fall back to a source already proven reliable: `listings` is
    // the same raw HTML block whose `seats/{site}/{perf}/{filmId}`
    // links this project already trusts for booking links elsewhere.
    //
    // Positional pairing: each movie's title lives in a
    // `displayTechnology` div, immediately followed in the markup by
    // that movie's own showtime links. So for each title match, take
    // the FIRST `seats/.../filmId` link appearing after it -- confirmed
    // real from the full single-page capture, where this exact ordering
    // held for all 5 movies on the page.
    const listingsHtml = json.listings || "";
    const titleRe = /displayTechnology[^>]*>\s*([^<]+?)\s*</g;
    const seatsRe = /seats\/[^/"]+\/\d+\/(\d+)"/g;
    let titleMatch;
    while ((titleMatch = titleRe.exec(listingsHtml)) !== null) {
      const title = titleMatch[1].trim();
      if (map[title] != null) continue; // already found from an earlier occurrence
      seatsRe.lastIndex = titleMatch.index;
      const seatsMatch = seatsRe.exec(listingsHtml);
      if (seatsMatch) {
        map[title] = Number(seatsMatch[1]);
      }
    }
    console.error(
      `Regency getFilmIdMap: sortOrders was empty despite real listings HTML being present -- ` +
      `fell back to extracting from listings directly. Recovered ${Object.keys(map).length} title(s): ` +
      `${JSON.stringify(Object.keys(map))}`
    );
    return map;
  }
  for (const filmId of filmIdKeys) {
    const entries = sortOrders[filmId];
    if (!Array.isArray(entries) || entries.length === 0) continue;
    // Every entry under a given filmId is the SAME movie (different
    // auditoriums/formats), confirmed real from Spider-Man appearing
    // three times under "1188" -- so the first entry's title is enough.
    const bodyHtml = entries[0].body || "";
    const titleMatch = /displayTechnology[^>]*>\s*([^<]+?)\s*</.exec(bodyHtml);
    if (titleMatch) {
      map[titleMatch[1].trim()] = Number(filmId);
    } else {
      regexMisses++;
    }
  }
  if (regexMisses > 0) {
    console.error(
      `Regency getFilmIdMap: title regex failed to match on ${regexMisses} of ${filmIdKeys.length} filmId entries -- the real markup may have drifted from the captured sample this regex was built against.`
    );
  }
  return map;
}

async function getShowtimesForLocation({ chain, site, dateISO, seatsSiteId, filmId, lat, lon }) {
  // CORRECTION, and a real one this time -- confirmed straight from
  // Regency's own client code (js/master.js, `loadShowtimes()`), not
  // inferred. Everything this file previously said about the endpoint
  // being retired was WRONG. It is the SAME endpoint, still live:
  //
  //   getLocationForShowtimes(showDate, filmID, sitePOS) sets globals,
  //   then loadShowtimes() posts to this exact URL with:
  //     { chain, site: sitePOS, film: filmID, showDate, lat, lon, filterOpt }
  //
  // Two things we were sending wrong, both now confirmed from the real
  // client:
  //   1. film: null -- the real client ALWAYS sends a real film ID
  //      (e.g. 1174 for The Odyssey). We were asking for "all films" on
  //      an endpoint that apparently requires a specific one.
  //   2. lat: 0, lon: 0 -- the real client sends real geolocation
  //      (there's a whole getCustLatLng()/locationSuccessInit() flow
  //      dedicated to populating this before any showtime call). Zeroed
  //      coordinates were the one thing flagged as synthetic-looking in
  //      an earlier round of this investigation -- that suspicion was
  //      correct.
  // Either or both of these are very likely why every real search got
  // the same 26-char error regardless of headers or cookies: the
  // request body itself was never valid, so no amount of header/cookie
  // tweaking could have fixed it.
  //
  // filmId is still the missing piece for a full fix -- we don't have a
  // slug/title -> filmId mapping yet, only the single confirmed sample
  // (The Odyssey -> 1174) pulled from one page's inline script. Until
  // that's solved, pass null and expect this to keep failing exactly as
  // before; the code is wired to accept a real filmId the moment one is
  // available, rather than silently limping along on a guess.
  const showDate = Number(dateISO.replace(/-/g, "") + "0000");

  const res = await fetch("https://www.regencymovies.com/include/getFilmShowtimesByLocation.php", {
    method: "POST",
    headers: buildHeaders(seatsSiteId),
    body: JSON.stringify({
      chain,
      site,
      film: filmId ?? null,
      showDate,
      lat: lat ?? 0,
      lon: lon ?? 0,
      filterOpt: null,
    }),
  });
  if (!res.ok) {
    throw new Error(`Regency getFilmShowtimesByLocation request failed: ${res.status} ${res.statusText}`);
  }
  const rawText = await res.text();

  // WHAT THE REAL PAGE SOURCE PROVES (view-source captured 2026-08-19
  // from /locations/regency-cgv-buena-park-cinemas/movie/the-odyssey).
  //
  // CORRECTION OF AN EARLIER WRONG CONCLUSION, recorded deliberately so
  // nobody re-derives it: when no request to getFilmShowtimesByLocation
  // .php appeared in a real browser's Network tab, this file previously
  // claimed the site had moved to SERVER-RENDERED showtimes. That was
  // wrong. The real source shows the opposite -- the showtimes container
  //     <div id="showtimesListings"></div>
  // is EMPTY in the delivered HTML, and the page fills it from JS on
  // load. So showtimes are still fetched over the wire; the old endpoint
  // just isn't the thing fetching them anymore.
  //
  // The real call, straight out of the page's own load handler:
  //     doDateNew('202608190000');
  //     getLocationForShowtimes(202608190000, 1174, 915209)
  // and from its date-picker path:
  //     getLocationForShowtimes(selected, '1174', '915209');
  //
  // CONFIRMED STILL CORRECT (all three survived the rebuild -- worth
  // knowing before anyone throws the theater map away):
  //   - site 915209 for Buena Park, exactly as stored in the map
  //   - seatsSiteId 00001-00001-00024, set as a page global: site =
  //     '00001-00001-00024'
  //   - chain 00001-00003-00066, also a page global
  //   - showDate format YYYYMMDDHHMM as a plain number -- 202608190000
  //     is precisely what this file already builds
  //
  // THE ONE GENUINELY NEW PIECE is the middle argument, 1174. We have
  // never sent anything like it. This page is per-movie and the old call
  // passed `film: null`, so 1174 is very likely this platform's film ID
  // for The Odyssey -- but that is an INFERENCE FROM ONE SAMPLE, not a
  // confirmed fact, and a single number seen once could equally be a
  // layout or view ID. Do not build against it until it's been seen vary
  // across two different movies at the same theater.
  //
  // STILL UNKNOWN: the actual endpoint URL. getLocationForShowtimes() is
  // defined in js/master.js?v=902, which hasn't been read yet. That file
  // is the last missing piece -- it holds the URL, method, and body
  // shape. Note the site still uses the same include/ and functions/
  // directory conventions elsewhere on this very page (it fetches
  // include/doCloseMemberPrompt.php and functions/doSetLang.php), so the
  // new endpoint is plausibly a sibling of the old one -- but that is a
  // guess, and guessing endpoint shapes is exactly what burned three
  // rounds of work here already. Read master.js first.
  //
  // OPEN QUESTION worth one cheap test before assuming the old endpoint
  // is dead: it returns a real 26-char application error, not a 404, so
  // the PHP file still exists and runs. It may simply now REQUIRE a film
  // ID where we still send `film: null`. If master.js turns out to hit
  // this same URL with a film ID populated, this adapter may need a new
  // parameter rather than a rewrite.
  //
  // Useful bonus, all server-rendered in the page and free to scrape if
  // ever wanted: runtime ("2 hr 52 mins"), rating, release date, and a
  // showDates array of every date with showtimes.
  const performances = parseShowtimesHtml(rawText);
  if (performances.length === 0) {
    const looksLikeKnownError = rawText.length < 100 && /error loading showtimes/i.test(rawText);
    console.error(
      looksLikeKnownError
        ? `Regency [site ${site}]: getFilmShowtimesByLocation.php returned its known ${rawText.length}-char ` +
          `error. This is the SAME endpoint the real site uses (confirmed from master.js), so it's not retired -- ` +
          `the request body is very likely wrong. The real client always sends a real film ID (we send null ` +
          `unless filmId is passed in) and real geolocation (we default to lat/lon 0,0). Not a parsing bug, and ` +
          `not fixable by further header/cookie tweaking -- fix the body first.`
        : `REGENCY DEBUG: parsed 0 performances, but the response does NOT look like the known ` +
          `error -- worth a look. Raw length: ${rawText.length} chars. ` +
          `Contains "displayTechnology": ${rawText.includes("displayTechnology")}. ` +
          `Contains "seats": ${rawText.includes("seats")}. First 300 chars: ${rawText.slice(0, 300)}`
    );
  }
  return performances;
}

module.exports = { getTicketPricing, extractStandardPrice, getShowtimesForLocation, parseShowtimesHtml, extractFormatsPerTitle, getFilmIdMap };
