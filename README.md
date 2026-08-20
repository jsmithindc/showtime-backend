# Showtime Finder — backend sketch

No MovieGlu, no waiting on an API approval email — this runs on two free
services: **OpenStreetMap's Overpass API** for "what theaters are near me"
(no signup at all) and **SerpApi's free tier** for showtimes + pricing.

```
Phase 1 — THEATER DISCOVERY (free, no signup)
  lat/lng + radius(min)
        |
        v
  Overpass API: cinemas tagged in OpenStreetMap within radius
        |
        v
  theatersInRange[]   <- usually a handful, not dozens

Phase 2 — TARGETED SHOWTIMES + PRICING (SerpApi, one call per theater)
  for each theater in range:
    SerpApi engine=google, q="<movie> showtimes at <theater>"
        |
        v
  Local filtering (no extra network calls):
    - drop showings where start + runtime + buffer > deadline
    - drop showings that already started
    - drop formats you didn't ask for
        |
        v
  matching showings, sorted cheapest first (unpriced ones last)
```

## Setup

```
npm install
export SERPAPI_KEY=your_key_here
node server.js
```

`GET /api/search?movie=Spider-Man:+Brand+New+Day&lat=30.2672&lng=-97.7431&radiusMin=15&deadline=13:15&formats=standard,imax&location=Austin,+TX`

- `lat`/`lng` — your coordinates, used for both the Overpass radius search
  and the "minutes away" distance filter.
- `location` — a plain city/region string, separate from lat/lng. This is
  SerpApi's `location` param and helps it return the right regional
  results.
- `radiusMin` — how many minutes away you're willing to travel. Converted
  internally to a search radius in meters (with a 25% pad, since
  straight-line distance under-counts real road distance).
- `deadline` — 24-hour `HH:MM`, the latest a showing can end.
- `formats` — optional comma-separated list (`standard`, `imax`, `3d`,
  etc.) to filter to. Omit to include everything.

## Only one signup needed

SerpApi's free tier is roughly 100-250 searches/month depending on when
you sign up. Calls are batched per unique theater within your radius, not
per showing — a search with 5 theaters in range costs 5 SerpApi calls, not
one per showtime. `serpApiCallsUsed` in the response tells you exactly
what a given search cost, so you can watch your monthly usage in practice.

## Getting real ticket prices (Regal specifically)

SerpApi/Google doesn't surface price for your local theaters, so if price
matters, there are two real paths -- try both, they're not mutually
exclusive:

**Path A: Regal's official partner API (best, if you get approved)**
Regal runs a real developer program at `developer.regmovies.com` with a
documented Showtimes endpoint that returns actual adult/child/senior
pricing per showing. It needs registration and an API key -- email
`apimanager@regalcinemas.com`. No guarantee they approve individual/
personal use rather than businesses, and there'll likely be a wait, same
as MovieGlu earlier. Worth trying since it's free and clean if it works.

**Path B: `lib/priceAdapters/regal-scrape.js` (fallback, untested live)**
Mimics regmovies.com's own internal ticketing flow via Playwright, based
on the publicly documented pattern of creating an order session then
calling a `getTicketsForSession` endpoint. Two real risks, both unresolved
because I can't reach regmovies.com from this environment to test:
- **regmovies.com is Cloudflare-protected.** A bare Playwright session may
  get stuck on a challenge page instead of reaching real content. If that
  happens, the realistic next step is a paid scraping proxy (e.g.
  Scrape.do, which the reference write-up uses specifically to get past
  this) -- not free, but the tradeoff if Path A doesn't pan out.
- **The click-through selectors are guessed, not verified.** `regal-
  scrape.js` tries to click a link matching the movie title, but the real
  page structure hasn't been seen live.

Only theaters listed in `lib/regal-cinema-map.js` get run through Path B.
To add a theater: visit regmovies.com/theatres, find it, and copy the
4-digit code from its URL (e.g. `regal-village-park-0147` -> `0147`).
Currently both Fullerton-area Regal theaters are listed with `null` --
fill those in before Path B can do anything.

**First live run of Path B will very likely need adjustment.** Specifically watch for:
- Does it reach real regmovies.com content, or a Cloudflare challenge page?
- Does the movie-title click actually navigate to a showtime list?
- Does `getTicketsForSession` fire at all, and does its JSON match the
  shape `extractPricedShowtimes()` expects?

## Deploying (Railway)

This app is stateless and reads all secrets from environment variables
(see `.env.example` for the full list), so it deploys cleanly to Railway
with no code changes:

1. Push this repo to GitHub. `start.sh` and `node_modules/` are
   gitignored on purpose -- `start.sh` has real API keys hardcoded into
   it, and must never be committed. Use `start.sh.example` (safe,
   placeholder values) as the local-dev template instead.
2. Railway → New Project → Deploy from GitHub repo → select this repo.
3. In Railway's dashboard → Settings → Variables, add each variable
   listed in `.env.example` with your real values (`SERPAPI_KEY`,
   `SCRAPEDO_TOKEN`, `AMC_VENDOR_KEY`, and optionally `ZENROWS_API_KEY`,
   `DISABLE_REGAL_PRICING`, `DISABLE_CINEMARK_PRICING`). Do **not** set
   `PORT` -- Railway assigns and injects that automatically, and
   `server.js` already reads `process.env.PORT` with a fallback.
4. Set `APP_PASSWORD` too once this has a public URL rather than
   `localhost` -- without it, anyone with the link can run searches
   against your API keys and consume your quota. This is a real,
   functioning gate (`server.js` line ~46), not just a comment.
5. Railway auto-detects `npm install` + the `start` script in
   `package.json` (`node server.js`) -- no extra config needed. It
   gives you a public HTTPS URL as soon as the first deploy succeeds.

One thing worth confirming on the first real deploy rather than
assuming: Regal's pricing path routes through Scrape.do/ZenRows
specifically to get past Cloudflare's bot protection. A cloud host's
datacenter IP sometimes gets treated differently than a home connection
-- it may work identically (routing already goes through those
providers either way), but it's worth watching the first real Regal
search on the deployed instance rather than assuming it behaves exactly
like local.

## Known limitations, honestly

- **Theater coverage depends on OpenStreetMap data quality in your area.**
  Dense cities are usually well-mapped; some areas aren't. If a theater
  you know about doesn't show up, that's the likely reason — worth a
  one-time sanity check against Google Maps for your area. If coverage is
  bad locally, swapping in Google Places API (free tier, needs a Google
  Cloud billing account even though the tier itself is free) is the next
  step up.
- **Runtime is a fixed assumption (128 min), not looked up per movie.**
  SerpApi's showtimes results don't reliably include runtime. Update the
  `RUNTIME_MIN` constant in `server.js` per movie, or wire in a free
  runtime lookup (OMDb's free tier is a reasonable option) if this should
  stop being manual.
- **Ticket price isn't always present.** Google's showtimes widget shows
  price for some theaters/regions and not others. Showings without a
  price still show up in results (sorted after the priced ones) with a
  `bookingLink` so you can check manually.
- **Distance is straight-line, not drive-time.** Fine near a grid-like
  street layout, will be off near rivers/highways/one-way systems. Swap in
  Google Distance Matrix or Mapbox Directions if that matters for your
  area.
- **This has been tested against hand-built sample data shaped like each
  API's documented response**, not live traffic — I don't have network
  access to overpass-api.de or serpapi.com from this environment. Treat
  your first real run as a smoke test: if either API's actual response
  shape differs from its docs, the parsing in `lib/theaters-overpass.js`
  or `lib/priceAdapters/serpapi.js` is the place to adjust.

## Note on this README

Everything above "Deploying (Railway)" describes an earlier version of
this project (SerpApi-only pricing, a fixed runtime constant, no live
network testing) and predates AMC/Regal/Harkins/Cinemark/Cinema
West/Regency all being live, directly-integrated adapters with real
pricing. It's kept as-is for now rather than silently rewritten, since
untangling which parts are still true needs a real pass -- flagged here
so it's not mistaken for current documentation. The "Files no longer
needed" section that used to follow this one has been removed outright
rather than left stale: it referenced `amc.js`, `regal.js`, `cinemark.js`,
and `fandango.js` as present-but-unused stubs, and all four (plus
`index.js` and `regal-scrape.js`) have since been deleted as genuinely
dead code.
