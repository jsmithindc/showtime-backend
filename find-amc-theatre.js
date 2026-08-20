#!/usr/bin/env node
// One-off lookup tool: node find-amc-theatre.js "search term"
// Requires AMC_VENDOR_KEY to be set in your environment.

const { findTheatreIdByName, testKnownTheatre } = require("./lib/priceAdapters/amc-official");

const query = process.argv[2];
if (!query) {
  console.error('Usage: node find-amc-theatre.js "search term"');
  console.error('Example: node find-amc-theatre.js "fullerton"');
  process.exit(1);
}

async function main() {
  // Diagnostic first: hit a single known-real theatre ID before the bulk
  // list, so a failure tells us whether it's auth/key-wide or specific
  // to the theatres-list endpoint.
  console.log("Testing a known theatre ID first (diagnostic)...");
  const diag = await testKnownTheatre();
  console.log(`  Status: ${diag.status} ${diag.statusText}`);
  if (diag.status !== 200) {
    console.log(`  Body: ${diag.body}`);
    console.log("\nThe key/auth itself is failing (not just the bulk list). Common causes:");
    console.log("  - Key was just issued and needs a few minutes to fully activate");
    console.log("  - Key is valid but scoped to a sandbox, not production");
    console.log("  - A typo in AMC_VENDOR_KEY");
    process.exit(1);
  }
  console.log("  OK -- key and auth are working.\n");

  console.log(`Searching for theatres matching "${query}"...`);
  const matches = await findTheatreIdByName(query);
  if (matches.length === 0) {
    console.log(`No AMC theatres matched "${query}".`);
    return;
  }
  console.log(`Found ${matches.length} match(es):`);
  for (const m of matches) {
    console.log(`  ${m.id}  ${m.name}  (${m.slug})`);
  }
  console.log("\nAdd the one you want to lib/amc-theatre-map.js like:");
  console.log(`  "${matches[0].name}": ${matches[0].id},`);
}

main().catch((err) => {
  console.error("Lookup failed:", err.message);
  process.exit(1);
});
