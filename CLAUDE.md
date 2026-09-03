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
default 4). Each is a real Firefox tab and opening one loads regmovies.com to
clear Cloudflare, which the Camofox host appears to serialize -- so raising
this is NOT free. Measured on one real Denver search: 32.5s at 4 tabs, 53.7s
at 8. Tabs live 20min and are reused, so the open cost only bites a cold pool
(which a Render redeploy recreates). A browser tab runs one `evaluate` at a time, so a single tab
serialized every call regardless of caller concurrency: a 5-theater Denver
search spent ~41s of its 52s on 21 `getTicketsForSession` GETs at ~1.95s each,
while the same search with Regal off finished in 1.5s. Only GETs are pooled --
`createOrder` stays on the serialized POST queue, since Cloudflare's limit is
on POST volume. Set `CAMOFOX_TAB_POOL=1` to restore the old single-tab
behaviour.

**The Camofox host runs with `BROWSER_IDLE_TIMEOUT_MS=3600000` (one hour).**
Its default is 300000 -- five idle minutes -- after which the browser is killed
and cold-started on the next request. That cold start takes ~52s while the
server's own `HANDLER_TIMEOUT_MS` is 30s, so the first Regal action after any
quiet spell was guaranteed to fail. Set as a systemd override (`systemctl edit
camofox.service` -> `Environment=BROWSER_IDLE_TIMEOUT_MS=3600000`).

**`0` does NOT mean "never" -- it means "kill it immediately", and it is much
worse than the default.** Tried on 2026-09-02 and reverted the same evening.
The host's own log is unambiguous: `browser pre-warmed  ms:25733` at
04:13:18.818, then `browser idle shutdown (no sessions)` at 04:13:18.819 --
one millisecond later. Worse, the sweeper fires *during* a tab create, because
the session count is still 0 while `newContext` is in flight: `camoufox
launched` -> `restoring persisted storage state` -> `browser idle shutdown` ->
`killing browser survivor processes` -> `tab create failed: browser.newContext:
Target page, context or browser has been closed`. That is the whole 500-then-
503 pattern -- 500 is `tab create timed out after 30000ms` waiting on a cold
launch that keeps getting shot, 503 is the launch cancelled outright. Every
request paid a full cold start because nothing was ever allowed to stay warm.
An hour is the right lever; a bigger number is fine, zero is not.

Note the box is memory-tight (1.9G resident peak, 1.9G swap peak), so an hour
of resident Firefox is a real commitment -- do not also raise
`CAMOFOX_TAB_POOL` while judging whether it holds. Unrelated warnings in that
log that are NOT causes: `xvfb not available` and the `glxtest` spawn failure.
The headless fallback launches fine; those lines appear on every successful
launch too.

**Before tuning anything on the Camofox host, check the Proxmox host's I/O
pressure.** Camofox's failure mode under host I/O starvation is indistinguishable
from a Camofox misconfiguration: a Firefox cold start that normally takes ~25s
stretches past the launcher's own 60s timeout, the launch is abandoned but NOT
cancelled (it completes ~119s later), a retry starts 5s after that, and the two
browsers then compete -- so the request-facing symptom is a stream of 500
(`tab create timed out after 30000ms`) and 503 (`Browser launch timeout (60s)`)
that looks exactly like the tab-create problems documented above.

Diagnosed 2026-09-02, from inside the Camofox container:

    cat /proc/pressure/io      # some avg300=99.14, full avg60=53.56
    cat /proc/pressure/cpu     # full avg60=0.00  <- NOT cpu-starved
    ps -eo stat,pid,wchan:24,comm | awk '$1 ~ /^D/'

D-state wait channels name the layer: `jbd2_log_wait_commit` is the ext4 journal
unable to flush, and bash itself sat in `wait_on_buffer`. Note `/proc/loadavg`
in these containers is NOT lxcfs-virtualized -- it reports the Proxmox host's
numbers (the giveaway is a thread count like `14/1790` against 28 tasks in
`top`), so a load average of 76 there says nothing about this container.

The culprit was a DIFFERENT container: `byparr` (CT 115), another browser-based
service, thrashing host I/O. Rebooting it dropped `io some` from 99% to 8% and
Camofox recovered untouched. Neither the pool (`MediaMachine ONLINE, 0 errors`,
no scrub) nor a backup job (no vzdump in `/var/log/pve/tasks/index`) was
involved. byparr had OOMed only once in 7 days, so memory is not how it fails
-- but it IS recurrent, needing a manual restart several times in the days
around 2026-09-02. Treat a sudden Camofox slowdown as a prompt to check byparr
first, not as a new Camofox bug. Stopping camofox and confirming pressure stayed at 99%
with zero camoufox processes is what ruled Camofox out as the cause; do that
first next time rather than tuning timeouts.

byparr's failure mode is a **wedge, not a crash**: its journal shows three
concurrent Prowlarr solves hitting `Challenge detected, waiting for it to
clear...` and never logging `Done` (a healthy solve takes ~18s), after which it
answered nothing for 31 minutes while its stuck Camoufox instances held the
disk. Its unit is `Restart=on-failure`, which never fires for that -- the
process stays "active" and simply stops responding. CT 115 now runs a
`byparr-health.timer` probing `localhost:8191/` every 2 minutes and restarting
after two consecutive misses, so it should self-recover in ~4 minutes.
Consequence: an I/O storm lasting much longer than that is NOT byparr, and
`journalctl -t byparr-health` inside CT 115 counts how often it wedges.

**Do NOT raise `HANDLER_TIMEOUT_MS` above 35000.** It is env-configurable and
tempting, but `server.js` hardcodes `TAB_LOCK_TIMEOUT_MS = 35000` with the
comment "Must be > HANDLER_TIMEOUT_MS so active op times out first". Raising
the handler timeout past that silently inverts the invariant. Verified by
reading the published package, not the docs.

A 5xx from `/tabs` gets **one retry after 25s** before counting as a failure.
The host's own service log explains why: `launching camoufox` -> `tab create
failed` exactly 30s later -> `camoufox launched` at ~52s. Its tab-create
timeout is shorter than its own cold start, so the first request during a
browser restart always fails and the next one usually succeeds. Retrying is
cheaper than falling through here, which is unusual: nothing else can serve
`createOrder` (Bright Data's async path times out at ~60s, Firecrawl cannot
relay a POST body), so the alternative to waiting is not another provider, it
is spending 60s to fail anyway. **If that host's tab-create timeout is
configurable, raising it above ~60s fixes this at the source.**

It also carries a **circuit breaker**: after 3 consecutive tab-open failures it
declines every URL via `supports()` for 60s, so the chain skips it without
opening a socket. Any success resets it. This exists because a Camofox outage
otherwise costs a full `openTab` round trip per request before falling through
-- measured live at 124.7s for one search, with `first Regal` at 86.6s, against
a host that had already returned 500 three times. The pool amplifies this
rather than helping, since more tabs means more independent opens to fail.

**The Camofox host is memory-constrained and its browser does crash.** Measured
during that outage: 1.2G resident, 1.9G peak, 1.9G swap peak, and the service
log shows `browser closed` -> `launching camoufox` -> `browser restart`
mid-search. Tabs are Firefox content processes, so pool size and tab lifetime
are memory decisions, not just latency ones. Hence `TAB_TTL_MS` is 5 minutes
(the pool is there to amortise opens across ONE search, not across the evening)
and a reaper sweeps idle tabs every 60s -- before that, an expired tab was only
closed when the NEXT request happened to pick it up, so a single search left its
whole pool resident indefinitely. If that box gets tight, lower
`CAMOFOX_TAB_POOL` before anything else.

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
| **Landmark** | `priceAdapters/landmark-official.js` | Pricing **confirmed live** (Greenwood Village $12.25+$2.99 fee = $15.24; Mayan $14.74). Vista/Movio "cinema-ui" platform — same family as Regal/Cinema West/Harkins. Showtimes from `www.landmarktheatres.com` (gatsby-source-boxofficeapi); pricing from `POST booking.landmarktheatres.com/api/launch/ticketing/{uuid}`. **It must be a POST** — the booking host is a Vite SPA that answers every GET with the 723-byte app shell, which is why this looked like "response is not valid JSON" for so long. Direct fetch, no proxy (reachable in ~0.5s, no Cloudflare). Response repeats each ticket type once per seating area, so dedupe by name+price. |
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
times (30d), IMDb ratings map, **Regal + Atom showtime listings** (TTL runs to
midnight, so a morning search's showtimes are reused all day and now survive a
redeploy), and the **ratings payload** (12h) -- which is where poster URLs live,
so artwork survives a redeploy too, and OMDb's free 1000/day isn't respent on
titles already resolved. RT scores ride inside that same payload (they are
merged before it is cached), so `lib/rt-scores.js` needs no cache of its own.

Cached ratings are stored **wrapped** (`{ value }`) because `null` is a real
answer meaning "OMDb doesn't have this film" -- an unwrapped null is
indistinguishable from a cache miss and would be re-asked forever. The sync `readDiskCache`/`writeDiskCache` still exist and are
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

## robots.txt positions taken so far

This project respects robots.txt as a matter of course, and the calls have been
made explicitly rather than by accident. Recorded so they aren't re-litigated:

- **Rotten Tomatoes** — only `/m/{slug}`; `/search` is disallowed, so a
  slug that doesn't resolve simply gets no score (see `lib/rt-scores.js`).
- **Landmark** — `booking.landmarktheatres.com/robots.txt` is
  `User-agent: * / Disallow: /`, the whole host, but Landmark's own developer
  support has confirmed personal/hobbyist use is acceptable (same footing as
  Cinemark), so pricing runs. It goes **direct, not through the proxy chain**:
  Bright Data enforces robots.txt regardless of that permission and answers
  HTTP 200 with a `Residential Failed (bad_endpoint)` body, which read as a
  parse error for several rounds. Showtimes come from
  `www.landmarktheatres.com`, whose robots.txt is empty (unrestricted).
- **Atom Tickets** — `/theaters/...` permitted, `/search` and `/checkout`
  disallowed. `lookupAtomVenue` avoids `/search` deliberately.
  `getAtomCheckoutPricing` does hit `/checkout`, but the whole Atom path is
  gated off behind `ENABLE_ATOM_PATH` and is not running; see the note at that
  flag in `server.js` before re-enabling.

Licensed/permitted sources are the way around these, not a different proxy:
SerpApi is paid and licensed, and Cinemark pricing runs with Cinemark support's
explicit permission for personal use.

## Versioning

**CalVer, resolved automatically — do not hand-edit a version anywhere.**
`lib/version.js` resolves it once at boot as the commit date of the deployed
code (`2026.09.02`), served from `GET /api/version`, and the frontend fills
`#versionBadge` from that. Resolution order: `APP_VERSION` env override ->
git commit date -> `package.json` version (a last-resort constant, kept
semver-valid for npm so it is written `2026.9.1` without zero-padding).

Semver was dropped because nothing depends on this app: with no compatibility
contract to signal, the major/minor/patch split carried no information and the
digit-cap convention turned the major into a plain overflow counter. The badge
now answers the only two questions it ever really answered -- what is deployed,
and how old is it.

Consequence worth knowing: **the version changes by itself when you commit.**
There is nothing to remember and nothing to bump. If the badge renders empty,
`/api/version` failed -- that is deliberate, since a blank badge is honest and
a stale hardcoded one is not.

## Theater-list coverage

Chains whose list is fetched LIVE are complete by construction: **AMC** (by
state, official API), **Regal** (403 theaters), **Harkins** (nationwide route).
Static lists are only as good as whoever last edited them, so each has a
generator under `scripts/`:

- **Cinemark** — 300, Alaska to the East Coast (`build-cinemark-theater-map.js`)
- **Alamo** — 40 open cinemas / 23 markets / 14 states, regenerate with
  `node scripts/build-alamo-cinemas.js --write` from Alamo's own
  `/s/mother/v1/market` API (`drafthouse.com/robots.txt` is `Allow: /`). It was
  hand-maintained at 22 until 2026-09-02, i.e. nearly half the chain was
  invisible, with nothing to indicate it.
- **Landmark** — 26, and that is **complete**: their `/our-locations/` page
  publishes exactly 26 code-slugs. Atom Tickets lists 62 URLs matching
  "landmark", which are renamed or former venues; do not treat that as a gap.
- **Cinema West / Regency** — California regional by design.

If a chain seems to be missing a city, check its list length against the
chain's own source before assuming an adapter bug.

## IMAX 70mm (15/70) venues

`lib/imax-70mm-venues.js` is a **curated list**, not discovery: 15/70 film
projection is rare and shrinking, and no API anywhere distinguishes it from
digital IMAX. `nearestImax70mm()` ranks by straight line, then routes the
nearest few through `lib/drive-times.js` for a real drive time. It is
deliberately NOT radius-filtered -- "your nearest is an 8-hour drive" is a
useful answer for a format with 24 known US venues; "none found" is not.
Surfaced on `/api/search`'s `done` payload and rendered under the chain report.

**The notice does not appear on every search.** It is gated on
`isImax70mmRelease(movie)`, a curated list of films with an actual 70mm print,
because the chains cannot tell us: AMC reports `"IMAX at AMC"` for a 15/70
print and a digital laser show alike (verified live at Lincoln Square, whose
only formats are `IMAX at AMC`, `Dolby Cinema at AMC`, `Standard`). The list
fails quiet -- an unlisted film gets no notice rather than a wrong one -- so
add releases as 70mm runs are announced.

The standing "where is my nearest one" question is answered on demand by
`GET /api/imax-70mm?lat=&lng=[&movie=]`, which **ignores radiusMin** (someone
asking will drive further than for an ordinary showing) and, given a movie,
checks the chain-backed venues for showings. 13 of 25 are checkable
(AMC/Regal/Harkins); Cinemark's API is movie-scoped and the 8 non-chain venues
have no adapter, so those report `checked: false` rather than "no showings",
which would be a different and wrong claim -- and the UI stays silent about
them rather than implying anything.

Surfaced as a **third mode button, right-aligned** (`.mode-aside`) to signal it
is a different kind of thing from the two search modes beside it. That tab
shows only the location field -- date, radius, deadline, format and chain
filters are all hidden, because the lookup ignores the radius and "IMAX 70mm"
IS the format -- and renders into its own `#imax70Body`.

**Atom Tickets covers what our own adapters can't.** `lib/imax-atom.js` reads a
venue's Atom page (hand-verified `atomSlug` per venue) and reads the `IMAX70MM`
attribute Atom tags a showtime group with -- the only machine-readable 70mm
signal for Cinemark (movie-scoped API) and the museums and independents with no
adapter. Validated against Harkins Arizona Mills, where Atom's 70mm times
(11:45/15:30/19:15/23:00) match Harkins' own "IMAX" sessions exactly and its
non-70mm times match the "Digital" ones.

A film that turns up gets the same treatment as a free-time search card --
poster, year, runtime and scores -- returned in the response's `films` map.
Runtime comes free from AMC's showtimes (it ships `runTime` on every showing)
and only falls back to the AMC runtime catalog when no AMC venue happens to
carry the film; poster/year/scores come from the cached ratings lookup.

The panel lists far venues for free with checkboxes, then `venues=<names>`
looks up only the ones picked (at any distance -- an explicit pick overrides
the distance gate), and `priceVenue=<name>` runs real pricing for one venue.
AMC's prices and purchase links arrive free with its showtimes; Regal's price
is behind createOrder and Cinemark's behind a TicketSeatMap page fetch, so both
are only fetched on request -- which is why the "Price these showings" button
appears on Regal and Cinemark rows and not AMC ones.

**Cinemark pricing in this panel takes an extra step, because its showtimes
endpoint is MOVIE-scoped.** It cannot be asked "what is on at this theater",
which is why these showings come from Atom to begin with -- so `priceVenue` on
a Cinemark venue resolves a `cinemarkMovieId` first (static
`lib/cinemark-movie-map.js`, then a live lookup off the theater's own page via
`getCinemarkMovieIdForTitle`, the same two-step the main search uses), pulls
Cinemark's real showtimes for that movie at that one theater, and matches them
back to the Atom-sourced showings **by start time**. A showing Atom knows about
that Cinemark's own listing doesn't carry at the same HH:MM simply goes
unpriced.

**Cinemark lists a film's FORMATS as separate movie entries**, which is why
that matching originally found nothing. Both `lib/cinemark-movie-map.js` and
`getCinemarkMovieIdForTitle()` hold exactly one id per title -- the standard
run -- so asking with it returns the standard screen and never the 70mm one.
Confirmed at Carefree Circle: id 108919 gave 10:40/14:30/18:20/22:10 (3h50
apart) while the 70mm screen ran 11:40/15:20/19:00/22:40 (3h40 apart), and
Atom's 70mm times matched Cinemark's own theater page exactly. The different
SPACING is what rules out a timezone or previews offset; both sides pass the
same `dateISO` (Atom is fetched with `?date=`), which rules out a date
mismatch. `getCinemarkMovieIdsForTitle()` now returns every id near any
occurrence of the title and the caller tries each, keeping the one whose
showtimes line up with the times being priced -- a stronger test than guessing
at Cinemark's format wording, which is not consistent. Unlike Regal, the fee is real per-showing data, so these are marked
`feeStatus: "confirmed"`, and the Atom theater-page `buyUrl` is upgraded to a
direct Cinemark ticket link once priced. Each showing prices independently --
one failure can't blank out the ones that worked.

Caveat carried over from the adapter itself: **cinemark.com is not reachable
from this project's sandbox** (robots.txt + no egress), so this path is
verified structurally and against the frontend, not end-to-end. Expect
first-real-run adjustment, and note the two failure modes the UI already names
separately -- an unresolvable `cinemarkMovieId` (the film isn't listed at that
theater) versus a `rawBoxProducts`/bot-check miss (the pricing page itself
didn't come back).

**Only venues within `maxMiles` (default 200) are queried for showtimes.**
Everything else is still listed with its distance -- just not looked up, since
a theater 1,500 miles away is not a showing anyone is driving to and each one
costs a real credit. From Denver that is 2 lookups instead of 25, and 4.4s
instead of minutes. The UI offers a button naming how many venues were skipped;
`maxMiles=all` lifts the cap.

Costs **one Firecrawl credit per venue per day** -- Atom is Cloudflare-protected
so a direct fetch 403s -- cached to midnight through the shared tier, and
serialised with a gap because firing twelve at once returns 429. Slugs are
hand-mapped on purpose: automated matching produced four confident mismatches
(Regal LA Live -> "Live Oak", Carefree Circle -> "Tinseltown Colorado Springs",
Museum of Discovery -> "Paradigm Cinemas", Celebration! -> "AMC Grand Rapids").

Venues flagged `dedicatedImax` (single-screen museum houses) get NO attribute
from Atom -- there is one screen, so nothing to disambiguate -- so their
showings are included but `confirmed: false`.

The panel separates **three outcomes** that used to render identically as an
absent venue: showings found, checked-but-nothing-on-70mm (a real answer), and
couldn't-check (not an answer). A failure carries its reason and a `retryable`
flag for rate limits, because a 429 is worth trying again and a missing key is
not. Cached pages are read BEFORE the credential check, so an exhausted
Firecrawl key doesn't blank out venues already answered today.

**With `only70mm=true` it lists a venue's actual 70mm showings**, which is real
data rather than inference for two chains: AMC exposes an `IMAX70MM` attribute
code (distinct from a plain `70MM` print -- both appear at Lincoln Square on the
same day), and Regal spells it in the format string as `"IMAX IMAX 70mm"`.
Harkins says only `"IMAX"` even on a confirmed 70mm session, so its showings
carry `confirmed: false` and the UI marks them with an asterisk.

Note `lib/priceAdapters/amc-official.js` keeps `attributeCodes` ALONGSIDE the
flattened `format`: `format` normalizes a 70mm IMAX print and a digital IMAX
show both to "IMAX at AMC", which is right for the format-filter chips and
useless for this.

Four venues carry **firsthand seating notes** (`seating: { best, good,
tooClose, note }`), shown under the venue line. Row letters are per-venue and
do NOT transfer -- row F is solid at the Esquire and too close at CityWalk --
and `note` deliberately preserves the original hedging, since "confirmed good"
and "seems solid" are different claims. Add more the same way; they are
observations, not published data.

**This is not the `IMAX` format chip.** That chip is DIGITAL IMAX, which is what
every chain adapter reports. Anyone reaching for it expecting film gets the
wrong thing, which is why the UI spells out "70mm film" and the tooltip says so.

Provenance, because it matters more than the code: the list comes from
Engadget's 2026 article on where *The Odyssey* plays in true 70mm.
**imax.com was NOT scraped** -- its robots.txt carries
`User-agent: ClaudeBot / Disallow: /`. That article names 24 US venues while
its own text claims 30 exist; AMC Rivercenter 11 (San Antonio) was then added
from IMAX's own site, making 25. Multiple other sources put the US total at 25,
so the article's "30" was likely just wrong and **this list is probably
complete** -- inference, not verification, since nobody has checked it
venue-by-venue against an authoritative source. Adding more is welcome: prefer
the chain's own theater list for coordinates, and note where the venue came
from.

17 of the 25 belong to chains this app already prices (8 Regal, 4 AMC, 4
Cinemark, 1 Harkins), and those carry exact coordinates from the chain's own
theater list plus a `chainCode`. The remaining 8 are geocoded to the venue
itself, with the street recorded in `coordSource`. **No city centroids remain.**

If you extend the list: requiring a street in the geocoder response is NOT
enough validation. "TCL Chinese Theatre" first resolved to a bare point on
Hollywood Boulevard 2.3mi from the building, and Brenden Palms to the wrong
plaza on the right street -- both have street addresses. Require the returned
NAME to match the venue, and check how far the match moved.

Conversely, a street string is not automatically better than a named match.
The Museum of Discovery's published address (401 SW 2nd St, ZIP 33312)
geocodes to 401 SW 2nd AVENUE in ZIP 33301 -- wrong road, wrong postal area --
while the stored coordinate reverse-geocodes to the museum by name at 401
Himmarshee Street in 33312, the historic name for the same road. **Reverse-
geocoding is the check that settles these**: it tells you what is actually at
the point, and a matching ZIP is strong confirmation.

## Known gotchas before touching related code

- **`start.sh` must never be git-tracked.** It has real, hardcoded API keys
  (SerpApi, Scrape.do, ZenRows, Apify, Firecrawl, Bright Data, AMC vendor
  key). `start.sh.example` is the safe, placeholder-only template — copy it
  to `start.sh` for local dev, never edit `start.sh.example` with real
  values. **A `.gitignore` DOES exist** and covers `start.sh`,
  `node_modules/`, `.overpass-cache.json`, `.serpapi-schedule-cache.json`
  and `cache/`; `git add -An` stages nothing. An older version of this file
  claimed there was none and called adding one standing first-priority
  cleanup — that was stale, and it is worth checking `git check-ignore -v`
  rather than trusting either claim.
  **This repo is PUBLIC, and `start.sh` was committed to it.** `c62f6b1`,
  `211da66`, `f8f2be3` and `911c41d` all carry it, before `d5ecec2` removed
  it -- and `911c41d` held NINE credentials: `SERPAPI_KEY`,
  `SCRAPEDO_TOKEN`, `ZENROWS_API_KEY`, `APIFY_API_TOKEN`,
  `FIRECRAWL_API_KEY`, `BRIGHTDATA_API_KEY`, `BRIGHTDATA_ZONE`,
  `AMC_VENDOR_KEY` and `APP_PASSWORD`. All nine were **rotated on
  2026-09-03**, so the historical blobs are dead and no history rewrite is
  needed. The lesson stands though: anything committed here is public
  immediately and permanently, and a `.gitignore` cannot retract it.

  Note the check that found this. An anchored pattern
  (`^[[:space:]]*(export )?[A-Z_]+=`) reported only two credentials and was
  wrong -- the file has assignments that aren't at line start. The
  unanchored form is the one to use:

      for c in $(git log --all --format=%h -- start.sh); do
        git show $c:start.sh 2>/dev/null \
          | grep -oE "[A-Z][A-Z0-9_]{3,}=[\"']?[A-Za-z0-9_-]{20,}" \
          | cut -d= -f1 | sort -u
      done
- **Regal ticket types do not always fill `LongDescription`.** Colorado Center
  9's IMAX 70mm ticket arrives as `{Description: "General Admission",
  LongDescription: "", PriceInCents: 3199}` -- so a matcher reading only
  `LongDescription` saw an empty string and priced nothing while the price sat
  in the same object. `extractAdultPriceCents()` now reads both fields, and
  falls through four layers: explicit "adult" -> Vista age-inclusive phrasing
  ("12 and older") -> "General Admission"/"Standard" -> exactly one ticket
  passing the structural flags (`IsChildOnlyTicket`/`IsPackageTicket`/
  `IsRedemptionTicket`/`IsComplimentaryTicket`). That last layer deliberately
  refuses to answer when more than one candidate survives, since guessing which
  of several unnamed types is the adult one would put a wrong number in
  `price`, which by design means "read from the chain".
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
