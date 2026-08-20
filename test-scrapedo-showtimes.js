#!/usr/bin/env node
// One-off test: does a cheap SERP API return anything usable for movie
// showtimes, even without a documented "showtimes" field in its schema?
// Checks local_results/knowledge_graph/organic_results for anything
// showtime-shaped, and saves raw HTML (Scrape.do only, since ZenRows'
// dedicated SERP endpoint doesn't offer a raw-HTML option) so you can
// manually check whether Google's showtimes widget is even present in
// the underlying page being scraped.
//
// Usage:
//   SCRAPEDO_TOKEN=your-token node test-scrapedo-showtimes.js "AMC La Mirada 7" scrapedo
//   ZENROWS_API_KEY=your-key  node test-scrapedo-showtimes.js "AMC La Mirada 7" zenrows

const fetch = require("node-fetch");
const fs = require("fs");

const theaterName = process.argv[2] || "AMC La Mirada 7";
const provider = process.argv[3] || "scrapedo";

async function testScrapeDo() {
  const token = process.env.SCRAPEDO_TOKEN;
  if (!token) {
    console.error("Set SCRAPEDO_TOKEN as an env var first.");
    process.exit(1);
  }

  const query = `${theaterName} showtimes`;
  const url = `https://api.scrape.do/plugin/google/search?token=${token}&q=${encodeURIComponent(query)}&include_html=true`;

  console.log(`[Scrape.do] Querying: "${query}"`);
  const res = await fetch(url);
  console.log(`HTTP ${res.status} ${res.statusText}`);
  console.log(`Real credit cost (if header present):`, res.headers.get("scrape.do-request-cost") || "(no cost header found)");

  if (!res.ok) {
    console.error("Request failed:", await res.text());
    return;
  }

  const data = await res.json();

  console.log();
  console.log("=== Top-level fields present in the response ===");
  console.log(Object.keys(data));

  console.log();
  console.log("=== local_results (checking for anything showtime-shaped) ===");
  console.log(JSON.stringify(data.local_results, null, 2)?.slice(0, 2000) || "(empty/absent)");

  console.log();
  console.log("=== knowledge_graph (checking for anything showtime-shaped) ===");
  console.log(JSON.stringify(data.knowledge_graph, null, 2)?.slice(0, 2000) || "(empty/absent)");

  if (data.html) {
    const outPath = "./scrapedo-raw-response.html";
    fs.writeFileSync(outPath, data.html);
    console.log();
    console.log(`Raw HTML saved to ${outPath} -- open it and search (Cmd+F) for a real showtime like "7:00pm" or a movie title to see whether Google's showtimes widget rendered at all in what Scrape.do fetched.`);
    console.log(`Also search for the word "showtimes" or "Buy tickets" to spot the widget's container even if the exact text differs.`);
  } else {
    console.log();
    console.log("No 'html' field in the response -- did include_html=true actually get applied?");
  }
}

async function testZenRows() {
  const apikey = process.env.ZENROWS_API_KEY;
  if (!apikey) {
    console.error("Set ZENROWS_API_KEY as an env var first.");
    process.exit(1);
  }

  // ZenRows' DEDICATED SERP endpoint -- a completely different product
  // from the general-purpose page-proxy endpoint (api.zenrows.com) this
  // project already uses for Regal. Confirmed real from their own docs:
  // query goes in the URL PATH, not a query param, and the domain is
  // different (serp.api.zenrows.com, not api.zenrows.com).
  const query = `${theaterName} showtimes`;
  const url = `https://serp.api.zenrows.com/v1/targets/google/search/${encodeURIComponent(query)}?apikey=${apikey}`;

  console.log(`[ZenRows SERP] Querying: "${query}"`);
  const res = await fetch(url);
  console.log(`HTTP ${res.status} ${res.statusText}`);

  const allHeaders = {};
  res.headers.forEach((value, name) => { allHeaders[name] = value; });
  console.log("Response headers:", JSON.stringify(allHeaders));

  const text = await res.text();
  if (!res.ok) {
    console.error("Request failed:", text.slice(0, 1000));
    return;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log();
    console.log("Response wasn't valid JSON -- first 1000 chars:");
    console.log(text.slice(0, 1000));
    return;
  }

  console.log();
  console.log("=== Top-level fields present in the response ===");
  console.log(Object.keys(data));

  console.log();
  console.log("=== Full response (checking for anything showtime-shaped) ===");
  console.log(JSON.stringify(data, null, 2)?.slice(0, 3000));
}

async function main() {
  if (provider === "zenrows") {
    await testZenRows();
  } else {
    await testScrapeDo();
  }
}

main().catch((err) => {
  console.error("Script failed:", err.message);
  process.exit(1);
});

