const fetch = require("node-fetch");

// Harvests real movie data directly from a Cinemark theater page --
// confirmed live: a single theater page (cinemark.com/theatres/{slug})
// lists every movie currently showing there, each with its MPAA rating
// and runtime in plain text right after the title ("PG-13 2 hr 25 min"),
// AND embeds that movie's own CinemarkMovieId in its TicketSeatMap links
// nearby in the raw HTML. One real fetch during development returned 7
// movies' runtimes from a single page (Century DOCO and XD). This is
// the distributor's own data, not a Google Knowledge Graph guess for
// runtime, and not a hand-maintained map for movie IDs -- both are
// derived live from whatever's actually playing.
//
// Same caveat as scripts/build-cinemark-theater-map.js: the parsing here
// was verified against a markdown-converted view of these pages (via a
// tool that does server-side HTML-to-markdown conversion), not the raw
// HTML this module's plain node-fetch actually receives (except for the
// movie-ID extraction, which was written directly against real raw HTML
// captured earlier in this project). Treat the very first live call as
// the real test -- check the returned value actually looks right before
// relying on it.

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
};

function htmlToPlainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseHourMinToMinutes(hourPart, minPart) {
  const hours = hourPart ? parseInt(hourPart, 10) : 0;
  const mins = minPart ? parseInt(minPart, 10) : 0;
  return hours * 60 + mins;
}

// Cache the raw HTML once per slug -- a theater page's movie lineup
// doesn't change within a session, so repeat lookups for the same
// theater (multiple movies, multiple search requests) cost nothing
// after the first fetch. Both runtime and movie-ID lookups derive from
// this single cached fetch rather than each hitting the network
// separately.
const rawHtmlCache = new Map();

async function getRawHtml(slug) {
  if (rawHtmlCache.has(slug)) {
    return rawHtmlCache.get(slug);
  }

  const url = `https://www.cinemark.com/theatres/${slug}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Cinemark theater page request failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  rawHtmlCache.set(slug, html);
  return html;
}

async function getPlainText(slug) {
  const html = await getRawHtml(slug);
  return htmlToPlainText(html);
}

// Looks up the runtime for a SPECIFIC known movie title at a specific
// theater. Deliberately not a "scan the whole page and discover every
// title" function -- an earlier version tried that and the title
// extraction turned out fragile (surrounding link/button text bleeds
// into the match). Searching for an exact known title (the caller
// already has it from SerpApi's showtimes list) sidesteps that problem
// entirely: anchor on the title string, grab whatever rating+duration
// pattern immediately follows it.
async function getRuntimeForMovieAtTheater(slug, movieTitle) {
  const plainText = await getPlainText(slug);
  const escapedTitle = movieTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `${escapedTitle}\\s+(G|PG|PG-13|R|NC-17|NR|Ages \\d+-\\d+)\\s+(\\d+)\\s*hr(?:s)?(?:\\s+(\\d+)\\s*min)?`
  );
  const match = pattern.exec(plainText);
  if (!match) return null;
  const minutes = parseHourMinToMinutes(match[2], match[3]);
  return minutes || null;
}

// Looks up a SPECIFIC known movie's cinemarkMovieId at a specific
// theater -- the numeric ID Cinemark's own ticketing/showtimes API
// needs (different from the generic page-level movie id; confirmed
// real earlier in this project: Spider-Man's page id is 320559, its
// cinemarkMovieId is 107537). Confirmed real structure: a movie's title
// appears as heading text, and that movie's own TicketSeatMap links
// (each embedding CinemarkMovieId=NNNNN) follow shortly after in the
// raw HTML. This searches for the title in raw HTML (not the
// tag-stripped plain text runtime uses, since the ID lives inside an
// href attribute that plain-text stripping would destroy), then takes
// the first CinemarkMovieId found within a generous-but-bounded window
// afterward -- bounded so a very long page with many movies doesn't
// accidentally attribute a later movie's ID to an earlier title if this
// one's own links are somehow missing.
const TITLE_TO_ID_SEARCH_WINDOW = 8000; // characters

async function getCinemarkMovieIdForTitle(slug, movieTitle) {
  const html = await getRawHtml(slug);

  // Titles appear as plain visible text in the raw HTML (inside a
  // heading tag), so a literal substring search works -- but HTML
  // entity-encodes some characters (confirmed: &amp; for literal &), so
  // apply the same encoding to the search title for an exact match.
  const htmlEncodedTitle = movieTitle.replace(/&/g, "&amp;");
  const titleIndex = html.indexOf(htmlEncodedTitle);
  if (titleIndex === -1) return null;

  const searchWindow = html.slice(titleIndex, titleIndex + TITLE_TO_ID_SEARCH_WINDOW);
  const match = /CinemarkMovieId=(\d+)/.exec(searchWindow);
  return match ? match[1] : null;
}

module.exports = { getRuntimeForMovieAtTheater, getCinemarkMovieIdForTitle };
