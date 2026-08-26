// Fetches Regal showtimes and pricing from Atom Tickets instead of
// going through the Regal proxy chain. Atom Tickets is a legitimate
// Regal ticket reseller. Their theater page and checkout page are plain
// SSR HTML -- no Cloudflare, no proxy needed, just two GET requests.
//
// Flow:
//   1. lookupAtomVenue(theaterName) -- search Atom for the venue ID, cached
//   2. getAtomShowtimes({ theaterName, dateISO, movieTitle }) -- theater page
//   3. getAtomCheckoutPricing(checkoutId) -- checkout page for one showing
//
// Note: Atom blocks Render's server IP with a 403. On a 403, we fall back to
// fetchWithRotation (byparr first -- free, self-hosted) so we still bypass
// the much heavier Regal createOrder flow even when a proxy is needed.

const fetch = require("node-fetch");
const { readDiskCache, writeDiskCache } = require("../disk-cache");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};
const FETCH_TIMEOUT_MS = 12000;

// In-memory: `atom-st-${venueId}-${dateISO}` → { showtimes, expiresAt }
const showtimesMemCache = new Map();

// Fetch Atom URL directly; on 403 fall back to byparr (free, self-hosted).
// We call byparr's raw /v1 API directly rather than going through
// fetchWithRotation, because the generic proxy chain throws when it sees
// HTML instead of JSON (it's wired for Regal's JSON API endpoints).
// Byparr returns HTML in envelope.solution.response -- we extract that.
async function atomGet(url) {
  const res = await fetch(url, { headers: HEADERS, timeout: FETCH_TIMEOUT_MS });
  if (res.status !== 403) {
    if (!res.ok) throw new Error(`Atom Tickets HTTP ${res.status} for ${url}`);
    return res.text();
  }

  console.error(`Atom direct fetch 403 for ${url} -- retrying via byparr`);
  const byparrUrl = process.env.BYPARR_URL;
  const byparrSecret = process.env.BYPARR_SECRET;
  if (!byparrUrl || !byparrSecret) {
    throw new Error(`Atom Tickets HTTP 403 for ${url} (byparr not configured)`);
  }

  // Short timeout: byparr spins up a full browser which is slow and often
  // times out for Atom (not Cloudflare-protected, just IP-blocked). Fail fast
  // so the caller can fall back to the Regal proxy chain without a 30s delay.
  const byparrRes = await fetch(`${byparrUrl}/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Byparr-Token": byparrSecret },
    body: JSON.stringify({ cmd: "request.get", url, session: "atom-tickets" }),
    timeout: 8000,
  });
  if (!byparrRes.ok) throw new Error(`byparr HTTP ${byparrRes.status} fetching ${url}`);

  const envelope = await byparrRes.json();
  if (envelope.status !== "ok") throw new Error(`byparr error: ${JSON.stringify(envelope).slice(0, 200)}`);

  const html = envelope.solution?.response;
  if (!html) throw new Error(`byparr: no solution.response for ${url}`);

  const targetStatus = envelope.solution?.status ?? 200;
  if (targetStatus >= 400) throw new Error(`Atom via byparr: target returned HTTP ${targetStatus}`);

  return html;
}

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Static seed map: Regal cinema code → Atom venue { slug, venueId }.
// Atom's search results are geo-based (Render's Virginia IP returns Virginia
// theaters, not Sacramento ones), so dynamic lookup from the server doesn't
// work. Add entries here when a new Regal theater needs Atom coverage;
// look up the Atom venueId from the URL on atomtickets.com/theaters/...
const REGAL_CODE_TO_ATOM = {
  "1413": { slug: "regal-delta-shores",       venueId: "47446" }, // Regal Delta Shores & IMAX, Sacramento CA
  "0774": { slug: "regal-natomas-marketplace", venueId: "6517"  }, // Regal Natomas Marketplace, Sacramento CA
};

// Look up a theater's Atom Tickets venue ID.
// Checks the static map first (by Regal cinema code) -- instant, no network.
// Returns { venueId, slug } or null if the theater is not mapped.
async function lookupAtomVenue(theaterName, regalCode) {
  if (regalCode && REGAL_CODE_TO_ATOM[regalCode]) {
    return REGAL_CODE_TO_ATOM[regalCode];
  }
  // Not in the static map. Log so it's easy to find and add an entry above.
  console.error(
    `Atom: no static entry for "${theaterName}" [${regalCode}] -- ` +
    `add to REGAL_CODE_TO_ATOM in atom-tickets.js if this theater is on Atom`
  );
  return null;
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
async function getAtomShowtimes({ theaterName, regalCode, dateISO, movieTitle }) {
  const venue = await lookupAtomVenue(theaterName, regalCode);
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
