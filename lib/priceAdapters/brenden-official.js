// Brenden Theatres -- showtimes from the site's own server-rendered page.
//
// robots.txt is short and specific:
//   Disallow: /ahoy  /graphql  /checkout  (and /*/checkout)
//
// So /{site}/showtimes is PERMITTED and /graphql is not, which settles the
// approach: parse the page, never call their API. The page is server-rendered
// (~19KB) and already carries everything -- film titles, every showtime, and
// the showing id -- so nothing is lost by staying on the permitted path.
//
// 70mm IS NOT A SESSION ATTRIBUTE HERE. Brenden runs the 70mm presentation as
// its own film entry, "The Odyssey - The IMAX 70mm Experience", alongside a
// plain "The Odyssey" on another screen -- both appeared on one real page, at
// 12:00/16:00/20:00 and 14:00 respectively. So the print is read off the film
// title and slug, and the two must not be conflated.
//
// PRICING IS DELIBERATELY NOT IMPLEMENTED. Every showtime links to
// /{site}/checkout/showing/{slug}/{id}, and /checkout is disallowed. Those URLs
// are used as buy links -- linking is not fetching -- but this adapter never
// requests them. Same position the project already took on Atom, whose
// /checkout pricing is why the whole Atom path sits behind ENABLE_ATOM_PATH.

const fetch = require("node-fetch");
const { readCache, writeCache } = require("../disk-cache");

const BASE = "https://www.brendentheatres.com";
const REQUEST_TIMEOUT_MS = 20000;

function to24h(t) {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(String(t).trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/p/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/**
 * Films and showtimes from a site's showtimes page.
 *
 * A film heading link opens a block, and every checkout link until the NEXT
 * film heading belongs to it -- the page has no per-film container to key off.
 */
function parseShowtimes(html, site) {
  const filmRe = new RegExp(
    `<a href="${BASE}/([a-z]+)/movie/([^"]+)">([^<]+)</a>([\\s\\S]*?)(?=<a href="${BASE}/[a-z]+/movie/|$)`,
    "g"
  );
  const showRe = new RegExp(
    `<a href="(${BASE}/[a-z]+/checkout/showing/[^/]+/(\\d+))">\\s*([\\d:]+\\s*[AP]M)\\s*</a>`,
    "g"
  );

  const films = [];
  let f;
  while ((f = filmRe.exec(html)) !== null) {
    const [, filmSite, slug, title, block] = f;
    if (site && filmSite !== site) continue;
    const shows = [];
    let s;
    showRe.lastIndex = 0;
    while ((s = showRe.exec(block)) !== null) {
      const time = to24h(s[3]);
      if (time) shows.push({ showingId: s[2], time, buyUrl: s[1] });
    }
    if (!shows.length) continue;
    // The 70mm run is its own film entry, so the flag comes from the title.
    const imax70mm = /70\s*mm/i.test(slug) || /70\s*mm/i.test(title);
    films.push({ site: filmSite, slug, title: title.trim(), imax70mm, shows });
  }
  return films;
}

/** Flattened showings for one site, cached for the day. */
async function getShowtimesForSite({ site, dateISO }) {
  const key = `brenden-${site}-${dateISO}`;
  const now = new Date();
  const ttl = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;

  const cached = await readCache(key, ttl);
  if (cached) return cached;

  const res = await fetch(`${BASE}/${site}/showtimes`, { timeout: REQUEST_TIMEOUT_MS });
  if (!res.ok) throw new Error(`Brenden showtimes request failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  const films = parseShowtimes(html, site);
  if (!films.length) {
    throw new Error(`Brenden: parsed no films from /${site}/showtimes (${html.length} bytes) -- page shape may have changed`);
  }

  const out = [];
  for (const film of films) {
    for (const sh of film.shows) {
      out.push({
        movieName: film.title,
        slug: film.slug,
        imax70mm: film.imax70mm,
        time: sh.time,
        showingId: sh.showingId,
        buyUrl: sh.buyUrl,
        dateISO,
      });
    }
  }
  writeCache(key, out, ttl);
  console.error(`Brenden [${site}]: ${out.length} showing(s), ${out.filter((x) => x.imax70mm).length} on IMAX 70mm.`);
  return out;
}

module.exports = { parseShowtimes, getShowtimesForSite, to24h, BASE };
