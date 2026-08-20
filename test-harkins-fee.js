#!/usr/bin/env node
// Dumps the FULL raw GetTicketTypes response for a real Harkins Cerritos
// 16 showing, to check whether there's a fee field we're not currently
// reading -- same situation AMC's purchaseUrl turned out to be.
//
// Usage: node test-harkins-fee.js "The Odyssey"

const { getShowtimesForMovie } = require("./lib/priceAdapters/harkins-official");
const fetch = require("node-fetch");

const HARKINS_ID = "63"; // Cerritos, already confirmed real
const CINEMA_ID = "0000000010"; // Cerritos, already confirmed real
const movieTitle = process.argv[2] || "The Odyssey";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function main() {
  console.log(`Finding a real session for "${movieTitle}" at Harkins Cerritos 16...`);
  const performances = await getShowtimesForMovie({
    movieTitle,
    dateISO: todayISO(),
    anyTheaterId: HARKINS_ID,
  });

  const atCerritos = performances.filter((p) => String(p.theatreId) === HARKINS_ID);
  if (atCerritos.length === 0) {
    console.error(`No real "${movieTitle}" performances found at Harkins Cerritos 16 today -- try a different movie title, or check the theater actually has a showing today.`);
    return;
  }

  const session = atCerritos[0];
  console.log(`Using real session: sessionId=${session.sessionId}, showtimeOffset=${session.showtimeOffset}, format=${session.format}`);
  console.log();

  const url = `https://ticketingservice.harkins.com/api/Theatre/GetTicketTypes/cinemaid/${CINEMA_ID}/sessionid/${session.sessionId}?includeRedemptionTickets=true`;
  console.log(`Fetching: ${url}`);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
    },
  });
  console.log(`HTTP ${res.status} ${res.statusText}`);

  if (!res.ok) {
    console.error(await res.text());
    return;
  }

  const json = await res.json();
  console.log();
  console.log("FULL raw response (checking for a fee field):");
  console.log(JSON.stringify(json, null, 2));
}

main().catch((err) => {
  console.error("Script failed:", err.message);
  process.exit(1);
});
