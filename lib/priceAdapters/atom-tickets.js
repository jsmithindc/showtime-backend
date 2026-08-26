// Fetches Regal showtimes and pricing from Atom Tickets instead of
// going through the Regal proxy chain. Atom Tickets is a legitimate
// Regal ticket reseller. Their theater page and checkout page are plain
// SSR HTML -- no Cloudflare, no proxy needed, just two GET requests.
//
// Flow:
//   1. lookupAtomVenue(theaterName) -- search Atom for the venue ID, cached
//   2. getAtomShowtimes({ theaterName, dateISO, movieTitle }) -- theater page
//   3. getAtomCheckoutPricing(checkoutId) -- checkout page for one showing

const fetch = require("node-fetch");
const { readDiskCache, writeDiskCache } = require("../disk-cache");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};
const FETCH_TIMEOUT_MS = 12000;

// 7-day TTL for venue ID lookups (Atom venue IDs are stable)
const VENUE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// In-memory: normalized theater name → { venueId, slug } | null
const venueMemCache = new Map();

// In-memory: `atom-st-${venueId}-${dateISO}` → { showtimes, expiresAt }
const showtimesMemCache = new Map();

async function atomGet(url) {
  const res = await fetch(url, { headers: HEADERS, timeout: FETCH_TIMEOUT_MS });
  if (!res.ok) throw new Error(`Atom Tickets HTTP ${res.status} for ${url}`);
  return res.text();
}

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Derive Atom Tickets URL slug candidates from a theater name.
// Atom slugs are typically the name lowercased with spaces as hyphens.
function candidateSlugs(theaterName) {
  const base = theaterName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .replace(/\s+/g, "-");
  const withoutNoise = theaterName
    .toLowerCase()
    .replace(/\b(ua|cinemas?|theatres?|stadium|multiplex)\b/gi, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  const candidates = [base];
  if (withoutNoise !== base) candidates.push(withoutNoise);
  return candidates;
}

// Look up a theater's Atom Tickets venue ID.
// Strategy 1: derive slug from name, fetch /theaters/{slug} and read the
//   venue ID from the redirect's final URL (/theaters/{slug}/{id}).
//   This is reliable because it's pure SSR — no JavaScript needed.
// Strategy 2: scan the search page HTML for theater links (fallback;
//   may return nothing if Atom renders results client-side from the server).
// Returns { venueId, slug } or null. Cached in-memory + on disk (7-day TTL).
async function lookupAtomVenue(theaterName) {
  const normName = norm(theaterName);
  if (venueMemCache.has(normName)) return venueMemCache.get(normName);

  const diskKey = `atom-venue-${normName}`;
  const diskHit = readDiskCache(diskKey, VENUE_CACHE_TTL_MS);
  if (diskHit !== null) {
    venueMemCache.set(normName, diskHit);
    return diskHit;
  }

  let result = null;

  // Strategy 1: slug-based redirect lookup
  for (const slug of candidateSlugs(theaterName)) {
    try {
      const res = await fetch(`https://www.atomtickets.com/theaters/${slug}`, {
        headers: HEADERS,
        timeout: FETCH_TIMEOUT_MS,
        redirect: "follow",
      });
      if (res.ok) {
        const m = res.url.match(/\/theaters\/([^/?#]+)\/(\d+)/);
        if (m) { result = { slug: m[1], venueId: m[2] }; break; }
      }
    } catch (_) { /* try next */ }
  }

  // Strategy 2: search page scan (may be JS-rendered and return nothing)
  if (!result) {
    try {
      const html = await atomGet(`https://www.atomtickets.com/search?q=${encodeURIComponent(theaterName)}`);
      const nameCore = normName.replace("regal", "").replace(/cinemas?/, "").replace(/theatres?/, "").trim();
      for (const [, slug, venueId] of html.matchAll(/href="\/theaters\/([^/"]+)\/(\d+)"/g)) {
        if (!slug.includes("regal")) continue;
        const slugCore = norm(slug.replace(/-/g, " ")).replace("regal", "").trim();
        if (nameCore.length >= 4 && (slugCore.includes(nameCore) || nameCore.includes(slugCore))) {
          result = { venueId, slug }; break;
        }
      }
    } catch (_) { /* search failed; result stays null */ }
  }

  venueMemCache.set(normName, result);
  writeDiskCache(diskKey, result);
  console.error(`Atom venue lookup "${theaterName}": ${result ? `${result.slug}/${result.venueId}` : "not found on Atom"}`);
  return result;
}

// Parse the Atom Tickets theater page HTML for one movie's showtimes.
// Returns [{time12h: "10:00 AM", format: "Standard", checkoutId: "639818313"}].
function parseAtomTheaterPage(html, movieTitle) {
  const { matchesMovie } = require("./serpapi");
  const results = [];

  // Split into showtime-panel sections
  const panelParts = html.split('class="showtime-panel"');
  for (let i = 1; i < panelParts.length; i++) {
    const panel = panelParts[i];

    // Extract movie title from <h2>
    const titleMatch = panel.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!titleMatch) continue;
    const panelTitle = titleMatch[1].replace(/<[^>]+>/g, "").trim();
    if (!matchesMovie(panelTitle, movieTitle)) continue;

    // Split into format sections (each starts at a format-info anchor)
    const formatParts = panel.split('class="format-showtimes__format-info');
    for (let j = 1; j < formatParts.length; j++) {
      const fPart = formatParts[j];

      // Format name is in primary-attribute-text
      const fmtMatch = fPart.match(/primary-attribute-text[^>]*>\s*([^<]*?)\s*</);
      const rawFormat = fmtMatch ? fmtMatch[1].trim() : "";
      const format = deriveAtomFormat(rawFormat);

      // Individual time buttons: <a href="/checkout/{id}"> TIME </a>
      const timeBtnRe = /href="\/checkout\/(\d+)"[^>]*>\s*(\d+:\d+\s*[AP]M)\s*</g;
      for (const [, checkoutId, time] of fPart.matchAll(timeBtnRe)) {
        results.push({ time12h: time.trim(), format, checkoutId });
      }
    }
  }

  return results;
}

function deriveAtomFormat(raw) {
  if (!raw || /standard/i.test(raw)) return "Standard";
  const map = [
    [/\bimax\b/i, "IMAX"],
    [/\brpx\b/i, "RPX"],
    [/\b4dx\b/i, "4DX"],
    [/\bscreenx\b/i, "ScreenX"],
    [/\bd-?box\b/i, "D-BOX"],
    [/\bdolby\b/i, "Dolby"],
    [/\bprime\b/i, "Prime"],
    [/\bbigd\b/i, "BigD"],
    [/\bultra\b/i, "Ultra"],
    [/\b3d\b/i, "3D"],
  ];
  for (const [re, label] of map) {
    if (re.test(raw)) return label;
  }
  return raw || "Standard";
}

// Parse the Atom Tickets checkout page for ticket pricing.
// Returns { adultCents, baseCents, feeCents } or null if unparseable.
function parseAtomCheckoutPage(html) {
  const rowParts = html.split('class="ticket-row');
  const types = [];

  for (let i = 1; i < rowParts.length; i++) {
    const row = rowParts[i];
    // Skip rows hidden via inline style (display: none)
    if (/style=["'][^"']*display\s*:\s*none/i.test(row.slice(0, 100))) continue;

    const typeMatch = row.match(/<div[^>]+class="type"[^>]*>([\s\S]*?)<\/div>/);
    if (!typeMatch) continue;
    const typeName = typeMatch[1].replace(/<[^>]+>/g, "").trim();
    if (!typeName) continue;

    // "$14.68 ... (including $2.19 service fee)"
    const priceMatch = row.match(/\$(\d+\.\d{2})[\s\S]{0,200}?\(including \$(\d+\.\d{2}) service fee\)/);
    if (!priceMatch) continue;

    const totalCents = Math.round(parseFloat(priceMatch[1]) * 100);
    const feeCents = Math.round(parseFloat(priceMatch[2]) * 100);
    types.push({ type: typeName, totalCents, feeCents });
  }

  if (types.length === 0) return null;
  const adult = types.find((t) => /adult/i.test(t.type)) || types[0];
  return {
    adultCents: adult.totalCents,
    feeCents: adult.feeCents,
    baseCents: adult.totalCents - adult.feeCents,
  };
}

// Convert "10:00 AM" / "9:20 PM" to "10:00" / "21:20" (HH:MM, 24h).
function atomTimeTo24h(time12h) {
  const m = time12h.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const pm = m[3].toUpperCase() === "PM";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

// Fetch the Atom theater page and return all showtimes for the given movie.
// Returns { found: boolean, showtimes: [{time12h, time24h, format, checkoutId}] }.
// `found: false` means the theater isn't listed on Atom and caller should fall back.
async function getAtomShowtimes({ theaterName, dateISO, movieTitle }) {
  const venue = await lookupAtomVenue(theaterName);
  if (!venue) return { found: false, showtimes: [] };

  // Cache theater page listing until midnight (same pattern as Regal listing cache)
  const cacheKey = `atom-st-${venue.venueId}-${dateISO}`;
  const [cy, cm, cd] = dateISO.split("-").map(Number);
  const midnight = new Date(Date.UTC(cy, cm - 1, cd + 1)).getTime();
  const ttlMs = Math.max(midnight - Date.now(), 5 * 60 * 1000);

  let allShowtimes;
  const memHit = showtimesMemCache.get(cacheKey);
  if (memHit && Date.now() < memHit.expiresAt) {
    allShowtimes = memHit.data;
  } else {
    const diskHit = readDiskCache(cacheKey, ttlMs);
    if (diskHit) {
      allShowtimes = diskHit;
      showtimesMemCache.set(cacheKey, { data: diskHit, expiresAt: Date.now() + ttlMs });
    } else {
      const html = await atomGet(`https://www.atomtickets.com/theaters/${venue.slug}/${venue.venueId}?date=${dateISO}`);
      // Cache the raw parsed results keyed by venueId+date (across all movies)
      // so multiple movie lookups at the same theater reuse the page fetch.
      allShowtimes = _parseAllMovies(html);
      showtimesMemCache.set(cacheKey, { data: allShowtimes, expiresAt: Date.now() + ttlMs });
      writeDiskCache(cacheKey, allShowtimes);
    }
  }

  const { matchesMovie } = require("./serpapi");
  const showtimes = allShowtimes
    .filter((s) => matchesMovie(s.movieTitle, movieTitle))
    .map((s) => ({ ...s, time24h: atomTimeTo24h(s.time12h) }))
    .filter((s) => s.time24h !== null);

  console.error(
    `Atom [${venue.venueId}] ${dateISO}: ${showtimes.length} showtime(s) for "${movieTitle}" ` +
      `(${[...new Set(allShowtimes.map((s) => s.movieTitle))].join(", ")})`
  );

  return { found: true, showtimes };
}

// Parse ALL movies from the theater page so the cache is reusable across
// different movie lookups for the same theater+date.
function _parseAllMovies(html) {
  const results = [];
  const panelParts = html.split('class="showtime-panel"');
  for (let i = 1; i < panelParts.length; i++) {
    const panel = panelParts[i];
    const titleMatch = panel.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!titleMatch) continue;
    const movieTitle = titleMatch[1].replace(/<[^>]+>/g, "").trim();

    const formatParts = panel.split('class="format-showtimes__format-info');
    for (let j = 1; j < formatParts.length; j++) {
      const fPart = formatParts[j];
      const fmtMatch = fPart.match(/primary-attribute-text[^>]*>\s*([^<]*?)\s*</);
      const format = deriveAtomFormat(fmtMatch ? fmtMatch[1].trim() : "");
      const timeBtnRe = /href="\/checkout\/(\d+)"[^>]*>\s*(\d+:\d+\s*[AP]M)\s*</g;
      for (const [, checkoutId, time] of fPart.matchAll(timeBtnRe)) {
        results.push({ movieTitle, time12h: time.trim(), format, checkoutId });
      }
    }
  }
  return results;
}

// Fetch checkout pricing for one specific Atom showtime.
// Returns { adultCents, baseCents, feeCents } or null.
async function getAtomCheckoutPricing(checkoutId) {
  const html = await atomGet(`https://www.atomtickets.com/checkout/${checkoutId}`);
  return parseAtomCheckoutPage(html);
}

module.exports = { lookupAtomVenue, getAtomShowtimes, getAtomCheckoutPricing, atomTimeTo24h };
