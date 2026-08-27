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

// Fetch Atom URL directly; on 403 try a chain of fallback methods.
// We don't use fetchWithRotation because those providers throw on HTML
// responses (they're wired for Regal's JSON API endpoints). Instead we
// call each option directly, extracting raw HTML ourselves.
//
// Fallback order on 403:
//   1. Byparr (free, self-hosted) -- short timeout since it spins up a browser
//   2. Firecrawl (already configured, GET-only, returns rawHtml)
//   3. Cloudflare Worker (ATOM_PROXY_URL env var, optional simple GET proxy)
async function atomGet(url) {
  const res = await fetch(url, { headers: HEADERS, timeout: FETCH_TIMEOUT_MS });
  if (res.status !== 403) {
    if (!res.ok) throw new Error(`Atom Tickets HTTP ${res.status} for ${url}`);
    return res.text();
  }

  console.error(`Atom direct 403 for ${url} -- trying byparr → Firecrawl → CF Worker`);

  // 1. Byparr
  const byparrUrl = process.env.BYPARR_URL;
  const byparrSecret = process.env.BYPARR_SECRET;
  if (byparrUrl && byparrSecret) {
    try {
      const byparrRes = await fetch(`${byparrUrl}/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Byparr-Token": byparrSecret },
        body: JSON.stringify({ cmd: "request.get", url, session: "atom-tickets" }),
        timeout: 8000,
      });
      if (byparrRes.ok) {
        const envelope = await byparrRes.json();
        const targetStatus = envelope.solution?.status ?? 200;
        const html = envelope.solution?.response ?? "";
        if (envelope.status === "ok" && targetStatus < 400 && html) {
          console.error(`Atom via byparr: OK`);
          return html;
        }
      }
    } catch (err) {
      console.error(`Atom byparr failed: ${err.message}`);
    }
  }

  // 2. Firecrawl with JS-rendered HTML (formats: ["html"], not rawHtml).
  // Atom's theater page is a JS app -- rawHtml is the pre-JS shell where
  // showtime-panel appears only in CSS/JS bundles, not in actual DOM nodes.
  // The "html" format waits for JS to render before returning content.
  if (process.env.FIRECRAWL_API_KEY) {
    try {
      const fcRes = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, formats: ["html"], proxy: "stealth" }),
        timeout: 30000,
      });
      if (fcRes.ok) {
        const json = await fcRes.json();
        const html = json.data?.html ?? "";
        if (html && html.length > 1000) {
          console.error(`Atom via Firecrawl (html): OK, ${html.length} chars`);
          return html;
        }
      }
    } catch (err) {
      console.error(`Atom Firecrawl failed: ${err.message}`);
    }
  }

  // 3. Cloudflare Worker simple GET proxy (optional)
  // Deploy a worker that proxies: fetch(new URL(request.url).searchParams.get('url'))
  // Set ATOM_PROXY_URL=https://your-worker.workers.dev and ATOM_PROXY_SECRET=...
  const cfWorkerUrl = process.env.ATOM_PROXY_URL;
  const cfWorkerSecret = process.env.ATOM_PROXY_SECRET;
  if (cfWorkerUrl) {
    try {
      const proxyRes = await fetch(
        `${cfWorkerUrl}?url=${encodeURIComponent(url)}${cfWorkerSecret ? `&secret=${cfWorkerSecret}` : ""}`,
        { headers: HEADERS, timeout: FETCH_TIMEOUT_MS }
      );
      if (proxyRes.ok) {
        const html = await proxyRes.text();
        if (html) {
          console.error(`Atom via CF Worker: OK`);
          return html;
        }
      }
    } catch (err) {
      console.error(`Atom CF Worker failed: ${err.message}`);
    }
  }

  throw new Error(`Atom Tickets HTTP 403 for ${url} (all fallbacks exhausted)`);
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
      // Log a snippet so we can diagnose parser mismatches when HTML structure
      // differs from what the proxy returns vs. raw browser HTML.
      const panelCount = (html.match(/showtime-panel/g) || []).length;
      // Count hits inside actual class= attributes vs CSS/JS (class= hits are the real DOM panels)
      const classAttrCount = (html.match(/class="[^"]*showtime-panel/g) || []).length;
      console.error(`Atom HTML: ${html.length} chars, ${panelCount} showtime-panel hits (${classAttrCount} in class= attrs). Snippet: ${html.slice(0, 200).replace(/\s+/g, " ")}`);
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
  // Split on the class name itself rather than the exact attribute string so
  // extra classes (e.g. "showtime-panel active") don't break the split.
  const panelParts = html.split("showtime-panel");
  for (let i = 1; i < panelParts.length; i++) {
    const panel = panelParts[i];
    const titleMatch = panel.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!titleMatch) continue;
    const movieTitle = titleMatch[1].replace(/<[^>]+>/g, "").trim();
    if (!movieTitle) continue;

    // Split on the format-info class similarly
    const formatParts = panel.split("format-showtimes__format-info");
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
