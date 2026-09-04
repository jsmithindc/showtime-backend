// Out-of-band notification for the few things worth interrupting someone over.
//
// console.error goes to Render's logs, which is a place you have to remember
// to look -- fine for diagnosing something you already know about, useless as
// a warning. This posts to a webhook so the message reaches a phone.
//
// Deliberately a generic URL rather than an integration: one env var points at
// Discord, Slack, ntfy.sh or anything else that accepts a POST, with no vendor
// SDK, no API key to rotate, and nothing to maintain when a service changes.
// Unset, this is just the console.error it always was.
//
//   Discord   channel -> Integrations -> Webhooks -> New Webhook -> copy URL
//   Slack     an Incoming Webhook URL
//   ntfy.sh   https://ntfy.sh/<a-topic-name-you-invent>, then subscribe in the
//             app -- no account, and the fastest of the three to set up

const fetch = require("node-fetch");

const TIMEOUT_MS = 8000;

/**
 * Fire-and-forget. Never throws, never blocks a request, and never retries --
 * a missed alert must not become a second incident, and the console line has
 * already recorded it regardless.
 */
function sendAlert(message) {
  console.error(`ALERT: ${message}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return Promise.resolve(false);

  // Discord reads `content`, Slack reads `text`, and each ignores the other's
  // key -- so one body serves both with nothing to configure. ntfy shows the
  // raw body, which is legible enough.
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message, text: message }),
    timeout: TIMEOUT_MS,
  })
    .then((res) => {
      if (!res.ok) console.error(`Alert webhook returned HTTP ${res.status} -- check ALERT_WEBHOOK_URL.`);
      return res.ok;
    })
    .catch((err) => {
      console.error(`Alert webhook failed: ${err.message}`);
      return false;
    });
}

module.exports = { sendAlert };
