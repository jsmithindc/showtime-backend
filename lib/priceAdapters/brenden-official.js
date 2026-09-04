// Brenden Theatres -- showtimes from the site's own server-rendered page,
// pricing from the Indy platform's /graphql endpoint.
//
// robots.txt is short and specific:
//   Disallow: /ahoy  /graphql  /checkout  (and /*/checkout)
//
// So /{site}/showtimes is PERMITTED, and showtimes stay on it -- the page is
// server-rendered (~19KB) and already carries every film, showtime and showing
// id, so there is nothing to gain by asking the API for them.
//
// PRICING RUNS ON THE OPERATOR'S OWN PERMISSION, which is what puts /graphql
// on the table despite robots.txt -- the same footing Landmark pricing already
// runs on, whose booking host is a blanket "Disallow: /". Absent that
// permission this file would be showtimes-only. See the Pricing section below
// for how the price is actually assembled.
//
// /checkout is still never fetched: those URLs are offered as buy links only,
// and the price comes from the API instead.
//
// 70mm IS NOT A SESSION ATTRIBUTE HERE. Brenden runs the 70mm presentation as
// its own film entry, "The Odyssey - The IMAX 70mm Experience", alongside a
// plain "The Odyssey" on another screen -- both appeared on one real page, at
// 12:00/16:00/20:00 and 14:00 respectively. So the print is read off the film
// title and slug, and the two must not be conflated. (The API does state it
// outright, as displayMetaData.classes "imax-70mm"; getShowingContext picks
// that up, so a title-derived flag can be confirmed against it.)

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


// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
//
// Brenden runs on Indy (indy.systems -- the bundle identifies itself as
// "indy-frontend"), and pricing comes from the same /graphql endpoint the site
// itself uses. robots.txt disallows /graphql, so this runs on the operator's
// own permission, exactly the footing Landmark pricing already runs on (whose
// booking host is a blanket Disallow: / ). Showtimes still come from the
// permitted /{site}/showtimes page; only pricing needs this.
//
// The consumer schema has NO field that returns a ticket price directly --
// Showing exposes only priceCard { id name }, and PriceCard itself exposes
// nothing but id and name. Confirmed by probing: introspection is disabled,
// but errors name types ("Field 'prices' doesn't exist on type 'PriceCard'"),
// which is enough to walk the schema. The price is ASSEMBLED CLIENT-SIDE from
// three lists, which is why watching the network tab shows no call carrying it:
//
//   1. showingsForDate(date:)  -> each showing's priceCardId, showingBadgeIds
//                                 and seatsRemainingByTicketTypeId (the latter
//                                 is what says which ticket types this showing
//                                 actually sells)
//   2. priceCards              -> priceCardItems[] = { ticketTypeId,
//                                 hasCustomPrice, customPrice }
//   3. clientConfig            -> ticketTypes (names, base prices, visibility)
//                                 and bookingFeeTypes
//
// price = priceCardItem.hasCustomPrice ? customPrice : ticketType.price.
//
// Two live confirmations, both matching the site's own checkout page exactly:
//   Odyssey 70mm  (card "IMAX 70mm")   Adult/Senior/Child $50.00 + $1.75
//   Spider-Man    (card "JBX Evening") $15.75 / $14.75 / $14.75 + $1.75
//
// Requests need three headers -- site-id, circuit-id, client-type -- and NO
// cookies (verified with credentials:"omit"); without site-id the API answers
// "Site not found. (Code: 104)".

const CIRCUIT_ID = "90";

// Brenden's two web-facing sites. The circuit lists nine (Kingman, Concord,
// Modesto, Vacaville, Rifle...), but only these two have /{slug}/showtimes
// pages on this domain, so only these two can be asked about here.
const SITE_IDS = { lasvegas: "142", laughlin: "167" };

async function gql(query, variables, siteId) {
  const res = await fetch(`${BASE}/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "site-id": String(siteId),
      "circuit-id": CIRCUIT_ID,
      "client-type": "consumer",
    },
    body: JSON.stringify({ query, variables: variables || {} }),
    timeout: REQUEST_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`Brenden graphql HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  // Errors arrive as HTTP 200 with an `error` object, so a status check is not
  // enough. message_to_log carries the useful text; message is a bare ref id.
  if (json.error) {
    throw new Error(`Brenden graphql: ${json.error.message_to_log || json.error.message}`);
  }
  return json.data;
}

function siteIdFor(site) {
  const id = SITE_IDS[site];
  if (!id) throw new Error(`Brenden: no site id known for "${site}" (have ${Object.keys(SITE_IDS).join(", ")})`);
  return id;
}

function parseJson(str, fallback) {
  try { return JSON.parse(str || ""); } catch { return fallback; }
}

/**
 * Price cards, ticket types and booking fees for a site. One request per site
 * per day -- none of it changes intraday, and it covers every showing at once.
 */
async function getPricingConfig(site) {
  const siteId = siteIdFor(site);
  const key = `brenden-pricecfg-${site}`;
  const now = new Date();
  const ttl = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;

  const cached = await readCache(key, ttl);
  if (cached) return cached;

  const data = await gql(`{
    priceCards(limit: 200) { data { id name priceCardItems { ticketTypeId hasCustomPrice customPrice } } }
    clientConfig {
      ticketTypes { id name price channels ticketTypeOptions membershipTypeId archivedAt }
      bookingFeeTypes { id name type enabled amount amountStrategy percentThousandths
                        channels conditions conditionsRequirements ticketTypeIds showingBadgeIds archivedAt }
    }
  }`, {}, siteId);

  const priceCards = {};
  for (const card of (data.priceCards && data.priceCards.data) || []) {
    const items = {};
    for (const it of card.priceCardItems || []) {
      items[String(it.ticketTypeId)] = it.hasCustomPrice ? Number(it.customPrice) : null;
    }
    priceCards[String(card.id)] = { name: card.name, items };
  }

  const ticketTypes = {};
  for (const t of (data.clientConfig && data.clientConfig.ticketTypes) || []) {
    const opts = parseJson(t.ticketTypeOptions, {});
    const channels = parseJson(t.channels, {});
    ticketTypes[String(t.id)] = {
      name: t.name,
      // The checkout shows "Adult", not the internal "Adult Web only".
      displayName: opts.has_custom_display_name && opts.custom_display_name ? opts.custom_display_name : t.name,
      price: Number(t.price),
      // On a TICKET TYPE, channels is a HIDDEN-FROM map: true means "do not
      // offer here". Confirmed across all eight types valid for one showing --
      // the three the site actually sold online are the three with
      // website:false, and "Adult In House"/"Staff" (website:true) are hidden.
      // Note this is the OPPOSITE sense to channels on a booking fee.
      hiddenOnWeb: channels.website === true,
      requiresAuth: opts.requires_authorization === true,
      membershipTypeId: t.membershipTypeId || null,
      archived: !!t.archivedAt,
    };
  }

  const config = {
    priceCards,
    ticketTypes,
    bookingFees: (data.clientConfig && data.clientConfig.bookingFeeTypes) || [],
  };
  writeCache(key, config, ttl);
  return config;
}

/**
 * Every showing at a site on a date, with the context pricing needs. One
 * request per site per day.
 */
async function getShowingContext(site, dateISO) {
  const siteId = siteIdFor(site);
  const key = `brenden-showctx-${site}-${dateISO}`;
  const now = new Date();
  const ttl = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;

  const cached = await readCache(key, ttl);
  if (cached) return cached;

  const data = await gql(`query ($date: String!) {
    showingsForDate(date: $date) {
      data { id time priceCardId showingBadgeIds seatsRemainingByTicketTypeId displayMetaData
             movie { name urlSlug } }
    }
  }`, { date: dateISO }, siteId);

  const out = {};
  for (const s of (data.showingsForDate && data.showingsForDate.data) || []) {
    const classes = String(parseJson(s.displayMetaData, {}).classes || "");
    out[String(s.id)] = {
      time: s.time,
      priceCardId: s.priceCardId ? String(s.priceCardId) : null,
      showingBadgeIds: (s.showingBadgeIds || []).map(String),
      // seatsRemainingByTicketTypeId is keyed by every ticket type this
      // showing sells -- the only signal for which types are even applicable.
      ticketTypeIds: Object.keys(parseJson(s.seatsRemainingByTicketTypeId, {})),
      // A STATED 70mm flag, unlike the film-title inference the showtimes page
      // forces. Kept because it can confirm the title-derived one.
      imax70mm: /(^|\s)imax-70mm(\s|$)/.test(classes),
      movieName: s.movie && s.movie.name,
      slug: s.movie && s.movie.urlSlug,
    };
  }
  writeCache(key, out, ttl);
  return out;
}

/**
 * Booking fees that apply to one ticket, in dollars.
 *
 * On a FEE, `channels` is an applies-to map (website:true means charge it) --
 * the opposite sense to `channels` on a ticket type. `conditions` says which
 * gates are switched on, and `conditionsRequirements` says whether each id
 * list is an allow-list or a deny-list. Confirmed on one real showing: the
 * $1.75 "Booking Fee" applied (deny-list, our badge not in it) while the
 * $2.75 "Premium" fee did not (allow-list, our badge not in it).
 */
function feesForTicket(config, { ticketTypeId, showingBadgeIds, price }) {
  let total = 0;
  const applied = [];
  for (const fee of config.bookingFees || []) {
    if (!fee.enabled || fee.archivedAt) continue;
    if (fee.type !== "ticket") continue;
    const channels = parseJson(fee.channels, {});
    if (channels.website !== true) continue;

    const cond = parseJson(fee.conditions, {});
    const req = parseJson(fee.conditionsRequirements, {});

    if (cond["showing-badges"] && (fee.showingBadgeIds || []).length) {
      const hit = (fee.showingBadgeIds || []).some((b) => showingBadgeIds.includes(String(b)));
      if (req.excludeShowingBadges ? hit : !hit) continue;
    }
    if (cond["ticket-types"] && (fee.ticketTypeIds || []).length) {
      const hit = (fee.ticketTypeIds || []).map(String).includes(String(ticketTypeId));
      if (req.excludeTicketTypes ? hit : !hit) continue;
    }
    // A price gate is only meaningful once a bound is actually set; both
    // bounds are 0 on every fee seen so far, which means "no bound".
    if (cond.price) {
      if (Number(req.minPrice) > 0 && price < Number(req.minPrice)) continue;
      if (Number(req.maxPrice) > 0 && price > Number(req.maxPrice)) continue;
    }

    const amount = fee.amountStrategy === "percent"
      ? price * (Number(fee.percentThousandths) / 100000)
      : Number(fee.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    total += amount;
    applied.push({ name: fee.name, amount: Math.round(amount * 100) / 100 });
  }
  return { total: Math.round(total * 100) / 100, applied };
}

/** The web-sellable ticket types for a showing, priced. */
function ticketRowsFor(config, ctx) {
  const card = ctx.priceCardId ? config.priceCards[ctx.priceCardId] : null;
  const rows = [];
  for (const ttId of ctx.ticketTypeIds || []) {
    const t = config.ticketTypes[ttId];
    if (!t || t.archived || t.hiddenOnWeb || t.requiresAuth || t.membershipTypeId) continue;
    const custom = card ? card.items[ttId] : undefined;
    const price = custom === null || custom === undefined ? t.price : custom;
    if (!Number.isFinite(price)) continue;
    const fee = feesForTicket(config, {
      ticketTypeId: ttId,
      showingBadgeIds: ctx.showingBadgeIds || [],
      price,
    });
    rows.push({
      ticketTypeId: ttId,
      name: t.displayName,
      price: Math.round(price * 100) / 100,
      fee: fee.total,
      total: Math.round((price + fee.total) * 100) / 100,
      fees: fee.applied,
    });
  }
  return { rows, priceCardName: card ? card.name : null };
}

// "Adult" is the display name Brenden uses, so prefer it outright; the
// fallbacks exist so a site that names it differently still prices rather than
// silently returning nothing.
function pickAdult(rows) {
  return rows.find((r) => /^adult$/i.test(r.name))
    || rows.find((r) => /\badult\b/i.test(r.name))
    || rows.filter((r) => !/child|senior|student|military|staff/i.test(r.name))
           .sort((a, b) => a.price - b.price)[0]
    || rows[0]
    || null;
}

/**
 * Real ticket pricing for one showing. Returns null when the showing isn't in
 * the day's listing (already gone, or a different date) rather than throwing,
 * since one unpriceable showing must not blank out the ones that worked.
 */
async function getTicketPricing({ site, showingId, dateISO }) {
  const [config, showings] = await Promise.all([
    getPricingConfig(site),
    getShowingContext(site, dateISO),
  ]);
  const ctx = showings[String(showingId)];
  if (!ctx) return null;

  const { rows, priceCardName } = ticketRowsFor(config, ctx);
  if (!rows.length) return null;
  const adult = pickAdult(rows);
  if (!adult) return null;

  return {
    price: adult.total,
    priceBeforeFee: adult.price,
    fee: adult.fee,
    ticketTypeName: adult.name,
    priceCardName,
    tickets: rows,
    imax70mm: ctx.imax70mm,
  };
}

module.exports = {
  parseShowtimes, getShowtimesForSite, to24h, BASE,
  getTicketPricing, getPricingConfig, getShowingContext, ticketRowsFor, feesForTicket, pickAdult,
  SITE_IDS,
};
