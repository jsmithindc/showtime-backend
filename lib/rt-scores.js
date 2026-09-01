const fetch = require("node-fetch");

// Tomatometer and Popcornmeter, read from Rotten Tomatoes' public movie pages.
//
// WHY THIS EXISTS: OMDb carries Rotten Tomatoes only sporadically for films
// currently in theatres -- in one live search, exactly one of ~20 titles had an
// RT score. RT has no public API. The RapidAPI listings that wrap it cap the
// free tier at 5 requests/day, and a single free-time search resolves 20-30
// titles, so those are unusable here.
//
// SCOPE, deliberately narrow:
//   - Only /m/{slug} is fetched. RT's robots.txt (User-agent: *) disallows
//     /search, /m/*/pictures, /tv/*/pictures, /critics/self-submission/ and
//     /user/account/* -- the movie page itself is not disallowed. The
//     jellyfin-ratings-plugin this mirrors falls back to /search for awkward
//     slugs; that is NOT done here, because it is disallowed. A title whose
//     slug doesn't resolve simply gets no score.
//   - Results cached hard (12h) with in-flight dedup and negative caching, so
//     a busy evening is a handful of requests rather than one per showing.
//
// robots.txt permitting a path is not the same as RT's Terms of Use permitting
// automated collection. This is opt-in for that reason: unset, nothing here
// runs. Enable with ENABLE_RT_SCRAPE=true.
//
// EXPECT THIS TO BREAK. It depends on RT's page structure, which they can
// change without notice. It's written to fail closed -- any parse failure
// returns null and the UI simply shows no RT score.

const BASE = "https://www.rottentomatoes.com/m/";
const REQUEST_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

const cache = new Map();

function isConfigured() {
  return process.env.ENABLE_RT_SCRAPE === "true";
}

// RT slugs are lowercase with underscores: "The Dog Stars" -> the_dog_stars.
// Diacritics are folded rather than dropped so "Amélie" becomes amelie.
function toSlug(title) {
  return String(title || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// The scorecard <script> carries its attributes across several lines, so a
// single-line tag regex misses it. Locate the id, then take everything between
// the end of that tag and its closing tag.
function extractScorecard(html) {
  const idIdx = html.indexOf('id="media-scorecard-json"');
  if (idIdx === -1) return null;
  const open = html.indexOf(">", idIdx);
  const close = html.indexOf("</script>", open);
  if (open === -1 || close === -1) return null;
  try {
    return JSON.parse(html.slice(open + 1, close));
  } catch {
    return null;
  }
}

function pctToNumber(value) {
  const m = /^(\d{1,3})%$/.exec(String(value || "").trim());
  return m ? Number(m[1]) : null;
}

async function fetchPage(slug) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(BASE + slug, { headers: HEADERS, signal: controller.signal, redirect: "follow" });
    if (res.status === 404) return null;          // wrong slug guess, not an error
    if (!res.ok) throw new Error(`RT page ${slug}: ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchScores(title, year) {
  // RT disambiguates same-titled films with a year suffix, so try the plain
  // slug first and the year-qualified one second. Both are /m/ pages; no
  // /search is involved.
  const slugs = [toSlug(title)];
  if (year) slugs.push(`${toSlug(title)}_${year}`);

  for (const slug of slugs) {
    const html = await fetchPage(slug);
    if (!html) continue;
    const card = extractScorecard(html);
    if (!card) continue;

    const tomatometer = pctToNumber(card.criticsScore?.scorePercent);
    const audience = pctToNumber(card.audienceScore?.scorePercent);
    if (tomatometer == null && audience == null) continue;

    return {
      tomatometer,
      audience,
      certifiedFresh: card.criticsScore?.certified === true,
      verifiedHot: !!card.audienceScore?.certifiedFresh && card.audienceScore.certifiedFresh !== "none",
      url: BASE + slug,
    };
  }
  return null;
}

async function getScores(title, year) {
  if (!isConfigured() || !title) return null;

  const key = `${toSlug(title)}::${year || ""}`;
  const hit = cache.get(key);
  if (hit && (hit.promise || Date.now() - hit.at < CACHE_TTL_MS)) {
    return hit.promise || hit.value;
  }

  const promise = fetchScores(title, year).catch((err) => {
    console.error(`RT lookup failed for "${title}":`, err.message);
    return null;
  });
  cache.set(key, { promise });
  const value = await promise;
  // Negative results cached too -- a title RT doesn't have under a guessable
  // slug won't acquire one, and re-asking every search is pointless traffic.
  cache.set(key, { value, at: Date.now() });
  if (value) {
    // A film can have an audience score and no Tomatometer yet (too few critic
    // reviews), so print "n/a" rather than the literal "null%" that showed up
    // in a live log.
    const pct = (v) => (v == null ? "n/a" : `${v}%`);
    console.error(`RT for "${title}": tomatometer ${pct(value.tomatometer)}, audience ${pct(value.audience)}`);
  }
  return value;
}

module.exports = { getScores, isConfigured, toSlug };
