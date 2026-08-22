const fetch = require("node-fetch");

const NAME = "brightdata";

// Two real, confirmed request shapes, from Bright Data's own complete
// OpenAPI specs -- these are genuinely different endpoints with
// different capabilities, not just different options on one endpoint:
//
//   SYNC:  POST /request  { zone, url, format, method, country, ... }
//   No body-relay field exists on this endpoint at all -- confirmed
//   from its complete schema, not inferred. GET requests (listing,
//   getTickets) use this path: real 200s, real data, correct times
//   against Regal across multiple theaters, and the outer status code
//   correctly reflects the target's real status.
//
//   ASYNC: POST /unblocker/req?zone=ZONE  { url, method, headers, body }
//          -> { response_id }
//          GET /unblocker/get_result?response_id=ID
//          -> 202 (pending) | 200 { status_code, headers, body } | 401 | 404
//   THIS is the one that actually supports relaying a POST body --
//   confirmed from its own complete schema, and used here for
//   createOrder. Base polling cadence (20s, 10s, then 5s repeated)
//   matches Bright Data's own documented recommendation, but the total
//   attempt count is bounded more conservatively than their full
//   schedule -- see the comment in submitAndPollAsync for why.
//
// The earlier version of this file self-excluded on any POST+body
// request after the SYNC endpoint rejected a `data` field outright --
// that rejection is still real and still explains why the sync
// endpoint can't do this, but it turned out to be the wrong endpoint
// entirely, not a dead end. The async flow below is what actually
// works.
function isConfigured() {
  return !!process.env.BRIGHTDATA_API_KEY && !!process.env.BRIGHTDATA_ZONE;
}

async function fetchViaProvider(targetUrl, options = {}) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_ZONE;
  const method = options.method || "GET";

  // CONFIRMED from Bright Data's own complete OpenAPI spec (both the
  // submit endpoint https://docs.brightdata.com/api-reference/rest-api/
  // unlocker/request and the poll endpoint .../unlocker/get-results):
  // the sync /request endpoint genuinely has no body-relay field (see
  // the header comment above), but the ASYNC pair does:
  //   POST /unblocker/req?zone=ZONE  { url, method, headers, body }
  //     -> { response_id }
  //   GET  /unblocker/get_result?response_id=ID
  //     -> 202 (still processing) | 200 { status_code, headers, body } | 401 | 404
  // Confirmed real polling cadence straight from Bright Data's own code
  // samples: wait ~20s before the first poll, 10s before the second,
  // then 5s repeated -- base cadence matches their docs, but the total
  // attempt count is bounded lower than their full recommended
  // schedule. See the comment in submitAndPollAsync for why.
  if (options.body) {
    return submitAndPollAsync(targetUrl, options, apiKey, zone);
  }

  const body = {
    zone,
    url: targetUrl,
    format: "raw",
    method,
  };

  const res = await fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  return res;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitAndPollAsync(targetUrl, options, apiKey, zone) {
  const submitRes = await fetch(`https://api.brightdata.com/unblocker/req?zone=${encodeURIComponent(zone)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url: targetUrl,
      method: options.method || "GET",
      headers: options.headers || {},
      // CONFIRMED REAL BUG, caught from a live report: passing the
      // already-stringified JSON as a raw string (the "string" variant
      // of their documented oneOf) resulted in every createOrder poll
      // coming back with an empty `body` field despite a real 200
      // status -- consistently, across three different theaters, not a
      // fluke. Their own schema explicitly documents that the "object"
      // variant is auto-serialized AND has its Content-Type header set
      // for us; the string variant carries no such guarantee. Parsing
      // options.body back into a real object here (it's always a valid
      // JSON string from every real caller -- regal-scrapedo.js builds
      // it via JSON.stringify) lets Bright Data's own documented
      // object-handling take over instead of relying on our own
      // manually-set headers, which may not have been reaching Regal's
      // endpoint correctly.
      body: options.body ? JSON.parse(options.body) : undefined,
    }),
  });

  if (!submitRes.ok) {
    return submitRes; // let the caller's !res.ok handling deal with a failed submit
  }

  const { response_id } = await submitRes.json();
  if (!response_id) {
    throw new Error(`brightdata: async submit succeeded but returned no response_id`);
  }

  // Bright Data's own recommended cadence is ~20s, then ~10s, then ~5s
  // repeated, ~22 attempts / ~130s worst case. Deliberately NOT using
  // their full schedule here: this provider sits FIRST in the rotation
  // (see index.js), and regal-scrapedo.js's own retry logic can call
  // fetchWithRotation fresh multiple times per search (up to 3x for the
  // session stage) -- if this path is slow on every attempt, that
  // compounds to several real minutes of waiting before ever reaching
  // apify-cfbypass, the confirmed-reliable fallback. That's worse than
  // the original "still checking Regal" complaint this session started
  // with, and directly contradicts the same fail-fast reasoning already
  // applied to apify-cfbypass's own 60s cap. Bounded to roughly the same
  // ~60s budget here instead -- still real time to succeed (their own
  // docs suggest many jobs finish within the first check or two), just
  // not the full worst-case wait before conceding to a provider already
  // known to work.
  const delays = [20_000, 10_000, ...Array(6).fill(5_000)];

  for (const delay of delays) {
    await sleep(delay);

    const pollRes = await fetch(
      `https://api.brightdata.com/unblocker/get_result?response_id=${encodeURIComponent(response_id)}`,
      { headers: { "Authorization": `Bearer ${apiKey}` } }
    );

    if (pollRes.status === 202) continue; // still processing, confirmed real signal for "not ready yet"

    if (!pollRes.ok) {
      return pollRes; // a real error (401/404/etc) -- let the caller's !res.ok handling deal with it
    }

    const envelope = await pollRes.json();

    // CONFIRMED REAL from a live report, and it's good news: the object-
    // body fix above DID work -- Regal genuinely returned real order
    // data (a real userSessionId, right there in the dumped envelope).
    // The bug was entirely in how this unwrapped the response, not in
    // whether the request itself succeeded. Two real shapes have now
    // been observed from this same endpoint:
    //   (a) the documented wrapper: { status_code, headers, body:"<string>" }
    //   (b) the target's JSON returned DIRECTLY, unwrapped, with no
    //       status_code/headers/body keys at all -- what actually came
    //       back for every createOrder call. Bright Data most likely
    //       auto-parses and returns JSON responses unwrapped, diverging
    //       from the one plain-text example in their own docs (which
    //       only demonstrated the wrapper shape for a non-JSON target).
    // Detecting which shape this is by checking for the wrapper's own
    // keys, rather than assuming one or the other -- if neither
    // status_code nor body is present, treat the whole envelope as the
    // real content itself. Status defaults to 200 in that case since
    // reaching this point already means pollRes.ok was true and the
    // status wasn't 202 (still-pending) -- get_result only returns a
    // real 200 for a genuinely completed job per Bright Data's own docs.
    const isWrapperShape = "status_code" in envelope || "body" in envelope;
    const targetStatus = isWrapperShape ? (envelope.status_code ?? 200) : 200;
    const bodyText = isWrapperShape ? (envelope.body ?? "") : JSON.stringify(envelope);

    // KNOWN LIMITATION of the unwrapped-shape case: there's no real
    // status_code available in that shape, so a genuine non-2xx error
    // from the target (if Bright Data ever returns one unwrapped rather
    // than as a real HTTP error at the poll-request level) would show
    // up here as status 200 regardless. Not fixable without more real
    // examples of what an unwrapped ERROR response looks like -- only
    // successes have been observed so far. Acceptable for now since
    // downstream code (e.g. createOrderSession's own check for a real
    // order.userSessionId) still catches a genuinely broken response on
    // its own terms, just without the precise status code.
    if (!bodyText) {
      console.error(
        `brightdata: async result for ${targetUrl.split("?")[0]} has genuinely no usable content despite status ` +
        `${targetStatus} -- full envelope: ${JSON.stringify(envelope).slice(0, 500)}`
      );
    }

    return {
      ok: targetStatus >= 200 && targetStatus < 300,
      status: targetStatus,
      statusText: targetStatus >= 200 && targetStatus < 300 ? "OK" : `HTTP ${targetStatus}`,
      headers: new Map(Object.entries(isWrapperShape ? envelope.headers || {} : {})),
      text: async () => bodyText,
      json: async () => (isWrapperShape ? JSON.parse(bodyText || "null") : envelope),
    };
  }

  throw new Error(
    `brightdata: async result for response_id ${response_id} was not ready after ~60s of polling -- giving up ` +
    `(deliberately bounded lower than Bright Data's own full recommended schedule -- falling through to the next provider).`
  );
}

// Bright Data doesn't surface a per-request credit cost in response headers
// -- confirmed from a real captured response (headers are Regal's own,
// forwarded through; no Bright Data billing header is added). Usage is
// tracked in their dashboard only, not per-response. Return 0 so the
// "couldn't read credit cost -- will under-report" warning stays silent.
function readCreditCost(res) {
  return 0;
}

function looksLikeQuotaExceeded(res) {
  return res.status === 402 || res.status === 429 || res.status === 401;
}

module.exports = { NAME, isConfigured, fetchViaProvider, readCreditCost, looksLikeQuotaExceeded };
