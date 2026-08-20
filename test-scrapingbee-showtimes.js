#!/usr/bin/env node
// Tests whether ScrapingBee can get us real movie showtimes for a
// theater, two ways:
// 1. Plain render_js=true fetch of a real Google search URL -- saves
//    raw HTML so you can manually check whether the showtimes widget
//    rendered at all.
// 2. Their AI-extraction feature (ai_extract_rules) with a plain-English
//    description of what we want -- if this works, it sidesteps needing
//    to know Google's exact widget HTML structure at all.
//
// Usage: SCRAPINGBEE_API_KEY=your-key node test-scrapingbee-showtimes.js "AMC La Mirada 7"

const fetch = require("node-fetch");
const fs = require("fs");

const apiKey = process.env.SCRAPINGBEE_API_KEY;
const theaterName = process.argv[2] || "AMC La Mirada 7";

if (!apiKey) {
  console.error("Set SCRAPINGBEE_API_KEY as an env var first (sign up free, no card, at scrapingbee.com).");
  process.exit(1);
}

async function testPlainFetch() {
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(theaterName + " showtimes")}`;
  // custom_google=true is required when targeting Google specifically --
  // confirmed real from ScrapingBee's own error message. premium_proxy=
  // true added after the basic proxy tier hit Google's own CAPTCHA wall
  // (confirmed real: spb-resolved-url pointed at google.com/sorry/index,
  // Google's bot-detection redirect) -- their own error message
  // suggested this as the next tier (10-25 credits) before the more
  // expensive stealth_proxy option (75 credits).
  const url = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(googleUrl)}&render_js=true&custom_google=true&premium_proxy=true&block_resources=false`;

  console.log(`[Plain fetch] Fetching: ${googleUrl}`);
  const res = await fetch(url);
  console.log(`HTTP ${res.status} ${res.statusText}`);
  const allHeaders = {};
  res.headers.forEach((value, name) => { allHeaders[name] = value; });
  console.log("Response headers (look for a credit-cost header):", JSON.stringify(allHeaders));

  if (!res.ok) {
    console.error("Request failed:", (await res.text()).slice(0, 500));
    return;
  }

  const html = await res.text();
  const outPath = "./scrapingbee-raw-response.html";
  fs.writeFileSync(outPath, html);
  console.log(`Raw HTML saved to ${outPath} (${html.length} bytes) -- open it and search (Cmd+F) for a real showtime like "7:00pm" or a movie title.`);
}

async function testAiExtraction() {
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(theaterName + " showtimes")}`;
  const extractPrompt = JSON.stringify({
    movies: "a list of every movie title shown playing at this theater today, each with its showtimes and formats (like Standard, 3D, IMAX)",
  });
  const url = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(googleUrl)}&render_js=true&custom_google=true&premium_proxy=true&block_resources=false&ai_extract_rules=${encodeURIComponent(extractPrompt)}`;

  console.log();
  console.log(`[AI extraction] Fetching with ai_extract_rules for: ${googleUrl}`);
  const res = await fetch(url);
  console.log(`HTTP ${res.status} ${res.statusText}`);
  const allHeaders = {};
  res.headers.forEach((value, name) => { allHeaders[name] = value; });
  console.log("Response headers (look for a credit-cost header):", JSON.stringify(allHeaders));

  const text = await res.text();
  if (!res.ok) {
    console.error("Request failed:", text.slice(0, 1000));
    return;
  }

  try {
    const data = JSON.parse(text);
    console.log("=== AI-extracted result ===");
    console.log(JSON.stringify(data, null, 2));
  } catch {
    console.log("Response wasn't JSON -- first 1000 chars:");
    console.log(text.slice(0, 1000));
  }
}

async function main() {
  await testPlainFetch();
  await testAiExtraction();
}

main().catch((err) => {
  console.error("Script failed:", err.message);
  process.exit(1);
});
