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

  // CONFIRMED possible failure mode, not yet distinguished from a
  // parsing bug: the previous title-parsing fix was verified against a
  // hand-typed sample matching what a browser-rendering fetch tool
  // showed -- but THIS fetch is a plain no-JS request, same as any
  // script. If MediaStinger loads some of its listing content
  // client-side, this raw HTML could legitimately be missing entries
  // that a rendered browser would show, which would make the regex
  // irrelevant (nothing to parse if the text was never in the response
  // at all). Logging which case this actually is, directly, instead of
  // inferring it a second time from an indirect symptom.
  if (!/spider-man/i.test(html)) {
    console.error(
      `MediaStinger in-theaters fetch: "Spider-Man" does not appear anywhere in the raw HTML at all ` +
      `(${html.length} chars fetched). This means the gap is upstream of parsing entirely -- either the ` +
      `content is loaded client-side (a plain fetch here can't see it) or this specific fetch missed it for ` +
      `some other reason. Not a regex problem if this line is firing.`
    );
  }

  // Matches <a href="...-after-the-credits/">...</a>-shaped links.
  // CONFIRMED REAL BUG, found from a live diagnostic that pinpointed
  // this exact line: the old capture group ([^<]+) required the
  // anchor's entire content to be plain text with ZERO nested tags --
  // any link whose content includes even one inner element (e.g. a
  // rating badge like "+9" wrapped in its own <span> rather than being
  // plain trailing text) would silently fail to match at all, while
  // every plain-text-only title kept working normally. That's exactly
  // the confirmed symptom: 25 correct candidates, one specific real
  // title just never captured. Switched to a lazy multi-line match up
  // to the closing </a>, then strip any nested tags from the captured
  // span before applying the existing title/year extraction below --
  // strictly more permissive, so it still matches every previously-
  // working plain-text case identically.
  const pattern = /<a[^>]+href="(https:\/\/mediastinger\.com\/[^"]+-after-the-credits\/)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  const candidates = [];
  const seenUrls = new Set();
  while ((match = pattern.exec(html)) !== null) {
    const [, url, rawContent] = match;
    if (seenUrls.has(url)) continue; // the same movie's link appears multiple times on the page (image + title)
    seenUrls.add(url);
    // Strip any nested tags (e.g. a rating badge's own <span>) that the
    // new lazy match now tolerates, and collapse whitespace -- turns
    // the raw captured span into plain text before the year/title logic
    // below runs, so that logic doesn't need to know or care whether
    // the original markup had nested elements inside the anchor.
    // Strip tags, then decode HTML entities -- CONFIRMED REAL from a
    // live report: "Minions &#038; Monsters" showed up literally, entity
    // un-decoded, in the dropdown. Stripping <tags> was never the same
    // thing as decoding &entities; -- those are a separate HTML-encoding
    // concern that this parsing never handled at all until now. Numeric
    // entities (&#NNN;) are decoded generically via character code,
    // which covers any digit/character WordPress might encode without
    // needing an exhaustive lookup table; the handful of named entities
    // below cover the common cases numeric decoding can't (named
    // entities aren't just "&#" plus a number).
    const linkText = rawContent
      .replace(/<[^>]+>/g, "")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Strip a leading decorative pointer/arrow -- CONFIRMED REAL and
    // CONFIRMED UNIVERSAL from a live raw-JSON dump of every candidate
    // this function produced: literally every single title had a
    // leading "--> ", not just Spider-Man. That rules out the original
    // theory (something specific to the "Movies w/ Stingers" sidebar)
    // -- the real cause is broader: this site's entire dropdown/mega-
    // menu is one big nested navigation list, and every link inside it
    // apparently carries a decorative arrow icon as a literal text span
    // BEFORE the title (e.g. `<span>--></span>Title`), used to visually
    // mark nested menu items. The tag-stripping step above correctly
    // removes the <span> tags themselves, but leaves their literal text
    // content untouched -- tag removal isn't the same as removing what
    // was INSIDE the tag. That's why this affects every single title
    // uniformly rather than one specific section.
    const withoutLeadingArrow = linkText.replace(/^[\s\->»▶►]+/, "");
    const yearMatch = /\((\d{4})\)/.exec(withoutLeadingArrow);
    const titleOnly = yearMatch ? withoutLeadingArrow.slice(0, yearMatch.index).trim() : withoutLeadingArrow.trim();
    const year = yearMatch ? Number(yearMatch[1]) : null;

    // CONFIRMED REAL REGRESSION, caught from a live report: making the
    // regex above tolerate nested tags (needed for Spider-Man's badge)
    // also stopped it from accidentally filtering out every OTHER
    // badge-bearing entry on the page -- and this page uses the same
    // -after-the-credits/ URL pattern site-wide, not just for "in
    // theaters" movies. Real, confirmed cross-contamination: video
    // games (Days Gone, Call of Duty: Modern Warfare 3) from the Games
    // section, and old movies (Mulan 2020, Okja 2017) from "New On
    // Video" and "Top 100 Stingers" -- all sharing this page and this
    // URL pattern, previously hidden by the OLD bug rather than
    // genuinely excluded by correct scoping.
    //
    // The real fix would be scoping to the exact "In Theaters" HTML
    // section -- but that's not straightforward here: Spider-Man
    // itself doesn't live in the real in-theaters grid at all, only in
    // a separate "Movies w/ Stingers" sidebar teaser elsewhere on the
    // same page (confirmed from an earlier real fetch: the actual
    // chronological listing skips straight past its release date
    // without ever showing it). Scoping tightly enough to exclude Games
    // and New On Video would very likely exclude Spider-Man again.
    //
    // Using YEAR as the filter instead, since every wrong entry found
    // so far is old (2011-2020) and everything legitimately in theaters
    // right now is recent -- this targets the actual observed symptom
    // directly rather than guessing at markup boundaries a third time.
    // Cutoff is "this year or last" rather than "this year only", since
    // a movie can still be playing in January on a December release.
    const currentYear = new Date().getFullYear();
    const looksCurrent = year != null && year >= currentYear - 1;

    if (!titleOnly || !looksCurrent) continue;

    candidates.push({ url, title: titleOnly, year });
  }

  // Second half of the same diagnostic: if the raw HTML DID contain
  // "Spider-Man" but no candidate with that title made it into the
  // final list, the problem is in this regex/parsing loop specifically
  // -- distinct from the "not in the raw HTML at all" case logged
  // above, and needs a different fix (parsing logic, not fetch
  // completeness).
  if (/spider-man/i.test(html) && !candidates.some((c) => /spider-man/i.test(c.title))) {
    console.error(
      `MediaStinger in-theaters fetch: "Spider-Man" IS present in the raw HTML, but no candidate title ` +
      `matched it after parsing -- ${candidates.length} candidates total. This means the regex/parsing loop ` +
      `is the problem, not fetch completeness. Candidates found: ${JSON.stringify(candidates.map((c) => c.title))}`
    );
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
//
// Sorted alphabetically (case-insensitive) rather than left in
// MediaStinger's own default order (release-date descending) -- a long
// unsorted-by-name dropdown is hard to scan for a specific title, and
// alphabetical is the more natural way to search a list by name rather
// than by when it came out.
async function getInTheatersList() {
  const candidates = await fetchInTheatersCandidates();
  return candidates
    .map((c) => c.title)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
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
