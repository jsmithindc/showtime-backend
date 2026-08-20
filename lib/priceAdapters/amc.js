// TODO: implement against AMC's actual showtime/ticket page for a given
// theater + film + date + time + format. AMC theater pages are keyed by
// their own theater slug/id, not MovieGlu's cinema_id, so you'll likely
// need a one-time mapping table (MovieGlu cinema_id -> AMC theater slug)
// built by hand for the theaters you actually care about.
//
// Signature to preserve: takes a showing object (from movieglu.js), returns
// a Promise<number|null> — dollars, or null if unavailable.

async function getPrice(showing) {
  throw new Error("AMC price adapter not implemented yet");
}

module.exports = { getPrice };
