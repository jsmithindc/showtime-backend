const fetch = require("node-fetch");
const { readCache, writeCache } = require("./disk-cache");

// 70mm confirmation from Atom Tickets, for the venues our own adapters cannot
// answer for: Cinemark (whose showtimes API is movie-scoped, not
// theater-scoped) and the museums and independents with no adapter at all.
//
// Atom tags a film's showtime group with an IMAX70MM attribute image, which is
// the only machine-readable "this is the film print" signal available for
// those venues. Validated against Harkins Arizona Mills, where Atom's 70mm
// times (11:45/15:30/19:15/23:00) match Harkins' own "IMAX" sessions exactly,
// and its non-70mm times match Harkins' "Digital" ones -- so the attribute
// tracks reality rather than being decorative.
//
// robots.txt: /theaters/... is permitted. /search and /checkout are NOT, and
// nothing here touches them.
//
// COSTS A FIRECRAWL CREDIT per venue per day. Atom is Cloudflare-protected, so
// a direct fetch returns 403 and a browser-rendering proxy is the only way in.
// Cached to midnight through the shared tier, so it is one fetch per venue per
// DAY across every search and every container -- not one per query.

const CACHE_PREFIX = "atom-70mm";

// Firecrawl rate-limits. Fetching all twelve uncovered venues at once returned
// HTTP 429 for three of them, which showed up as "unchecked" venues rather
// than as an error. Serialised with a small gap instead: results are cached to
// midnight, so this cost is paid once per venue per day and a slower first
// call is invisible afterwards.
const FETCH_GAP_MS = 1200;
let fetchQueue = Promise.resolve();
function queued(fn) {
  const run = fetchQueue.then(async () => {
    await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
    return fn();
  });
  fetchQueue = run.catch(() => {});
  return run;
}

function isConfigured() {
  return !!process.env.FIRECRAWL_API_KEY;
}

function msUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(midnight - now, 5 * 60 * 1000);
}

/**
 * Films and showtimes from one Atom theater page, grouped by format block.
 * Returns [{ movieName, imax70mm, times }]; times are Atom's own 12-hour
 * strings ("7:15 PM").
 */
function to24h(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t).trim());
  if (!m) return t;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function parseAtomTheaterPage(md) {
  const out = [];
  // Films are "## [Title](url)" headings; a film's block runs to the next one.
  const parts = String(md || "").split(/^## \[/m).slice(1);
  for (const part of parts) {
    const title = (part.match(/^([^\]]+)\]/) || [])[1];
    if (!title) continue;
    // Within a film, each "Film format:" marker opens a group and the times
    // after it belong to that format. A film commonly has both a 70mm group
    // and a digital one, and conflating them is the whole thing to avoid.
    const groups = part.split(/\*\*Film format:/).slice(1);
    for (const b of (groups.length ? groups : [part])) {
      const times = [...new Set(
        [...b.matchAll(/\b(?:1[0-2]|0?[1-9]):[0-5][0-9]\s?(?:AM|PM)\b/gi)]
          .map((m) => m[0].toUpperCase().replace(/\s+/, " "))
      )];
      if (!times.length) continue;
      // Normalised to 24h so a mixed list doesn't render "19:00" beside
      // "7:00 PM" depending on which source answered.
      out.push({
        movieName: title.trim(),
        imax70mm: /IMAX70MM/i.test(b),
        times: times.map(to24h),
      });
    }
  }
  return out;
}

async function fetchViaFirecrawl(url, attempt = 0) {
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false }),
    timeout: 120000,
  });
  // 429 is Firecrawl's rate limit, not a refusal of the page. One backoff
  // retry, because losing a venue to a transient limit reads to the user as
  // "we can't check this theater" -- a permanent-sounding claim for a
  // temporary condition. A second 429 is treated as real (it usually means
  // the plan's quota, not pacing) and the venue reports unchecked.
  if (res.status === 429 && attempt === 0) {
    await new Promise((r) => setTimeout(r, 6000));
    return fetchViaFirecrawl(url, 1);
  }
  if (!res.ok) throw new Error(`firecrawl HTTP ${res.status}`);
  const json = await res.json();
  const md = json && json.data && json.data.markdown;
  if (!md) throw new Error("firecrawl returned no markdown");
  return md;
}

/**
 * Showings at one venue, from its Atom page. Cached to midnight.
 * Returns null when unavailable rather than throwing -- a missing confirmation
 * must never take down the venue list it was meant to enrich.
 */
async function getAtomShowings({ atomSlug, dateISO }) {
  if (!isConfigured() || !atomSlug) return null;
  const key = `${CACHE_PREFIX}-${atomSlug.replace(/\//g, "-")}-${dateISO}`;
  const ttl = msUntilMidnight();
  try {
    const cached = await readCache(key, ttl);
    if (cached) return cached;
  } catch { /* fall through to a fetch */ }

  try {
    const url = `https://www.atomtickets.com/theaters/${atomSlug}?date=${encodeURIComponent(dateISO)}`;
    const rows = parseAtomTheaterPage(await queued(() => fetchViaFirecrawl(url)));
    // Cache even an empty result: a venue with nothing on today would
    // otherwise be re-fetched, at a credit each time, for the rest of the day.
    writeCache(key, rows, ttl);
    console.error(`Atom 70mm [${atomSlug}] ${dateISO}: ${rows.length} format block(s), ${rows.filter((r) => r.imax70mm).length} on 70mm.`);
    return rows;
  } catch (err) {
    console.error(`Atom 70mm [${atomSlug}] failed:`, err.message);
    return null;
  }
}

module.exports = { getAtomShowings, parseAtomTheaterPage, isConfigured };
