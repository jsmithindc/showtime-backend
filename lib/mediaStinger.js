const fetch = require("node-fetch");
const { matchesMovie } = require("./priceAdapters/serpapi");

// MediaStinger.com has no public API, but is a plain server-rendered
// WordPress site (confirmed: meta-generator: WordPress 7.0.4) with no
// Cloudflare/JS-rendering issues -- a bare node-fetch works fine, unlike
// several other targets in this project. Confirmed real page structure
// against a real fetched page (spider-man-brand-new-day-2026-after-the-
// credits/): a heading with the stinger summary, "During the Credits"
// and "After the Credits" sections with real sentences, a numeric
// "User Rating", and a "Running Time" field (bonus real runtime data).
//
// URL pattern confirmed real: mediastinger.com/{slugified-title}-{year}-
// after-the-credits/ -- but NOT reliable to guess blindly: some titles
// omit the year in their slug when there's no ambiguity (e.g. "Spider-
// Man: Into the Spider-Verse" has no year in its slug), and punctuation
// gets stripped in ways that are hard to predict perfectly (colons,
// apostrophes, ampersands). WordPress's default ?s= search parameter
// was tried and confirmed NOT to actually filter results on this site
// (it just returns generic homepage content) -- so it's not a usable
// discovery mechanism here.
//
// Instead: try the most likely direct URL guess first (fast, works for
// the common case), and fall back to scanning the site's /in-theaters
// listing page for a fuzzy title match if that guess 404s. Since this
// app only ever looks up movies currently playing in theaters, that
// listing should contain almost everything this gets asked about.

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
};

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\w\s-]/g, "") // strip punctuation (colons, apostrophes, periods, etc.)
    .trim()
    .replace(/\s+/g, "-");
}

function guessUrl(title, year) {
  const slug = slugify(title);
  return `https://mediastinger.com/${slug}${year ? `-${year}` : ""}-after-the-credits/`;
}

// Scans the /in-theaters listing for a title match. Confirmed real
// structure: entries look like "### [Title (Year)](url)Extra Scene
// After the Credits" in the markdown-flavored view; matching directly
// against raw HTML instead, so the exact pattern here is a best-effort
// regex over anchor text + href pairs, not verified against true raw
// bytes -- if MediaStinger changes their template this may need
// adjusting.
// Fetches and parses the /in-theaters listing once -- shared by both
// findViaInTheatersList (single-title lookup, used as the stinger-info
// fallback) and getInTheatersList (the full list, used to pre-populate
// the movie dropdown without needing the user's location first).
//
// Cached with a 6-hour TTL: this doesn't need to be instant-fresh (movie
// lineups don't change hour to hour), and re-fetching on every single
// page load would be wasteful for a page that's likely opened
// repeatedly in the same evening.
const IN_THEATERS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let inTheatersCache = null; // { candidates, fetchedAt }

async function fetchInTheatersCandidates() {
  if (inTheatersCache && Date.now() - inTheatersCache.fetchedAt < IN_THEATERS_CACHE_TTL_MS) {
    return inTheatersCache.candidates;
  }

  const res = await fetch("https://mediastinger.com/in-theaters", { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`MediaStinger in-theaters page request failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();

  // Matches <a href="...-after-the-credits/">Title (Year)</a>-shaped
  // links -- deliberately loose (doesn't assume a specific surrounding
  // tag structure) since the exact markup wasn't confirmed against raw
  // bytes.
  const pattern = /<a[^>]+href="(https:\/\/mediastinger\.com\/[^"]+-after-the-credits\/)"[^>]*>([^<]+)<\/a>/g;
  let match;
  const candidates = [];
  const seenUrls = new Set();
  while ((match = pattern.exec(html)) !== null) {
    const [, url, linkText] = match;
    if (seenUrls.has(url)) continue; // the same movie's link appears multiple times on the page (image + title)
    seenUrls.add(url);
    // Strip a trailing "(YYYY)" if present, to get just the title
    const yearMatch = /\((\d{4})\)\s*$/.exec(linkText);
    const titleOnly = linkText.replace(/\s*\(\d{4}\)\s*$/, "").trim();
    candidates.push({ url, title: titleOnly, year: yearMatch ? Number(yearMatch[1]) : null });
  }

  inTheatersCache = { candidates, fetchedAt: Date.now() };
  return candidates;
}

async function findViaInTheatersList(movieTitle) {
  const candidates = await fetchInTheatersCandidates();
  const found = candidates.find((c) => matchesMovie(c.title, movieTitle));
  return found ? found.url : null;
}

// The full list, for pre-populating the movie dropdown without needing
// the user's location at all -- "currently in theaters" is inherently
// location-independent for wide releases, which covers the large
// majority of what people are actually searching for. Doesn't replace
// "Load nearby" (still needed for anything playing only at a specific
// local/independent theater that wouldn't appear in a general
// nationwide listing), just removes the wait for the common case.
async function getInTheatersList() {
  const candidates = await fetchInTheatersCandidates();
  return candidates.map((c) => c.title);
}


function extractBetween(html, startMarker, endMarkers, searchFromIndex = 0) {
  const startIdx = html.indexOf(startMarker, searchFromIndex);
  if (startIdx === -1) return { text: null, foundAt: -1 };
  const searchFrom = startIdx + startMarker.length;
  let endIdx = html.length;
  for (const marker of endMarkers) {
    const idx = html.indexOf(marker, searchFrom);
    if (idx !== -1 && idx < endIdx) endIdx = idx;
  }
  const text = html.slice(searchFrom, endIdx).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { text, foundAt: startIdx };
}

// Extracts stinger info from a real MediaStinger movie page. Best-effort
// against real page text confirmed via a fetched sample -- the During/
// After Credits sections and Running Time field were directly observed;
// the exact surrounding HTML tags were not (that fetch went through a
// tool that converts HTML to markdown-flavored text, not raw bytes).
//
// CONFIRMED REAL BUG, now fixed: anchoring the "During the Credits" /
// "After the Credits" search from the start of the page (or from
// wherever "During the Credits" happened to be found) picked up an
// unrelated match from the site's global navigation menu instead of the
// real content -- specifically, a trailer article titled "Deadpool Shows
// Up After the Credits of..." that appears in the nav on every single
// page. This happened for a movie with a CONFIRMED "no stinger" answer
// (a different state than "we don't know yet"), which apparently
// doesn't render the same "### During the Credits" heading text my
// original anchor relied on.
//
// Fix: anchor to "Running Time:" instead -- a page-template field label
// that should appear on every movie page regardless of stinger status
// (even when the value itself is "N/A"), and sits structurally right
// before the real During/After Credits content, well past the nav menu.
function parseStingerPage(html, pageUrl) {
  const runtimeLabelIdx = html.indexOf("Running Time:");
  const contentSearchStart = runtimeLabelIdx !== -1 ? runtimeLabelIdx : 0;

  const during = extractBetween(html, "During the Credits", ["After the Credits", "</section", "<footer"], contentSearchStart);
  const afterSearchStart = during.foundAt !== -1 ? during.foundAt : contentSearchStart;
  const after = extractBetween(
    html,
    "After the Credits",
    ["Stinger information", "You Should STAY", "</section", "<footer"],
    afterSearchStart
  );

  // Safety net: real During/After Credits sentences are short (a
  // handful of sentences at most). If extraction somehow grabbed a huge
  // chunk of text again -- e.g. because the page structure differs in
  // some other way this hasn't hit yet -- treat it as a failed
  // extraction rather than ever displaying an unrelated wall of text.
  const MAX_REASONABLE_LENGTH = 600;
  const duringText = during.text && during.text.length <= MAX_REASONABLE_LENGTH ? during.text : null;
  const afterText = after.text && after.text.length <= MAX_REASONABLE_LENGTH ? after.text : null;

  const ratingMatch = /User Rating:\s*([+-]?\d+)/.exec(html);
  const rating = ratingMatch ? Number(ratingMatch[1]) : null;

  const runtimeMatch = /Running Time:\s*(\d+)\s*minutes/.exec(html);
  const runtimeMinutes = runtimeMatch ? Number(runtimeMatch[1]) : null;

  const noInfoAtAll = /we do not have any information/i.test(html);

  // UNCONFIRMED whether this is real server-rendered content or a
  // JS-populated widget -- it appeared right next to a "Please wait..."
  // placeholder in a real fetched page, which is sometimes a sign of
  // async loading. But MediaStinger's core content (During/After
  // Credits, Running Time) is confirmed server-rendered (this is a
  // plain WordPress site, not a JS-rendered SPA), so it's a reasonable
  // bet "Please wait..." belongs to some unrelated small widget nearby
  // (a live comment count, most likely) rather than this verdict itself.
  // If this comes back null on real pages that clearly do have a
  // verdict, that's the sign this guess was wrong.
  let verdict = null;
  if (/You Should STAY/i.test(html)) verdict = "STAY";
  else if (/You Should LEAVE/i.test(html)) verdict = "LEAVE";

  return {
    pageUrl,
    duringCredits: duringText,
    afterCredits: afterText,
    communityRating: rating,
    runtimeMinutes,
    verdict,
    // Worth showing if we got a verdict OR real spoiler text -- doesn't
    // require both, since the verdict alone (stay or leave) is useful
    // on its own even if the detailed spoiler text extraction came up
    // empty for some reason.
    hasInfo: !noInfoAtAll && (verdict != null || duringText != null || afterText != null),
  };
}

// In-memory cache -- same movie won't change mid-session, and this
// saves a real fetch on every single search for a movie you've already
// looked up once.
const cache = new Map();

async function getStingerInfo(movieTitle, year) {
  if (cache.has(movieTitle)) {
    return cache.get(movieTitle);
  }

  let pageUrl = null;
  let html = null;

  // Tier 1: guess the direct URL.
  try {
    const guessedUrl = guessUrl(movieTitle, year);
    const res = await fetch(guessedUrl, { headers: HEADERS });
    if (res.ok) {
      pageUrl = guessedUrl;
      html = await res.text();
    }
  } catch (err) {
    console.error(`MediaStinger: direct URL guess failed for "${movieTitle}":`, err.message);
  }

  // Tier 2: fall back to scanning the in-theaters list.
  if (!html) {
    try {
      const foundUrl = await findViaInTheatersList(movieTitle);
      if (foundUrl) {
        const res = await fetch(foundUrl, { headers: HEADERS });
        if (res.ok) {
          pageUrl = foundUrl;
          html = await res.text();
        }
      }
    } catch (err) {
      console.error(`MediaStinger: in-theaters list lookup failed for "${movieTitle}":`, err.message);
    }
  }

  const result = html ? parseStingerPage(html, pageUrl) : null;
  cache.set(movieTitle, result);
  return result;
}

module.exports = { getStingerInfo, slugify, guessUrl, getInTheatersList };
