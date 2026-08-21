const fetch = require("node-fetch");

const NAME = "apify-cfbypass";

// CONFIRMED WORKING against the actual target this session -- the only
// provider in this whole rotation that has ever cleared Regal's
// createOrder step. Real captured proof: a manual test run returned a
// genuine order.userSessionId, not a Cloudflare challenge or a 403.
//
// This is a DIFFERENT actor and a DIFFERENT technique from apify.js
// (Super Scraper API, which Regal's own bot detection confirmed
// blocks -- see the real 403s in that actor's own log). This one is
// ecomscrape/cloudflare-web-scraper-ppe (actor ID maq3ovzX1DmVTRzVA,
// taken directly from the real console URL, not guessed), and it does
// NOT work as a literal URL-wrapping proxy the way Super Scraper does.
// Real confirmed input schema, from that actor's own page:
//   { urls, proxy: {useApifyProxy, apifyProxyGroups, apifyProxyCountry},
//     max_retries_per_url, js_script, js_timeout,
//     retrieve_result_from_js_script, page_is_loaded_before_running_script,
//     execute_js_async, retrieve_html_from_url_after_loaded }
// Every field above is REQUIRED -- a real live run threw a validation
// error over a single missing boolean (execute_js_async), so all of
// them are always sent here, never omitted as "optional".
//
// THE ACTUAL TECHNIQUE, confirmed by a real successful run: `urls` is
// NOT the real target -- it's an ANCHOR page (the site root) that lets
// a real browser session clear Cloudflare's challenge normally. Then
// `js_script` runs arbitrary JS *inside that already-cleared page*,
// including a `fetch()` call to the REAL target -- reusing the
// session's own cookies and passed challenge, rather than sending a
// fresh, isolated proxied request that looks suspicious on its own.
// This is very likely WHY it succeeds where every literal-proxy
// approach (Scrape.do, ZenRows, Apify's own Super Scraper) either gets
// rate/credit-limited or flatly 403'd.
//
// CONFIRMED specifically for createOrder (POST). The listing and
// getTickets steps (GET) use the exact same technique here on the
// reasoning that the same domain, same Cloudflare protection, and same
// session-reuse trick should generalize -- but that generalization is
// NOT independently confirmed the way createOrder is. Worth watching
// the first real listing/getTickets call through this provider
// specifically.
const ACTOR_ID = "maq3ovzX1DmVTRzVA";

function isConfigured() {
  // Same Apify account/token as apify.js -- Apify tokens are account-
  // wide, not actor-specific, confirmed since both actors accept the
  // same Bearer token.
  return !!process.env.APIFY_API_TOKEN;
}

// Builds the fetch() call that will run INSIDE the anchor page's own
// browser context. `body` here is already a JSON-stringified string
// (regal-scrapedo.js always passes it that way, e.g.
// JSON.stringify({cinemaId: cinemaCode})) -- embedding it via
// JSON.stringify(body) turns that string into a properly escaped JS
// string literal for the generated script's source, which is exactly
// what fetch()'s body option wants (a string), not a second layer of
// JSON encoding.
function buildJsScript(targetUrl, { method, headers, body }) {
  const fetchOptions = {
    method: method || "GET",
    headers: { "Content-Type": "application/json", ...(headers || {}) },
  };
  const optionsLiteral = body
    ? `{ method: ${JSON.stringify(fetchOptions.method)}, headers: ${JSON.stringify(fetchOptions.headers)}, body: ${JSON.stringify(body)} }`
    : `{ method: ${JSON.stringify(fetchOptions.method)}, headers: ${JSON.stringify(fetchOptions.headers)} }`;

  // Deliberately using r.text() here, NOT r.json() (the manual test
  // used r.json(), which worked because createOrder's real response
  // happens to be clean JSON) -- for the listing/getTickets steps we
  // don't yet have the same confirmation, and this project has already
  // been burned once this session by an endpoint returning a non-JSON
  // error body (Regency's 26-char error) that would throw inside a
  // r.json() call instead of coming back as inspectable text. Bundling
  // the real HTTP status alongside the body text so the caller's
  // !res.ok checks still work correctly -- those are load-bearing for
  // existing retry/error logic (e.g. classifyRegal422 in
  // regal-scrapedo.js needs the real status to distinguish a 422 from
  // anything else).
  return (
    `return fetch(${JSON.stringify(targetUrl)}, ${optionsLiteral})` +
    `.then(r => r.text().then(t => ({ status: r.status, ok: r.ok, bodyText: t })));`
  );
}

async function fetchViaProvider(targetUrl, options = {}) {
  const apiToken = process.env.APIFY_API_TOKEN;
  const jsScript = buildJsScript(targetUrl, options);

  const input = {
    urls: ["https://www.regmovies.com/"],
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
      apifyProxyCountry: "US",
    },
    max_retries_per_url: 2,
    js_script: jsScript,
    js_timeout: 10,
    retrieve_result_from_js_script: true,
    page_is_loaded_before_running_script: true,
    // Confirmed working as `false` in the real successful test -- the
    // actor still correctly awaited the fetch()'s Promise chain despite
    // this flag, so there was never a "got back a stringified Promise"
    // problem in practice. Left as false to exactly match the
    // confirmed-working configuration rather than changing something
    // that already worked.
    execute_js_async: false,
    retrieve_html_from_url_after_loaded: false,
  };

  // CONFIRMED REAL problem from a live report: a call that was doomed
  // to fail sat for the FULL 300 seconds (Apify's own server-side cap
  // on this endpoint) before finally returning a 408 -- and this fetch
  // had no timeout of its own, so nothing here would have failed any
  // faster even if it had been obviously stuck much earlier. That's
  // exactly what "still checking Regal" for minutes looks like from the
  // outside. Since Apify's own timeout already decides the call is a
  // lost cause at 300s, there's no value in us waiting that long too --
  // failing sooner reaches the identical outcome (this call didn't
  // work, try the next provider) without the multi-minute stall.
  // Bounded well under 300s but generously above the ~15s a real
  // successful run actually took.
  const REQUEST_TIMEOUT_MS = 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${apiToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      }
    );
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`apify-cfbypass timed out after ${REQUEST_TIMEOUT_MS}ms (Apify's own server-side cap is 300s -- this fails well before that rather than waiting the full time for a call already unlikely to succeed)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return res; // let the caller's !res.ok / looksLikeQuotaExceeded handling deal with actor-invocation-level failures
  }

  const items = await res.json();
  const result = items?.[0]?.result_from_js_script;
  // CONFIRMED REAL from four separate live createOrder calls in one
  // search: this actor normalizes the KEYS of whatever object our own
  // js_script returns from camelCase to snake_case before storing it in
  // the dataset -- even though the script's source literally says
  // `bodyText` (see buildJsScript above), the stored result consistently
  // came back as `body_text`. The STRING CONTENT inside that field
  // (Regal's own real JSON, e.g. userSessionId) is passed through
  // untouched -- only the wrapper object's own keys get normalized.
  // Reading both so this can't silently break if the actor's behavior
  // is inconsistent across different fields or actor versions.
  const bodyText = result?.bodyText ?? result?.body_text;

  if (!result || typeof bodyText !== "string") {
    // The actor run itself succeeded, but didn't produce the shape our
    // own js_script is supposed to return -- e.g. the anchor page never
    // loaded, or the script threw inside the sandboxed page context.
    // Surface this as a clear failure rather than silently returning
    // something the caller can't use.
    return {
      ok: false,
      status: 502,
      statusText: `apify-cfbypass: no usable result_from_js_script in dataset output (got: ${JSON.stringify(items).slice(0, 300)})`,
      headers: new Map(),
      text: async () => JSON.stringify(items),
      json: async () => items,
    };
  }

  return {
    ok: result.ok,
    status: result.status,
    statusText: result.ok ? "OK" : `HTTP ${result.status}`,
    headers: new Map(),
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  };
}

// UNCONFIRMED exact per-request cost from a response header (this actor
// doesn't appear to expose one the way Scrape.do/ZenRows do) -- but
// unlike apify.js's Super Scraper cost (genuinely unknown), this
// actor's own page DOES publish a real rate: "from $0.60 / 1,000 bypass
// cloudflares". That's a real published number, just not a same-
// response-confirmed one, and it's denominated in dollars, not the
// arbitrary "credit" units ZenRows/Scrape.do report -- mixing that into
// the aggregate credits total would misrepresent the unit, so this
// still honestly returns null rather than a misleadingly-precise
// number. The dollar rate is the right number to check on Apify's own
// billing dashboard directly, not in this app's own credit tracker.
function readCreditCost(res) {
  return null;
}

function looksLikeQuotaExceeded(res) {
  return res.status === 402 || res.status === 429 || res.status === 401;
}

module.exports = { NAME, isConfigured, fetchViaProvider, readCreditCost, looksLikeQuotaExceeded };
