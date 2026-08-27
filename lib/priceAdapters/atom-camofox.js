// Fetches Regal showtimes and pricing from Atom Tickets using Camofox browser
// automation. Atom's theater page loads showtimes via XHR after initial render,
// so a real browser with network-idle wait is required -- plain HTML fetches
// and basic JS-render proxies can't capture the showtime buttons.
//
// Required env vars:
//   CAMOFOX_URL         -- e.g. https://camofox.yourdomain.com
//   CAMOFOX_USER_ID     -- arbitrary shared secret, namespaces browser sessions
//   CAMOFOX_SESSION_KEY -- second auth param required by Camofox API
//
// Flow per theater:
//   1. openTab(theaterUrl, networkidle) -- 1 tab, ~1.8s -- gets all showtimes
//   2. parseSnapshotShowtimes(snapshot, movieTitle) -- returns [{time12h, format, ref}]
//   3. closeTab(discoveryTabId)
//   4. For each in-window showtime (in parallel):
//      a. openTab(theaterUrl, networkidle) -- fresh tab, ~1.8s
//      b. findRefForShowtime(snapshot, movieTitle, time12h) -- get the right ref
//      c. clickRef(tabId, ref) -- navigates to checkout, ~4.7s, returns checkoutUrl
//      d. getSnapshot(tabId) -- read pricing grid
//      e. parseCheckoutPricing(snapshot) -- { adultCents, baseCents, feeCents }
//      f. closeTab(tabId)
//
// Total per theater: ~1.8s discovery + ~6.5s pricing (parallel across showtimes).
// Compare: Regal proxy chain ~52s for first result. Atom includes service fees.

const fetch = require("node-fetch");
const pLimit = require("p-limit");
const { matchesMovie } = require("./serpapi");

// Max concurrent Camofox tabs across all operations. Camofox runs a single
// Firefox instance -- too many simultaneous tabs causes snapshot timeouts.
// 2 means at most one discovery + one pricing tab at a time.
const camofoxLimit = pLimit(2);

// Same static map as atom-tickets.js -- add entries here for new theaters.
// Regal cinema code → { slug, venueId } from atomtickets.com/theaters/...
const REGAL_CODE_TO_ATOM = {
  "1413": { slug: "regal-delta-shores",       venueId: "47446" }, // Regal Delta Shores & IMAX, Sacramento CA
  "0774": { slug: "regal-natomas-marketplace", venueId: "6517"  }, // Regal Natomas Marketplace, Sacramento CA
  "1286": { slug: "regal-ua-laguna-village",   venueId: "3537"  }, // Regal UA Laguna Village 12, Sacramento CA
  "1814": { slug: "regal-davis-holiday",       venueId: "2296"  }, // Regal Davis Holiday 6, Davis CA
};

function isConfigured() {
  return (
    !!process.env.CAMOFOX_URL &&
    !!process.env.CAMOFOX_USER_ID &&
    !!process.env.CAMOFOX_SESSION_KEY
  );
}

function camofoxHeaders() {
  return { "Content-Type": "application/json" };
}

function baseParams() {
  return {
    userId: process.env.CAMOFOX_USER_ID,
    sessionKey: process.env.CAMOFOX_SESSION_KEY,
  };
}

async function openTab(url) {
  const res = await fetch(`${process.env.CAMOFOX_URL}/tabs`, {
    method: "POST",
    headers: camofoxHeaders(),
    body: JSON.stringify({ ...baseParams(), url, waitUntil: "networkidle" }),
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`Camofox openTab HTTP ${res.status}`);
  const { tabId } = await res.json();
  if (!tabId) throw new Error("Camofox openTab: no tabId returned");
  return tabId;
}

async function getSnapshot(tabId) {
  const params = new URLSearchParams({ userId: process.env.CAMOFOX_USER_ID });
  const res = await fetch(`${process.env.CAMOFOX_URL}/tabs/${tabId}/snapshot?${params}`, {
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`Camofox snapshot HTTP ${res.status}`);
  return res.json(); // { url, snapshot, ... }
}

async function clickRef(tabId, ref) {
  const res = await fetch(`${process.env.CAMOFOX_URL}/tabs/${tabId}/click`, {
    method: "POST",
    headers: camofoxHeaders(),
    body: JSON.stringify({ ...baseParams(), ref }),
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`Camofox click HTTP ${res.status}`);
  return res.json(); // { ok, url, ... }
}

async function closeTab(tabId) {
  try {
    await fetch(`${process.env.CAMOFOX_URL}/tabs/${tabId}`, {
      method: "DELETE",
      headers: camofoxHeaders(),
      body: JSON.stringify(baseParams()),
      timeout: 5000,
    });
  } catch {
    // Best-effort cleanup -- don't fail the caller if delete isn't supported
  }
}

// Convert "10:00 AM" / "9:20 PM" → "10:00" / "21:20"
function to24h(time12h) {
  const m = time12h.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const pm = m[3].toUpperCase() === "PM";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

// Extract format string from Camofox button text like:
//   'Film format: STANDARD FORMAT . List of Showtime Features: ...'
//   'Film format: IMAX . List of Showtime Features: ...'
function deriveFormat(buttonText) {
  const m = buttonText.match(/Film format:\s*([^.]+)\s*\./i);
  if (!m) return "Standard";
  const raw = m[1].trim();
  if (/standard/i.test(raw)) return "Standard";
  const map = [
    [/\bimax\b/i, "IMAX"],
    [/\brpx\b/i, "RPX"],
    [/\b4dx\b/i, "4DX"],
    [/\bscreenx\b/i, "ScreenX"],
    [/\bd-?box\b/i, "D-BOX"],
    [/\bdolby\b/i, "Dolby"],
    [/\bprime\b/i, "Prime"],
    [/\bbigd\b/i, "BigD"],
    [/\b3d\b/i, "3D"],
  ];
  for (const [re, label] of map) {
    if (re.test(raw)) return label;
  }
  return raw || "Standard";
}

// Parse the Camofox accessibility-tree snapshot for one movie's showtimes.
// Returns [{time12h, time24h, format, ref}].
//
// Snapshot structure (relevant portion):
//   heading "MOVIE TITLE" [level=2]:
//     ...
//     'button "Film format: STANDARD FORMAT . List of Showtime Features:..." ':
//       heading [level=3]: ...
//     - list:
//       - listitem:
//         - button "10:00 AM" [e22]
function parseSnapshotShowtimes(snapshot, movieTitle) {
  const results = [];

  // Split on level-2 headings to isolate each movie section.
  // Each section starts with: heading "TITLE" [level=2]
  const sections = snapshot.split(/heading "[^"]*" \[level=2\]/);

  for (let i = 0; i < sections.length - 1; i++) {
    // The heading text is at the END of sections[i] (before the split point),
    // so grab it from the original by scanning backwards from the split.
    // Simpler: re-split differently.
    break;
  }

  // Re-split to capture heading title alongside the section body.
  const headingRe = /heading "([^"]+)" \[level=2\]/g;
  const positions = [];
  let m;
  while ((m = headingRe.exec(snapshot)) !== null) {
    positions.push({ title: m[1], start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < positions.length; i++) {
    const { title, end } = positions[i];
    if (!matchesMovie(title, movieTitle)) continue;

    const sectionEnd = i + 1 < positions.length ? positions[i + 1].start : snapshot.length;
    const section = snapshot.slice(end, sectionEnd);

    // Find format buttons and time buttons within this section.
    // Format buttons: 'button "Film format: X . ..."'
    // Time buttons: button "HH:MM AM/PM" [eN]
    let currentFormat = "Standard";
    const formatBtnRe = /button "Film format:\s*([^"]+?)(?:\s*\.)(?:[^"]*)" /g;
    const timeBtnRe = /button "(\d+:\d+\s*[AP]M)" \[([^\]]+)\]/g;

    // Process section line by line to preserve order and associate formats with times.
    // We collect all format-button positions and all time-button positions, then
    // assign each time to whichever format-button last preceded it.
    const formatPositions = [];
    let fm;
    while ((fm = formatBtnRe.exec(section)) !== null) {
      formatPositions.push({ format: deriveFormat(`Film format: ${fm[1]} .`), pos: fm.index });
    }

    const timePositions = [];
    let tm;
    while ((tm = timeBtnRe.exec(section)) !== null) {
      timePositions.push({ time12h: tm[1].trim(), ref: tm[2], pos: tm.index });
    }

    for (const tp of timePositions) {
      // Find the last format that appeared before this time button
      let fmt = "Standard";
      for (const fp of formatPositions) {
        if (fp.pos < tp.pos) fmt = fp.format;
      }
      const time24h = to24h(tp.time12h);
      if (time24h) results.push({ time12h: tp.time12h, time24h, format: fmt, ref: tp.ref });
    }

    break; // found and processed the matching movie section
  }

  return results;
}

// Parse checkout pricing from the Camofox snapshot of the checkout page.
// Snapshot grid rows look like:
//   row "Adult Matinee $14.68 (including $2.19 service fee) ADD"
//   row "Adult $18.18 (including $2.19 service fee) ADD"
// Returns { adultCents, baseCents, feeCents } or null.
function parseCheckoutPricing(snapshot) {
  const rowRe = /row "([^"]+\$[\d.]+[^"]*)"[:\s]/g;
  const types = [];
  let m;
  while ((m = rowRe.exec(snapshot)) !== null) {
    const rowText = m[1];
    // Extract ticket type (first word(s) before the dollar sign)
    const typeMatch = rowText.match(/^([^$]+?)\s+\$(\d+\.\d{2})/);
    if (!typeMatch) continue;
    const typeName = typeMatch[1].trim();
    const totalCents = Math.round(parseFloat(typeMatch[2]) * 100);

    const feeMatch = rowText.match(/including \$(\d+\.\d{2}) service fee/);
    const feeCents = feeMatch ? Math.round(parseFloat(feeMatch[1]) * 100) : 0;

    types.push({ type: typeName, totalCents, feeCents });
  }

  if (types.length === 0) return null;
  const adult = types.find((t) => /adult/i.test(t.type)) || types[0];
  return {
    adultCents: adult.totalCents,
    feeCents: adult.feeCents,
    baseCents: adult.totalCents - adult.feeCents,
    allTypes: types.map((t) => ({
      type: t.type,
      priceCents: t.totalCents,
      feeCents: t.feeCents,
    })),
  };
}

// Discover all showtimes for a movie at a theater using Camofox.
// Returns { found, showtimes: [{time12h, time24h, format, ref}], theaterUrl }.
async function getAtomShowtimesViaCamofox({ theaterName, regalCode, dateISO, movieTitle }) {
  const venue = REGAL_CODE_TO_ATOM[regalCode];
  if (!venue) {
    console.error(
      `Camofox/Atom: no static entry for "${theaterName}" [${regalCode}] -- ` +
      `add to REGAL_CODE_TO_ATOM in atom-camofox.js if this theater is on Atom`
    );
    return { found: false, showtimes: [], theaterUrl: null };
  }

  const theaterUrl = `https://www.atomtickets.com/theaters/${venue.slug}/${venue.venueId}?date=${dateISO}`;
  let tabId;
  try {
    console.error(`Camofox/Atom: opening theater page for ${theaterName} (${venue.venueId})`);
    tabId = await openTab(theaterUrl);
    const { snapshot } = await getSnapshot(tabId);
    const showtimes = parseSnapshotShowtimes(snapshot, movieTitle);
    console.error(
      `Camofox/Atom [${venue.venueId}] ${dateISO}: ` +
      `${showtimes.length} showtime(s) for "${movieTitle}": ` +
      `${showtimes.map((s) => `${s.time24h}/${s.format}`).join(", ")}`
    );
    return { found: true, showtimes, theaterUrl };
  } finally {
    if (tabId) await closeTab(tabId);
  }
}

// Fetch checkout pricing for one specific showtime by opening a fresh theater page
// tab and clicking the showtime button matching time12h + movieTitle.
// Returns { pricing, checkoutId } or { pricing: null, checkoutId: null } on failure.
async function getAtomCheckoutPricingViaCamofox({ theaterUrl, movieTitle, time12h, format }) {
  let tabId;
  try {
    tabId = await openTab(theaterUrl);
    const { snapshot: discoverySnapshot } = await getSnapshot(tabId);

    // Find the ref for this specific time + movie in the fresh tab's snapshot
    const showtimes = parseSnapshotShowtimes(discoverySnapshot, movieTitle);
    const target = showtimes.find(
      (s) => s.time12h === time12h && (format === "Standard" || s.format === format || !format)
    ) || showtimes.find((s) => s.time12h === time12h);

    if (!target) {
      console.error(`Camofox/Atom: showtime ${time12h} not found in fresh snapshot for "${movieTitle}"`);
      return { pricing: null, checkoutId: null };
    }

    const { url: checkoutUrl } = await clickRef(tabId, target.ref);
    const { snapshot: checkoutSnapshot } = await getSnapshot(tabId);
    const pricing = parseCheckoutPricing(checkoutSnapshot);

    // Extract checkoutId from URL: https://www.atomtickets.com/checkout/639818246#/tickets
    const checkoutIdMatch = (checkoutUrl || "").match(/\/checkout\/(\d+)/);
    const checkoutId = checkoutIdMatch ? checkoutIdMatch[1] : null;

    console.error(
      `Camofox/Atom: ${time12h} → checkout ${checkoutId}, ` +
      `adult $${pricing ? (pricing.adultCents / 100).toFixed(2) : "n/a"}`
    );
    return { pricing, checkoutId };
  } finally {
    if (tabId) await closeTab(tabId);
  }
}

module.exports = {
  isConfigured,
  // Wrapped with camofoxLimit so concurrent calls from multiple theaters
  // don't open more tabs than Camofox's single Firefox instance can handle.
  getAtomShowtimesViaCamofox: (args) => camofoxLimit(() => getAtomShowtimesViaCamofox(args)),
  getAtomCheckoutPricingViaCamofox: (args) => camofoxLimit(() => getAtomCheckoutPricingViaCamofox(args)),
  REGAL_CODE_TO_ATOM,
};
