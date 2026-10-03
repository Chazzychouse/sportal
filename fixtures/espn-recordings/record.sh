#!/usr/bin/env bash
# Feed-fidelity spike: record ESPN's public scoreboard and game summaries during live games.
# Throwaway. Usage: record.sh <league-path> <stop-epoch-seconds>
#   league-path: college-football | nfl
# Scoreboard every 30s; summary for up to three live games every 60s.
set -u

league="$1"
stop_at="$2"
base="https://site.api.espn.com/apis/site/v2/sports/football/${league}"
query=""
[ "$league" = "college-football" ] && query="?groups=80&limit=300"

out="$(dirname "$(readlink -f "$0")")/$(date +%F)/${league}"
mkdir -p "$out/scoreboard" "$out/summary"
log="$out/record.log"

fetch() { # url dest
  local code
  code=$(curl -s -m 20 --compressed -o "$2.tmp" -w '%{http_code}' "$1") || code="curl-failed"
  if [ "$code" = "200" ]; then
    gzip -c "$2.tmp" > "$2.gz"
  else
    echo "$(date -u +%FT%TZ) $code $1" >> "$log"
  fi
  rm -f "$2.tmp"
  [ "$code" = "200" ]
}

echo "$(date -u +%FT%TZ) start league=$league stop_at=$stop_at pid=$$" >> "$log"
tick=0
backoff=30
while [ "$(date +%s)" -lt "$stop_at" ]; do
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  if fetch "${base}/scoreboard${query}" "$out/scoreboard/$stamp.json"; then
    backoff=30
    if [ $((tick % 2)) -eq 0 ]; then
      live=$(gzip -dc "$out/scoreboard/$stamp.json.gz" \
        | jq -r '[.events[] | select(.status.type.state == "in") | .id] | sort | .[0:3] | .[]')
      for id in $live; do
        mkdir -p "$out/summary/$id"
        fetch "${base}/summary?event=${id}" "$out/summary/$id/$stamp.json"
      done
    fi
  else
    backoff=$((backoff * 2)); [ "$backoff" -gt 600 ] && backoff=600
  fi
  tick=$((tick + 1))
  sleep "$backoff"
done
echo "$(date -u +%FT%TZ) stop" >> "$log"
