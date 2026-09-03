// Celebration! Cinema -- Michigan regional chain, Vista platform.
//
// No API call needed and no proxy: each cinema page embeds its entire schedule
// as JSON, and robots.txt is "User-agent: * / Allow: /". One GET returns every
// session that cinema has on sale -- 1145 of them for GR North on a real fetch,
// spanning several DAYS, not just today.
//
// The JSON is doubly escaped: entity-encoded into an HTML attribute, with its
// own quotes backslash-escaped inside that. Decode both layers and it is
// ordinary JSON text.
//
// WHY THIS MATTERS FOR 70mm: SessionAttributesNames carries "IMAX70mm" as a
// distinct value, sitting alongside ordinary ones like "AD,CC", "7.1" and
// "OC,SENSORY". That is a STATED 70mm flag, where Atom costs a Firecrawl
// credit per venue per day and Harkins only ever says "IMAX". Confirmed live
// 2026-09-03: 253 of 1145 sessions tagged IMAX70mm, today's at 11:40, 15:20,
// 19:00 and 22:40.
//
// StartTime carries a real offset ("2026-09-03T11:40:00-04:00"), unlike Apple
// Cinemas' schedule which labels local times "+00:00".

const fetch = require("node-fetch");
const { readCache, writeCache } = require("../disk-cache");

const BASE = "https://www.celebrationcinema.com";
const REQUEST_TIMEOUT_MS = 45000;   // the pages are ~2.3MB

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");   // last: an &amp;quot; must not become a quote
}

/**
 * Sessions for ONE cinema out of a cinema page's HTML.
 *
 * cinemaId filters deliberately. A page carries a few stray ids from other
 * locations (cross-references in disabledshowtimes) -- on GR North its own
 * "002" appeared 3549 times against 1-9 for six others, so an unfiltered parse
 * would quietly mix in another cinema's showtimes.
 */
function parseSessions(html, cinemaId) {
  const decoded = decodeEntities(html).replace(/\\"/g, '"');

  // The film title lives on the ENCLOSING object, not the session -- the shape
  // is {"Title":"The Odyssey","Showtime":[{...},{...}]}. Note "Title" is reused
  // INSIDE each session for the Vista id, so the film title has to come from
  // the outer occurrence that is immediately followed by "Showtime":[.
  const filmAt = [];
  const filmRe = /"Title":"([^"]*)","Showtime":\[/g;
  let f;
  while ((f = filmRe.exec(decoded)) !== null) filmAt.push({ index: f.index, title: f[1] });
  const titleFor = (pos) => {
    let title = null;
    for (const entry of filmAt) {
      if (entry.index > pos) break;
      title = entry.title;
    }
    return title;
  };

  const re = /"RunTime":"([^"]*)","StartTime":"([^"]*)","Date":"([^"]*)","Title":"([^"]*)"[^{}]*?"SessionAttributesNames":"([^"]*)"[^{}]*?"SessionID":"([^"]*)"/g;
  const out = [];
  let m;
  while ((m = re.exec(decoded)) !== null) {
    const [, runTime, startTime, date, vistaId, attrs, sessionId] = m;
    if (cinemaId && !String(vistaId).startsWith(`${cinemaId}-`)) continue;
    out.push({
      vistaId,
      sessionId,
      cinemaId: String(vistaId).split("-")[0],
      movieName: titleFor(m.index),
      startTime,                                   // ISO with a real offset
      time: startTime.slice(11, 16),               // local HH:MM, as displayed
      dateISO: date,
      runTime,
      attributes: attrs ? attrs.split(",").map((a) => a.trim()).filter(Boolean) : [],
      imax70mm: /(^|,)\s*IMAX70mm\s*(,|$)/i.test(attrs || ""),
      bookingUrl: `${BASE}/showtimes/booking/${vistaId}`,
    });
  }
  return out;
}

/**
 * One cinema's sessions, cached for the day. The page is ~2.3MB and the site
 * started refusing connections after a handful of rapid fetches during
 * development, so this is deliberately one request per cinema per day.
 */
async function getSessionsForCinema({ slug, cinemaId, dateISO }) {
  const key = `celebration-${slug}-${dateISO}`;
  const now = new Date();
  const ttl = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;

  const cached = await readCache(key, ttl);
  if (cached) return cached;

  const res = await fetch(`${BASE}/cinemas/${slug}`, { timeout: REQUEST_TIMEOUT_MS });
  if (!res.ok) throw new Error(`Celebration page request failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  const all = parseSessions(html, cinemaId);
  if (!all.length) {
    throw new Error(
      `Celebration: parsed no sessions from ${slug} (${Math.round(html.length / 1024)}KB) -- ` +
      `the embedded-JSON shape may have changed`
    );
  }
  writeCache(key, all, ttl);
  console.error(
    `Celebration [${slug}]: ${all.length} session(s), ${all.filter((s) => s.imax70mm).length} on IMAX 70mm.`
  );
  return all;
}

/** Sessions at one cinema on one date. */
async function getShowtimesForCinema({ slug, cinemaId, dateISO }) {
  const all = await getSessionsForCinema({ slug, cinemaId, dateISO });
  return all.filter((s) => s.dateISO === dateISO);
}

module.exports = { parseSessions, getSessionsForCinema, getShowtimesForCinema, BASE };
