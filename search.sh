#!/bin/bash
# Usage: ./search.sh [deadline] [radiusMin]
# Example: ./search.sh 17:15 15

DEADLINE="${1:-17:15}"
RADIUS="${2:-15}"
MOVIE="Spider-Man: Brand New Day"
LAT="33.8994"
LNG="-117.9063"
LOCATION="Fullerton, CA"

curl -s -G "http://localhost:3000/api/search" \
  --data-urlencode "movie=$MOVIE" \
  --data-urlencode "lat=$LAT" \
  --data-urlencode "lng=$LNG" \
  --data-urlencode "radiusMin=$RADIUS" \
  --data-urlencode "deadline=$DEADLINE" \
  --data-urlencode "location=$LOCATION" \
  --data-urlencode "debug=true" \
  | node -e "process.stdin.resume(); let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => console.log(JSON.stringify(JSON.parse(d), null, 2)));"
