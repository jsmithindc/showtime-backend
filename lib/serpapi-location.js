const fetch = require("node-fetch");

const LOCATIONS_URL = "https://serpapi.com/locations.json";

// SerpApi's `location` param must be an exact canonical name from its own
// location database (e.g. "Fullerton,California,United States"), not just
// any "City, ST" string a person would naturally type -- "Austin, TX"
// happened to coincidentally match a real entry, "Fullerton, CA" didn't.
// This lookup is free and needs no API key, so instead of requiring the
// caller to already know the exact canonical spelling, we resolve it
// automatically, once per search.
const cache = new Map();

async function tryLookup(query) {
  const params = new URLSearchParams({ q: query, limit: "1" });
  const url = `${LOCATIONS_URL}?${params.toString()}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Locations lookup (${url}) failed: ${res.status} ${res.statusText}${
        text ? ` -- ${text.slice(0, 200)}` : ""
      }`
    );
  }

  const results = await res.json();
  return Array.isArray(results) ? results[0]?.canonical_name : null;
}

async function resolveCanonicalLocation(rawLocation) {
  if (cache.has(rawLocation)) {
    return cache.get(rawLocation);
  }

  // SerpApi's locations.json does substring matching against the stored
  // location *name*, which seems to fail once a state abbreviation is
  // appended (e.g. "Fullerton, CA" matches nothing, but "Fullerton" alone
  // does). Try progressively simpler variants: the raw string first, then
  // just the part before the first comma.
  const cityOnly = rawLocation.split(",")[0].trim();
  const variants = [...new Set([rawLocation, cityOnly])];

  const attempts = [];
  for (const variant of variants) {
    const canonical = await tryLookup(variant);
    if (canonical) {
      cache.set(rawLocation, canonical);
      return canonical;
    }
    attempts.push(variant);
  }

  throw new Error(
    `Locations lookup found no match for any of: ${attempts
      .map((a) => `"${a}"`)
      .join(", ")}`
  );
}

module.exports = { resolveCanonicalLocation };
