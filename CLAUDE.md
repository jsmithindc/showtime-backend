# Showtime Finder — backend

## What this is

A Node/Express backend (`server.js`, single file, ~2500 lines) that searches
for movie showtimes near a lat/lng within a time budget, and where possible
attaches *real* ticket prices per showing rather than just a generic
Google/SerpApi listing.

Flow, roughly:

1. **Theater discovery** — OpenStreetMap Overpass API finds cinemas within
   a radius (converted from `radiusMin` minutes with a 25% pad).
2. **Showtimes + pricing**:
   - Chains with a live direct adapter (AMC, Cinemark, Cinema West, Harkins,
     Regency, Regal) go through `lib/priceAdapters/*-official.js` (or
     `regal-scrapedo.js` for Regal) for real per-ticket-type pricing.
   - Everything else falls back to SerpApi's Google-showtimes scrape
     (`lib/priceAdapters/serpapi.js`) — price not always present there.
3. **Local filtering** — drop showings that already started, end past
   `deadline`, or don't match the requested `formats`; sort cheapest first.

`public/index.html` is the (single-file) frontend.

**The root [README.md](README.md) is stale as of its own last section** —
everything above "Deploying (Railway)" describes an earlier SerpApi-only
version and predates AMC/Regal/Harkins/Cinemark/Cinema West/Regency all
being live adapters. Don't trust it as current documentation; this file is.

## The proxy fallback chain (Regal pricing only)

Regal's real backend (regmovies.com) is Cloudflare-protected and US-geo-
restricted, so `lib/priceAdapters/regal-scrapedo.js` reaches it through
`lib/proxyProviders/` instead of fetching directly. `lib/proxyProviders/index.js`
tries configured providers in this order, falling through to the next on
quota-exhaustion or failure:

1. **Bright Data** — first because it's the architecturally strongest fit:
   its documented schema has explicit `method`/`data` fields for relaying an
   arbitrary request (including Regal's POST-based `createOrder` step),
   confirmed from Bright Data's own docs, a GitHub reference impl, and an
   independent OpenAPI spec. Should also be faster than apify-cfbypass since
   it doesn't spin up a real browser per call. Caveat: real credentials are
   confirmed to work against Bright Data's *own* test endpoint, but
   `createOrder` against Regal specifically, and whether the outer response's
   status code faithfully reflects the target's real status, are **not**
   yet confirmed — see the long comment in `brightdata.js`.
2. **apify-cfbypass** — second because it's the one provider *confirmed*,
   from a real captured response, to get through Regal's `createOrder` step
   end-to-end (via a browser-session workaround, since it has no native
   POST-body relay). Catches the request if Bright Data can't do it or gets
   the status-passthrough subtly wrong.
3. **Firecrawl** — still real and usable for GET-only steps, but **cannot
   handle `createOrder` at all** (no method/body relay), so it can never be
   the *only* working provider for Regal even when it works for everything
   else. See the long comment in `firecrawl.js`.
4. **ZenRows** — last-but-kept: genuinely exhausted for the month as of the
   last check, not removed outright in case a trickle of credits appears
   (e.g. a free-tier monthly reset).
5. **Scrape.do** — same situation as ZenRows; also the original/first
   provider this project was built against (hence `regal-scrapedo.js`'s
   filename, even though it now routes through whichever provider is next
   in line).

Apify's plain Super Scraper actor (`apify.js`, distinct from
`apify-cfbypass.js`) is **removed from the list entirely**, not just
deprioritized — confirmed blocked by Regal's bot detection (real 403s in
the actor's own log). Don't re-add it without new evidence it's unblocked.

`camofox-regal` keeps a **pool** of regmovies.com tabs (`CAMOFOX_TAB_POOL`,
default 8 -- each is a real Firefox tab on the Camofox host, so lower it if
that box is memory-tight). A browser tab runs one `evaluate` at a time, so a single tab
serialized every call regardless of caller concurrency: a 5-theater Denver
search spent ~41s of its 52s on 21 `getTicketsForSession` GETs at ~1.95s each,
while the same search with Regal off finished in 1.5s. Only GETs are pooled --
`createOrder` stays on the serialized POST queue, since Cloudflare's limit is
on POST volume. Set `CAMOFOX_TAB_POOL=1` to restore the old single-tab
behaviour.

A provider may export **`supports(url)`** to decline requests it structurally
cannot serve; `fetchWithRotation` skips those without calling them.
`camofox-regal` and `apify-cfbypass` both declare regmovies.com only, because
each runs its request as a `fetch()` inside a regmovies.com *page* -- any other
host is cross-origin and the browser refuses it, surfacing as `evaluate HTTP
500`. Landmark pricing hit that on every call and spent most of its budget
before a provider that could do the job was tried. If you add a provider that
is pinned to one site, give it a `supports()`.

Before touching this chain: re-read the ordering comment at the top of
`lib/proxyProviders/index.js` — it's kept current and is the source of
truth over this summary if the two ever disagree.

## Theater chain adapters

| Chain | File | State |
|---|---|---|
| **AMC** | `priceAdapters/amc-official.js` | Most solid. Official open developer API (`developers.amctheatres.com`), no special approval needed. Showtimes response includes real adult/child/senior pricing directly — no session/cart dance. One request per theater per day. |
| **Cinemark** | `priceAdapters/cinemark-official.js` | Pricing confirmed against a real decoded sample (Century DOCO/XD, Sacramento) with Cinemark support's permission for personal/hobbyist use, but the actual live HTTP request has **never been run** — this sandbox can't reach cinemark.com (robots.txt + no egress). Pulls pricing from a base64 JSON blob (`rawBoxProducts`) embedded in the TicketSeatMap page HTML, not a JSON API. Gate: `DISABLE_CINEMARK_PRICING` env var, default paused-when-unset (checked via `!== "false"`, so it must be the literal string `"false"` to enable). Watch for HTML-entity-encoded `&amp;` in showtime links — must decode before parsing query params or theaterId/showtimeId parsing breaks. |
| **Regal** | `priceAdapters/regal-scrapedo.js` | Real backend flow (create order → `getTicketsForSession`) reached through the proxy chain above. Response sometimes arrives as rendered HTML with the real JSON sitting in a `<pre>` tag (Scrape.do-specific quirk, unconfirmed whether other providers wrap it the same way) — falls back to direct `JSON.parse` if no `<pre>` found. Only theaters listed in `lib/regal-cinema-map.js`/`lib/regal-theaters-ca.js` get resolved; matching an unmapped OSM theater to a Regal ID now **requires "regal" in the OSM name** before even attempting a distance match (see Gotchas below). Gate: `DISABLE_REGAL_PRICING`. |
| **Harkins** | `priceAdapters/harkins-official.js` | Discovery (movie catalog + nationwide showtimes-by-date via a Next.js data route) is fully confirmed live. **Real ticket pricing is still unconfirmed** — only one fully-captured pricing response exists (`RequestOrderTotals`), but not the shape of the step before it (`StartTicketingSession`) that actually creates the order. Needs one more real captured response before pricing can be trusted rather than guessed. Runs on the same Vista-family platform as Cinema West (shared `HO########` movie ID convention) but a different product stack (harkins.com + `ticketingservice.harkins.com` + `cmsservice.harkins.com`). The Next.js `{buildId}` in its data-route URL is **not stable** — changes on every site deploy, must be extracted live from the page's own `__NEXT_DATA__`, never hardcoded. |
| **Regency** | `priceAdapters/regency-official.js` | Runs on "Mobile Moviegoing," a plain PHP platform — genuinely different stack from the Vista-family chains (Regal/Cinema West/Harkins). Pricing (`getSeatData.php` → `ticketClassArray`) is confirmed live, but requires already knowing a `perf` (performance) ID — **there is still no confirmed discovery endpoint** for finding performance IDs from a movie/theater/date; the showtimes listing is presumed server-rendered into theater/movie page HTML rather than a separate API, but a direct page fetch got a 405 from this project's sandbox. Ticket-type naming is unusual: types are named after the day ("Tuesday") rather than "Adult"; filter by excluding `bonus: true` (loyalty tier) rather than by age-keyword. Requires per-theater cookies (`visitID`, `hasSeenPopup`, `siteID` matching the specific theater's `seatsSiteId`) — a bare/static cookie silently gets "Error loading showtimes." with no other error signal. |

(Cinema West also has a live adapter, `cinemawest-official.js`, not
requested above but present in `server.js` under `chain: "cinemawest"`.)

## Caching tiers

`lib/disk-cache.js` is the shared store. `readCache(name, ttlMs)` (async) goes
local file -> Upstash Redis, promoting a Redis hit into the local file with its
**original** `fetchedAt` so a stale entry can't live forever by hopping
containers. `writeCache(name, data, ttlMs)` writes the local file synchronously
and pushes to Redis fire-and-forget -- never await it on a search path. Set
`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` to enable; unset,
everything behaves exactly as before. Entries over 400KB stay local.

Going through it: geocodes (90d), AMC/Harkins/Regal theater lists (24h), drive
times (30d), IMDb ratings map, and **Regal + Atom showtime listings** (TTL runs
to midnight, so a morning search's showtimes are reused all day and now survive
a redeploy). The sync `readDiskCache`/`writeDiskCache` still exist and are
local-only -- prefer `readCache`/`writeCache` for anything new.

**Still local-only:** `.overpass-cache.json` and `.serpapi-schedule-cache.json`
keep their own bespoke files and do not go through this. Overpass is the more
valuable of the two to migrate (it is rate-limited and returns `[]` when
throttled).

## Learned fallback pricing

`lib/price-model.js` records every REAL price the app pulls and uses it to
estimate when a lookup fails. Observations are bucketed by
`chain | theater | format | daypart | daytype` and written to every
granularity at once, so a lookup is a most-specific-first walk:
theater+format+time+day -> ... -> theater -> chain+format -> chain. Needs
`MIN_OBSERVATIONS` (2) in a bucket before it will answer, and reports which
level answered plus the observation count.

**Estimates never enter `price`.** They live in `estimatedPrice` (+`Low`,
`High`, `estimateBasis`, `estimateObservations`). `price` means "read from the
chain"; the Cheapest badge reads `price` directly and so can never land on a
guess. The frontend sorts estimates inline (via `effectivePriceForSorting`) but
renders them italic/amber with a tooltip naming the basis.

Estimates never cross chains -- chain is the first key component -- because
adapters differ on base-vs-total and which ticket type is cheapest, so a mixed
bucket would be actively misleading.

**A chain that has NEVER priced gets no estimate.** That is the design working,
but it means Landmark (0 real prices in every log to date) is not helped by
this until its pricing succeeds at least twice. Confirmed live: 266 buckets
learned from one Denver search across AMC/Cinemark/Alamo/Harkins, and Landmark
still estimated nothing.

Absurd values are rejected on the way in (<=0, >200) so one bad parse cannot
become the "learned" price for a theater.

## Known gotchas before touching related code

- **`start.sh` must never be git-tracked.** It has real, hardcoded API keys
  (SerpApi, Scrape.do, ZenRows, Apify, Firecrawl, Bright Data, AMC vendor
  key). `start.sh.example` is the safe, placeholder-only template — copy it
  to `start.sh` for local dev, never edit `start.sh.example` with real
  values. **There is currently no `.gitignore` file in this repo** despite
  the commit history (`d5ecec2`) claiming start.sh "is now gitignored" —
  it's untracked today only because it's never been `git add`ed, not
  because anything prevents it. A bare `git add -A` or `git add .` would
  stage it and leak every credential above. Treat this as standing
  first-priority cleanup: add a `.gitignore` with `start.sh` (and
  `node_modules/`) in it before relying on habit alone.
- **Distance-only theater matching is fragile in dense areas.** Both the
  Regal and AMC auto-match logic (matching an unmapped OSM theater to a
  known chain-ID list purely by lat/lng proximity) previously mismatched
  real theaters — e.g. "Laemmle Glendale" (a separate art-house chain) and
  a defunct "Five Star Cinema" both got wrongly paired with an unrelated AMC
  theater in a dense shopping district, purely from being within the 0.3mi
  threshold. Fixed by requiring the chain's own name (`/\bamc\b/i`,
  `/\bregal\b/i`) appear in the OSM theater's name before attempting a
  distance match at all — do not remove that guard or loosen the distance
  threshold without re-checking against that failure mode. Regal's 2-mile
  radius ("city-level estimate") is a wider net than AMC's 0.3mi, so it's
  if anything *more* exposed to false positives, not less.
- **Google/SerpApi and Cinemark format strings need normalizing before use
  as filter-chip keys**, or you get visually-duplicate chips for the same
  real format (e.g. "Standard" vs "Standard Format", or "D-BOX" vs "D-Box"
  from different theaters in the same response). See
  `cinemarkDisplayFormat()`/`harkinsDisplayFormat()` in `server.js` — fix
  normalization at the source (where the value is produced/parsed), not
  just in frontend chip-generation, since result cards still need to match
  whichever chip is active regardless of a given theater's raw casing.
- **`DISABLE_CINEMARK_PRICING` / `DISABLE_REGAL_PRICING` are inverted-default
  checks** (`!== "false"`): pricing is paused unless the env var is the
  literal string `"false"`. Unset, `"true"`, or any typo all mean "paused."
- **"Minutes away" is a real routed drive time when `GEOAPIFY_API_KEY` is
  set, and a straight-line guess otherwise.** `lib/drive-times.js` measures
  every discovered theater in one Geoapify route-matrix call
  (`applyRealDriveTimes()` in `server.js`), cached per origin for 30 days.
  Chain discovery deliberately pre-filters WIDE (`prefilterMinutesAway`, a
  45mph straight-line guess) because that pass only decides what's worth
  asking about -- the real filter happens after measurement. Two consequences:
  a "45min" figure in a discovery log is a candidate estimate, not a result;
  and if routing is unavailable the fallback keeps the historical 1.15
  tolerance on estimates, so behaviour matches the pre-routing code rather
  than becoming stricter. Do not tighten the pre-filter to "save calls" --
  duplicate coordinates already collapse and results are cached, and a
  too-tight pre-filter loses theaters invisibly, which is the exact bug this
  replaced (four Denver AMCs, 20-30min drives, scored 35-51min and dropped).
  Theaters up to **5 minutes past** the radius are kept and tagged "just
  outside" in the UI (`.dist-over`), rather than dropped: the boundary is not
  sharp enough to justify a hard cut. Measured from three points within 1.5
  miles of each other in downtown Denver, AMC Southlands and AMC Castle Rock
  came out 31/30/31 min against a 30-min limit -- in or out purely on which
  downtown coordinate the geocoder returned. Routing is also free-flow (no
  traffic) and stops at the theater's coordinates (no parking or walk-in), so
  the number is soft in both directions. The frontend derives the tag by
  comparing `distanceMin` against the radius it searched with
  (`searchedRadiusMin`); there is no server-side flag to keep in sync.
- **Runtime is not looked up live in the legacy SerpApi path** — see the
  `RUNTIME_MIN` constant / `lib/movie-runtime.js` overrides. Confirm which
  code path (official adapter vs. SerpApi fallback) a given theater is
  actually using before assuming runtime is accurate.
- **Several adapters (Cinemark, Regency's discovery step) have never had a
  live HTTP request executed from this working environment** — network
  egress here doesn't reach cinemark.com or regencymovies.com. Treat their
  request-building logic as verified-against-captured-samples, not
  verified-end-to-end, and expect first-real-run adjustment.
- **`APP_PASSWORD` is a real, functioning access gate** (`server.js`
  line ~46-70s), not decorative — set it before exposing this past
  localhost (e.g. via a tunnel or Railway) or anyone with the URL can burn
  your API quota.
