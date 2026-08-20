#!/bin/bash
set -e

cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

export SERPAPI_KEY="adf77c3ac596f810ae22d46112a070ead55fc9e69ebca917c4425b31a81071b5"
export SCRAPEDO_TOKEN="5ff5153c56584b52aae33909bfce67c59853557598c"
# Optional second provider for Regal pricing -- if set, Regal calls
# automatically fall over to ZenRows once Scrape.do's quota is
# exhausted, instead of failing outright.
export ZENROWS_API_KEY="8c605296e5e2f2171e723f4f9f6a08ea672d5151"
export AMC_VENDOR_KEY="D38E958C-C232-45AD-AE17-BB240A852C03"
export DISABLE_REGAL_PRICING="false"  # set to "true" to pause Regal/Scrape.do pricing again
export DISABLE_CINEMARK_PRICING="false"  # set to "true" to pause Cinemark direct pricing
# Cinema West (Country Club Cinema) fetches its own access token live --
# no manual setup needed here anymore.
# Uncomment and set a real password before exposing this beyond localhost
# (e.g. via a Cloudflare Tunnel) to share with friends. Leave commented
# out for normal local-only use -- no login prompt when unset.
# export APP_PASSWORD="pick-something-only-your-friends-know"

echo "Starting Showtime Finder on http://localhost:3000"
node server.js
