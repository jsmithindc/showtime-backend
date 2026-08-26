// Marcus Theatres — api-injin.marcustheatres.com CMS API
// Auth: Bearer JWT token, auto-refreshed via POST /user/v2/token with Basic auth.
// The credentials are the Injin platform's own app-level credential (CINEMAAPP role),
// sourced from ticketing.marcustheatres.com's public JS bundle. Token expiry is 2000 min
// (~33 hours) per the request payload; refreshed automatically on expiry or 401/500.
// Flow:
//   1. GET /cms/v2/films?cinemaid={uuid}&showdate=YYYY-MM-DD → filter by title
//   2. GET /cms/v2/{filmUUID}/showtimes?showdate=YYYY-MM-DD&cinemaid={uuid}
//   3. GET /order/v2/seats?sessionid={showtime.id (UUID)} → ticket pricing
// CONFIRMED LIVE 2026-08-25: Gurnee Mills Cinema (IL), General $10.40 + $2.59 fee.

const fetch = require("node-fetch");

const API_BASE = "https://api-injin.marcustheatres.com";
const REQUEST_TIMEOUT_MS = 12000;

// All 77 Marcus Theatres cinemas with lat/lng from live API (2026-08-25).
const MARCUS_CINEMAS = [
  { id: "38135ddb-fd00-4eac-803b-086664448fa2", cinemaid: "2380", name: "Marcus Little Rock Cinema", lat: 34.6626, lng: -92.4128, tz: "America/Chicago", state: "AR" },
  { id: "3993bf74-abe2-4575-89af-8f8bd953f3a7", cinemaid: "2375", name: "Marcus Aurora Cinema", lat: 39.6548, lng: -104.77, tz: "America/Denver", state: "CO" },
  { id: "cb73a915-ecfe-424b-81cf-a2a20354b2e0", cinemaid: "2352", name: "Marcus Horizon Village Cinema", lat: 34.0267, lng: -84.0426, tz: "America/New_York", state: "GA" },
  { id: "33b14317-d763-4ca2-9771-932e87e69513", cinemaid: "2350", name: "Marcus Roswell Cinema", lat: 34.0624, lng: -84.4235, tz: "America/New_York", state: "GA" },
  { id: "d33eeeb4-fe0c-4ace-88c9-b082f62823c9", cinemaid: "2351", name: "Marcus Tucker Cinema", lat: 33.8427, lng: -84.2514, tz: "America/New_York", state: "GA" },
  { id: "b1d0c1db-5878-4fe7-8ece-d6e74682fe65", cinemaid: "2523", name: "Marcus Cedar Rapids Cinema", lat: 42.0321, lng: -91.655, tz: "America/Chicago", state: "IA" },
  { id: "49ccf264-4587-49d9-bbb1-bf4930ee497e", cinemaid: "2225", name: "Marcus Coral Ridge Cinema", lat: 41.6904, lng: -91.6012, tz: "America/Chicago", state: "IA" },
  { id: "55a041a9-790a-478b-b6d4-89de977f95a3", cinemaid: "2224", name: "Marcus Crossroads Cinema", lat: 42.4595, lng: -92.3214, tz: "America/Chicago", state: "IA" },
  { id: "e2cda4b5-c40d-4e4c-8252-e3573ae99c7f", cinemaid: "2226", name: "Marcus Sycamore Cinema", lat: 41.6419, lng: -91.5106, tz: "America/Chicago", state: "IA" },
  { id: "90e5b892-88d0-4060-a0c1-8933188df043", cinemaid: "2302", name: "Marcus Addison Cinema", lat: 41.946, lng: -88.0264, tz: "America/Chicago", state: "IL" },
  { id: "b03e21f2-1628-4cd8-b0af-ee277fcbb724", cinemaid: "2521", name: "Marcus Bloomington Cinema + IMAX", lat: 40.4926, lng: -89.0343, tz: "America/Chicago", state: "IL" },
  { id: "4a577b61-9f9e-4935-9bb4-25f45061cfcc", cinemaid: "2303", name: "Marcus Chicago Heights Cinema", lat: 41.5083, lng: -87.6684, tz: "America/Chicago", state: "IL" },
  { id: "ecda7baf-f087-4dfb-8cc0-710ca2b2212e", cinemaid: "2306", name: "Marcus Country Club Hills Cinema", lat: 41.5838, lng: -87.7217, tz: "America/Chicago", state: "IL" },
  { id: "10ed587a-7ced-4e52-b638-cbb612901559", cinemaid: "2305", name: "Marcus Elgin Cinema", lat: 42.0294, lng: -88.3358, tz: "America/Chicago", state: "IL" },
  { id: "4383d0ac-8353-43e1-974a-decb0730fde8", cinemaid: "2300", name: "Marcus Gurnee Mills Cinema", lat: 42.3914, lng: -87.96, tz: "America/Chicago", state: "IL" },
  { id: "a205ee81-3a3b-4926-a620-51e543ac5a2c", cinemaid: "2528", name: "Marcus O'Fallon Cinema", lat: 38.5906, lng: -89.9449, tz: "America/Chicago", state: "IL" },
  { id: "831b3fdf-8421-4ec0-a51b-772d5e642fbc", cinemaid: "2301", name: "Marcus Orland Park Cinema", lat: 41.592, lng: -87.8539, tz: "America/Chicago", state: "IL" },
  { id: "e5b75c97-bdd7-46cd-8943-69d4f30a003f", cinemaid: "2385", name: "Marcus Brannon Crossing Cinema", lat: 37.9525, lng: -84.5278, tz: "America/New_York", state: "KY" },
  { id: "a5b33e86-4ed5-4506-b4c1-31866f056c6b", cinemaid: "2362", name: "Marcus Citiplace Cinema", lat: 30.4225, lng: -91.1266, tz: "America/Chicago", state: "LA" },
  { id: "da5ae6a7-4264-46a4-916f-c1594ca9dc63", cinemaid: "2360", name: "Marcus Covington Cinema", lat: 30.433, lng: -90.0856, tz: "America/Chicago", state: "LA" },
  { id: "8b381bee-d860-49f6-9cc6-c6b9d7b09c7e", cinemaid: "2361", name: "Marcus Juban Crossing Cinema", lat: 30.4685, lng: -90.9248, tz: "America/Chicago", state: "LA" },
  { id: "3fceee52-9018-4a8d-a4d1-f59744613859", cinemaid: "2508", name: "Marcus Duluth Cinema", lat: 46.7827, lng: -92.099, tz: "America/Chicago", state: "MN" },
  { id: "3654897e-c1c1-4575-97df-6b0a35c7f999", cinemaid: "2506", name: "Marcus Oakdale Cinema", lat: 45.0317, lng: -92.9727, tz: "America/Chicago", state: "MN" },
  { id: "b6ea9b7f-a49e-4458-af64-35478a890336", cinemaid: "2507", name: "Marcus Parkwood Cinema", lat: 45.5549, lng: -94.238, tz: "America/Chicago", state: "MN" },
  { id: "4ee06c5e-788e-424d-9b62-45d0c9eb3c82", cinemaid: "2529", name: "Marcus Rochester Cinema + IMAX", lat: 43.958, lng: -92.4592, tz: "America/Chicago", state: "MN" },
  { id: "46deee44-d6c8-4975-93c0-744d2a349655", cinemaid: "2503", name: "Marcus Rosemount Cinema", lat: 44.7278, lng: -93.1335, tz: "America/Chicago", state: "MN" },
  { id: "a795f501-82bc-4119-b702-4c119b0fe44b", cinemaid: "2515", name: "Marcus Southbridge Crossing Cinema", lat: 44.7765, lng: -93.4107, tz: "America/Chicago", state: "MN" },
  { id: "1ca2a289-1e63-4d15-b3d1-f1f50f9deb36", cinemaid: "2041", name: "Marcus West End Cinema", lat: 44.9671, lng: -93.3476, tz: "America/Chicago", state: "MN" },
  { id: "5f2d8013-3ef0-4fdd-b530-9e34d6de3b4d", cinemaid: "2520", name: "Marcus Arnold Cinema", lat: 38.4099, lng: -90.386, tz: "America/Chicago", state: "MO" },
  { id: "f975b0d9-e5d1-46d1-8be9-75429c2a5962", cinemaid: "2522", name: "Marcus Cape West Cinema", lat: 37.298, lng: -89.5833, tz: "America/Chicago", state: "MO" },
  { id: "84285934-fcbc-4506-8880-1873ea62d097", cinemaid: "2524", name: "Marcus Chesterfield Cinema", lat: 38.6658, lng: -90.6088, tz: "America/Chicago", state: "MO" },
  { id: "97186df7-03c6-46b5-ba9e-fd82a15ae85d", cinemaid: "2525", name: "Marcus Des Peres Cinema", lat: 38.6033, lng: -90.4532, tz: "America/Chicago", state: "MO" },
  { id: "03d38295-a1a6-47e3-a72c-0228339d843d", cinemaid: "2526", name: "Marcus Eagles' Landing Cinema", lat: 38.1817, lng: -92.6101, tz: "America/Chicago", state: "MO" },
  { id: "bb523e8b-3bf6-4d84-8f00-055c6c807cf4", cinemaid: "2527", name: "Marcus Mid Rivers Cinema", lat: 38.7953, lng: -90.616, tz: "America/Chicago", state: "MO" },
  { id: "5e831341-7bf0-443e-b6c5-57be8807930f", cinemaid: "2533", name: "Marcus Ronnie's Cinema + IMAX", lat: 38.5272, lng: -90.3624, tz: "America/Chicago", state: "MO" },
  { id: "feddefc4-1f5f-4580-b45e-dfd704b4959f", cinemaid: "2530", name: "Marcus St. Charles Cinema", lat: 38.7625, lng: -90.5267, tz: "America/Chicago", state: "MO" },
  { id: "33cfc4db-16d6-491c-ad27-9c11ff4423f5", cinemaid: "2532", name: "Marcus Town Square Cinema", lat: 38.7668, lng: -90.7629, tz: "America/Chicago", state: "MO" },
  { id: "22aa60d7-cbc3-44ec-804d-5635373899d7", cinemaid: "2511", name: "Marcus Century Cinema", lat: 46.8673, lng: -96.8465, tz: "America/Chicago", state: "ND" },
  { id: "9378274e-8705-43ab-b76b-8093a34c39d2", cinemaid: "2512", name: "Marcus West Acres Cinema", lat: 46.8558, lng: -96.8475, tz: "America/Chicago", state: "ND" },
  { id: "ad671e3c-d33a-405e-9b5c-facc44383f4f", cinemaid: "2450", name: "Marcus East Park Cinema", lat: 40.8156, lng: -96.6284, tz: "America/Chicago", state: "NE" },
  { id: "fe12a0f6-b895-464c-8225-092b9b92fbea", cinemaid: "2451", name: "Marcus Edgewood Cinema", lat: 40.7601, lng: -96.6425, tz: "America/Chicago", state: "NE" },
  { id: "87933e25-6add-4f42-ba8e-33a109f0baa0", cinemaid: "2452", name: "Marcus Lincoln Grand Cinema", lat: 40.8142, lng: -96.7048, tz: "America/Chicago", state: "NE" },
  { id: "5fdce381-3cb2-4e3c-a0b2-c1a6db927a9d", cinemaid: "2455", name: "Marcus Majestic Cinema of Omaha", lat: 41.2933, lng: -96.1358, tz: "America/Chicago", state: "NE" },
  { id: "b898bb31-7385-4a63-935e-cbd3809ea61a", cinemaid: "2453", name: "Marcus South Pointe Cinema", lat: 40.7434, lng: -96.679, tz: "America/Chicago", state: "NE" },
  { id: "3ad9f3c7-c769-498c-91b1-9476b2ca45bf", cinemaid: "2454", name: "Marcus Twin Creek Cinema", lat: 41.1468, lng: -95.9714, tz: "America/Chicago", state: "NE" },
  { id: "9ad5b7bd-e666-4b19-92ce-d147304248d2", cinemaid: "2456", name: "Marcus Village Pointe Cinema", lat: 41.2607, lng: -96.1867, tz: "America/Chicago", state: "NE" },
  { id: "0c237b58-a8d8-4ccb-afdb-4db75062ee1a", cinemaid: "2370", name: "Marcus SyracuseTownship Cinema", lat: 43.0569, lng: -76.2713, tz: "America/New_York", state: "NY" },
  { id: "8535fe95-0cd1-4b44-bccb-0396c7c14b55", cinemaid: "2401", name: "Marcus Crosswoods Cinema", lat: 40.1146, lng: -83.0097, tz: "America/New_York", state: "OH" },
  { id: "d21b4af0-abd8-4e41-85b5-a21a9a2eee02", cinemaid: "2400", name: "Marcus Pickerington Cinema", lat: 39.9273, lng: -82.784, tz: "America/New_York", state: "OH" },
  { id: "4beeb567-9d51-4230-a7c0-d190e92414ef", cinemaid: "2342", name: "Marcus Collegeville Cinema", lat: 40.1667, lng: -75.48, tz: "America/New_York", state: "PA" },
  { id: "cfc61ed2-c37b-4a36-84f8-429a312a5b95", cinemaid: "2341", name: "Marcus Exton Cinema", lat: 40.0211, lng: -75.6279, tz: "America/New_York", state: "PA" },
  { id: "e8a68339-f60b-4173-9279-21dbd61d7460", cinemaid: "2340", name: "Marcus Flourtown Cinema", lat: 40.1106, lng: -75.2119, tz: "America/New_York", state: "PA" },
  { id: "2c9b17df-849d-4d97-a3aa-17a0586662b5", cinemaid: "2343", name: "Marcus Trexlertown Cinema", lat: 40.555, lng: -75.5765, tz: "America/New_York", state: "PA" },
  { id: "09d6052c-9dc0-478c-beb2-d7ab2ea1b8e6", cinemaid: "2321", name: "Marcus Denton Cinema", lat: 33.2319, lng: -97.1433, tz: "America/Chicago", state: "TX" },
  { id: "9dfea2da-1b8c-4da7-9a75-0bf207ac6112", cinemaid: "2320", name: "Marcus Hulen Cinema", lat: 32.6779, lng: -97.4013, tz: "America/Chicago", state: "TX" },
  { id: "1119a30b-22b2-4375-9414-509f4bf8f960", cinemaid: "2324", name: "Marcus West 7th Street Cinema", lat: 32.7503, lng: -97.3581, tz: "America/Chicago", state: "TX" },
  { id: "c5ef8d1e-0d7d-4bb4-a25b-f54a91c00f90", cinemaid: "2390", name: "Marcus Williamsburg Cinema", lat: 37.2881, lng: -76.7249, tz: "America/New_York", state: "VA" },
  { id: "57b89fa2-54a6-432f-a9d3-51f518be3517", cinemaid: "2211", name: "Marcus Bay Park Cinema", lat: 44.4845, lng: -88.0619, tz: "America/Chicago", state: "WI" },
  { id: "c2414f8f-6df8-4747-bb13-44312b6464a4", cinemaid: "2120", name: "Marcus BistroPlex Southridge", lat: 42.9504, lng: -88.0017, tz: "America/Chicago", state: "WI" },
  { id: "25bc3789-0362-43f4-b698-0448b9724621", cinemaid: "2217", name: "Marcus Campus Cinema", lat: 43.8461, lng: -88.8384, tz: "America/Chicago", state: "WI" },
  { id: "81a78c93-f026-47cc-9c3b-b660f7f5b02c", cinemaid: "2218", name: "Marcus Cedar Creek Cinema", lat: 44.8646, lng: -89.6327, tz: "America/Chicago", state: "WI" },
  { id: "ce3c5430-9736-4c73-93bb-fc65ab7d88b9", cinemaid: "2221", name: "Marcus Green Bay East Cinema", lat: 44.4825, lng: -87.9401, tz: "America/Chicago", state: "WI" },
  { id: "a67c8531-1816-49bb-90f2-52cf5d132e66", cinemaid: "2111", name: "Marcus Hillside Cinema", lat: 43.047, lng: -88.3696, tz: "America/Chicago", state: "WI" },
  { id: "fbc22e09-85cb-4ff9-9a96-81e7447b230d", cinemaid: "2216", name: "Marcus Hollywood Cinema", lat: 44.2646, lng: -88.4633, tz: "America/Chicago", state: "WI" },
  { id: "5d545608-9d31-4637-a408-5d78f0a6bd78", cinemaid: "2201", name: "Marcus La Crosse Cinema", lat: 43.7829, lng: -91.225, tz: "America/Chicago", state: "WI" },
  { id: "2b738b73-bd52-4077-8526-c3748c60ece4", cinemaid: "2118", name: "Marcus Majestic Cinema of Brookfield", lat: 43.0399, lng: -88.1833, tz: "America/Chicago", state: "WI" },
  { id: "a1e3c59f-dd9e-4bc4-8e57-d7c31a4b7068", cinemaid: "2113", name: "Marcus Menomonee Falls Cinema", lat: 43.1859, lng: -88.1343, tz: "America/Chicago", state: "WI" },
  { id: "4d631b0b-d778-4033-9fb4-de43a3519a96", cinemaid: "2121", name: "Marcus Movie Tavern Brookfield", lat: 43.0304, lng: -88.1094, tz: "America/Chicago", state: "WI" },
  { id: "74ce8880-1b12-4381-96d3-3dab2aeeee97", cinemaid: "2109", name: "Marcus North Shore Cinema", lat: 43.2308, lng: -87.9216, tz: "America/Chicago", state: "WI" },
  { id: "5c318232-c3a1-4f84-834b-68cb6e9908b0", cinemaid: "2203", name: "Marcus Oshkosh Cinema", lat: 44.0158, lng: -88.581, tz: "America/Chicago", state: "WI" },
  { id: "4ff9bf94-9d7f-43e2-8fb5-72378e38ea8c", cinemaid: "2227", name: "Marcus Palace Cinema", lat: 43.1698, lng: -89.2726, tz: "America/Chicago", state: "WI" },
  { id: "f60f5de2-8546-4058-bd0b-f95c63b91292", cinemaid: "2206", name: "Marcus Point Cinema", lat: 43.0578, lng: -89.5196, tz: "America/Chicago", state: "WI" },
  { id: "c1a8b47e-7991-4234-bd23-d60c91118563", cinemaid: "2116", name: "Marcus Renaissance Cinema", lat: 42.7174, lng: -87.9125, tz: "America/Chicago", state: "WI" },
  { id: "2144672f-13c1-428f-87be-b5b0d51144bb", cinemaid: "2112", name: "Marcus Ridge Cinema", lat: 42.9494, lng: -88.1062, tz: "America/Chicago", state: "WI" },
  { id: "934b0261-fd54-4971-9746-2124b23336ee", cinemaid: "2202", name: "Marcus Sheboygan Cinema", lat: 43.7575, lng: -87.7512, tz: "America/Chicago", state: "WI" },
  { id: "0ae5be46-b06c-420c-ba18-678e9831f948", cinemaid: "2100", name: "Marcus South Shore Cinema", lat: 42.913, lng: -87.9341, tz: "America/Chicago", state: "WI" },
  { id: "45452aec-823b-4481-95db-2d1e1d072d67", cinemaid: "2228", name: "Marcus Valley Grand Cinema", lat: 44.2558, lng: -88.3439, tz: "America/Chicago", state: "WI" },
];

// Experience UUID → display format string.
// Confirmed from live /cms/v2/experiences endpoint 2026-08-25.
// Seating-type experiences (DreamLounger, Stadium Seating, etc.) map to "Standard".
const EXPERIENCE_FORMAT = {
  "c6fab2d4-224e-4428-bb5f-5269e7245ca3": "IMAX",
  "93bf116b-184d-4210-93a2-5c5b1e42fff4": "IMAX 3D",
  "8e11e53a-dd26-4766-9507-ce1617d0c052": "4DX",
  "1896b422-dda4-4ac7-a9f5-3b9d2b512933": "4DX 3D",
  "f244178d-eebd-461f-b58b-ada6ee18bb99": "4DX 3D",
  "ebcf13c0-d78c-47b7-8873-234e8e0f9479": "ScreenX",
  "b52a0748-c69a-49b9-a131-d7e9105dc97b": "ScreenX",
  "002e6d41-917c-4ba1-906f-a9d6a4c520cf": "ScreenX 3D",
  "ebcf13c0-d78c-47b7-8873-234e8e0f9434": "3D",
  "24dc9238-abd0-4b43-9176-ec294f83d0cd": "3D",
  "f3c263ea-19b1-451a-86cb-49109a5d70f9": "3D",
  "8517ef22-22c6-4cbe-8c23-0527cd57d5bd": "3D",
  "854343bd-c6a8-408c-b9f6-8f58ce92773e": "3D",
  "97b45f51-6a1a-4bb0-a4dd-d0920c5dc728": "UltraScreen",
  "2bf4b892-5279-46b9-9cf8-8889661a671a": "UltraScreen",
  "ccd07902-9648-4d28-a026-cf403dc37a6e": "UltraScreen DLX",
  "1e4c8279-0443-477c-917f-2a8e17deb9ae": "UltraScreen DLX",
  "34ee36d1-08c7-49a8-9b8e-a4a32829a673": "UltraScreen DLX",
  "d9510bea-3812-4a25-bdd9-145a26b32598": "UltraScreen DLX",
  "d6fab2d4-224e-4428-bb5f-5269e7245ca3": "Superscreen DLX",
  "5c2e8eca-4a86-4716-ad9d-fb0551d09a43": "Superscreen DLX",
  "e9927aee-f3ab-4ff4-930d-aa7d367067ab": "BigScreen",
  "f3c263ea-19b1-451a-86cb-49109a5d70f9": "BigScreen 3D",
  "478ad178-4843-4fae-a784-af3dbccf7b1d": "BigScreen",
};

// Priority order for picking the "best" format when a showtime has multiple experiences.
const FORMAT_PRIORITY = [
  "IMAX 3D", "IMAX", "4DX 3D", "4DX", "ScreenX 3D", "ScreenX",
  "UltraScreen DLX", "Superscreen DLX", "UltraScreen", "BigScreen 3D", "BigScreen",
  "3D", "Standard",
];

function marcusDisplayFormat(experienceIds) {
  if (!experienceIds || experienceIds.length === 0) return "Standard";
  const formats = experienceIds
    .map((id) => EXPERIENCE_FORMAT[id])
    .filter(Boolean);
  if (formats.length === 0) return "Standard";
  for (const prio of FORMAT_PRIORITY) {
    if (formats.includes(prio)) return prio;
  }
  return formats[0];
}

// Auto-refresh token via the Injin platform token endpoint.
// Credentials sourced from ticketing.marcustheatres.com's own public JS bundle (module 89969
// in 1514-*.js) — these are app-level credentials for the CINEMAAPP role, not a user password.
// Falls back to MARCUS_TOKEN env var if set and still valid.
// Cache invalidated on 401/500 and re-fetched automatically.
let _cachedToken = null;
let _tokenExp = 0; // Unix epoch seconds

const TOKEN_REFRESH_BUFFER_SEC = 300; // refresh when < 5 min from expiry
const TOKEN_FETCH_TIMEOUT_MS = 15000;

// MARCUS_INJIN_PASSWORD: set this env var on Render to the value from the ticketing
// site's public JS bundle (module 89969 in 1514-*.js, the `auth` object on the
// /user/v2/token call). It's an app-level credential for the CINEMAAPP role,
// not a user password, but we keep it out of git regardless.
async function fetchMarcusTokenFromAPI() {
  const pw = process.env.MARCUS_INJIN_PASSWORD;
  if (!pw) throw new Error("Marcus: MARCUS_INJIN_PASSWORD env var not set");
  const creds = Buffer.from(`website@injin.com:${pw}`).toString("base64");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TOKEN_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://api-injin.marcustheatres.com/user/v2/token", {
      method: "POST",
      headers: {
        "Platform": "web/prod",
        "Version": "1.0",
        "Content-Type": "application/json",
        "Authorization": `Basic ${creds}`,
      },
      body: JSON.stringify({ accessTokenExpiry: 2000, getUserInfo: true, keepMeSignedIn: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Marcus token refresh failed: HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const data = await res.json();
    const token = data.accessToken || (data.data && data.data.accessToken);
    if (!token) throw new Error(`Marcus token refresh: no accessToken in response: ${JSON.stringify(data).slice(0, 200)}`);
    const payloadB64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    return { token, exp: payload.exp || 0 };
  } finally {
    clearTimeout(t);
  }
}

async function getMarcusToken(forceRefresh = false) {
  const nowSec = Date.now() / 1000;

  // Use cached token if still valid
  if (!forceRefresh && _cachedToken && _tokenExp > nowSec + TOKEN_REFRESH_BUFFER_SEC) {
    return _cachedToken;
  }

  // Try env var first — useful if it's still valid (e.g. recently set)
  if (process.env.MARCUS_TOKEN && !forceRefresh) {
    const parts = process.env.MARCUS_TOKEN.split(".");
    if (parts.length === 3) {
      try {
        const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
        if (payload.exp && payload.exp > nowSec + TOKEN_REFRESH_BUFFER_SEC) {
          _cachedToken = process.env.MARCUS_TOKEN;
          _tokenExp = payload.exp;
          console.error("Marcus: using MARCUS_TOKEN env var (still valid)");
          return _cachedToken;
        }
      } catch {}
    }
  }

  console.error("Marcus: fetching fresh token from Injin token API...");
  const { token, exp } = await fetchMarcusTokenFromAPI();
  _cachedToken = token;
  _tokenExp = exp;
  const expStr = exp ? new Date(exp * 1000).toISOString() : "unknown";
  console.error(`Marcus: token refreshed via Injin API (exp ${expStr})`);
  return _cachedToken;
}

async function marcusHeaders() {
  const token = await getMarcusToken();
  return {
    Accept: "application/json",
    appplatform: "WEBSITE",
    appversion: "1.0.0",
    dataversion: "en-US",
    origin: "https://ticketing.marcustheatres.com",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

// Wraps fetch with a timeout + automatic token retry on 401/500.
async function fetchMarcus(url, options = {}, _isRetry = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    const headers = await marcusHeaders();
    res = await fetch(url, { ...options, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  // On 401 or 500 Unauthorized, invalidate the cached token and retry once
  if (!_isRetry && (res.status === 401 || res.status === 500)) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || body.toLowerCase().includes("unauthorized")) {
      console.error(`Marcus: got ${res.status} — invalidating token cache and retrying`);
      _cachedToken = null;
      _tokenExp = 0;
      return fetchMarcus(url, options, true);
    }
    throw new Error(`Marcus API ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Marcus API ${res.status} for ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return await res.json();
}

function getMarcusCinemasInRange({ originLat, originLng, discoveryRadiusMin, estimatedMinutesAway }) {
  const inRange = [];
  for (const cinema of MARCUS_CINEMAS) {
    const dMin = estimatedMinutesAway(originLat, originLng, cinema.lat, cinema.lng);
    if (dMin <= discoveryRadiusMin) {
      inRange.push({ ...cinema, distanceMin: dMin });
    }
  }
  return inRange;
}

/**
 * Returns showtime entries for nearby cinemas, filtered by movie title and date.
 * Each entry: { cinema, showtimeUUID, sessionid, startTimeRaw, format, filmHOCode, bookingLink }
 */
async function getMarcusShowtimesForCinemas({ cinemas, movieTitle, dateISO }) {
  if (cinemas.length === 0) return [];
  const { matchesMovie } = require("./serpapi");

  const allEntries = [];

  await Promise.all(
    cinemas.map(async (cinema) => {
      let films;
      try {
        films = await fetchMarcus(
          `${API_BASE}/cms/v2/films?cinemaid=${cinema.id}&showdate=${dateISO}`
        );
      } catch (err) {
        console.error(`Marcus [${cinema.name}]: films fetch failed:`, err.message);
        return;
      }

      const matchedFilms = films.filter((f) => matchesMovie(f.title, movieTitle));
      if (matchedFilms.length === 0) return;

      await Promise.all(
        matchedFilms.map(async (film) => {
          let showtimes;
          try {
            showtimes = await fetchMarcus(
              `${API_BASE}/cms/v2/${film.id}/showtimes?showdate=${dateISO}&cinemaid=${cinema.id}`
            );
          } catch (err) {
            console.error(`Marcus [${cinema.name}] showtimes failed:`, err.message);
            return;
          }

          for (const st of showtimes) {
            // Only skip genuinely sold-out sessions. seatsavailable can be 0 for future
            // showings not yet open for booking, so don't filter on that.
            if (st.ticketstatus === "Sold Out") continue;

            // showtime is a local-time ISO string with no TZ offset (e.g. "2026-08-26T14:50:00").
            // Parsing it as UTC and converting would subtract the local offset a second time.
            // Read HH:MM directly from the string instead.
            const startTimeRaw = localIsoToHHMM(st.showtime);
            if (!startTimeRaw) continue;

            const format = marcusDisplayFormat(st.experiences);

            // Booking URL from captured cURL 2026-08-25:
            // https://ticketing.marcustheatres.com/seat/layout?Siteid=2300&FeatureCode=HO00007515&SDate=20260816&STime=1430&Perf=217893
            const sDate = dateISO.replace(/-/g, "");
            const sTime = startTimeRaw.replace(":", "");
            const bookingLink = `https://ticketing.marcustheatres.com/seat/layout?Siteid=${cinema.cinemaid}&FeatureCode=${film.filmid}&SDate=${sDate}&STime=${sTime}&Perf=${st.sessionid}`;

            allEntries.push({
              cinema,
              showtimeUUID: st.id,
              sessionid: st.sessionid,
              startTimeRaw,
              format,
              filmHOCode: film.filmid,
              bookingLink,
            });
          }
        })
      );
    })
  );

  const theaterSummary = cinemas.map((c) => {
    const n = allEntries.filter((e) => e.cinema.id === c.id).length;
    return `${c.name} (${n} session(s))`;
  }).join(", ");
  console.error(`Marcus: fetched ${allEntries.length} session(s) matching "${movieTitle}" on ${dateISO} across ${cinemas.length} cinema(s): ${theaterSummary}`);

  return allEntries;
}

/**
 * Fetch ticket pricing for a showtime.
 * Uses /order/v2/seats?sessionid={uuid} — returns areas with tickettypes.
 * Returns { priceInCents, bookingFeeInCents } from the lowest General/adult price
 * across all areas, or throws if no price found.
 * CONFIRMED LIVE 2026-08-25: General $10.40 + $2.59 fee.
 */
async function getMarcusSessionPrice(showtimeUUID) {
  const data = await fetchMarcus(
    `${API_BASE}/order/v2/seats?sessionid=${showtimeUUID}`
  );
  // data is array of area objects; each has tickettypes array
  const areas = Array.isArray(data) ? data : [];
  let lowestCents = Infinity;
  let lowestFee = 0;
  for (const area of areas) {
    for (const tt of area.tickettypes || []) {
      if (tt.loyaltyredemption) continue;
      const cents = tt.priceincents;
      if (cents != null && cents > 0 && cents < lowestCents) {
        lowestCents = cents;
        lowestFee = Math.round((tt.bookingfee || 0) * 100);
      }
    }
  }
  if (lowestCents === Infinity) throw new Error(`No price found for Marcus session ${showtimeUUID}`);
  return { priceInCents: lowestCents, bookingFeeInCents: lowestFee };
}

function localIsoToHHMM(isoStr) {
  const match = /T(\d{2}):(\d{2})/.exec(isoStr || "");
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

module.exports = {
  MARCUS_CINEMAS,
  getMarcusCinemasInRange,
  getMarcusShowtimesForCinemas,
  getMarcusSessionPrice,
};
