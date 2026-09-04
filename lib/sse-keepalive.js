// Cloudflare and most reverse proxies drop a connection whose origin has gone
// quiet -- Cloudflare's limit is 100 seconds. This app runs right up against
// that: a slow search was measured at 124.7s total with "first Regal" landing
// at 86.6s, so a silent stretch past the limit is not hypothetical, and the
// failure mode is a search dying mid-flight rather than erroring cleanly.
//
// A line starting with ":" is a COMMENT in the SSE spec -- every client ignores
// it, so it can never be mistaken for an event -- but it is still bytes on the
// wire, which is all an idle timer cares about. Harmless with no proxy in
// front, and it also survives a phone dropping to a weak connection.

const DEFAULT_INTERVAL_MS = 20000;

/**
 * Keep an SSE response from going silent. Returns a stop function; callers
 * don't normally need it, since the stream's own end/close does the work.
 */
function keepSseAlive(res, everyMs = DEFAULT_INTERVAL_MS) {
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, everyMs);
  // Safe here, unlike the batch timer in camofox-factory where it dropped
  // work: an in-flight response already holds the event loop open, and once it
  // doesn't, there is nothing left worth keeping alive.
  if (timer.unref) timer.unref();

  const stop = () => clearInterval(timer);
  // Covers every exit -- "finish" for a normal res.end() on any of the several
  // return paths, "close" for a client that navigates away mid-search.
  if (res.on) {
    res.on("close", stop);
    res.on("finish", stop);
  }
  return stop;
}

module.exports = { keepSseAlive, DEFAULT_INTERVAL_MS };
