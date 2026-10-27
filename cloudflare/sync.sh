#!/usr/bin/env bash
# POST /admin/sync until the D1 backlog is clear.
set -euo pipefail

url="${SYNC_URL:-https://daily.natlada.com/admin/sync}"
if [ -z "${SYNC_TOKEN:-}" ]; then
  echo "SYNC_TOKEN is not set" >&2
  exit 1
fi

for attempt in 1 2 3 4 5 6 7 8; do
  if body=$(curl -fsS -X POST "$url" \
      -H "Authorization: Bearer ${SYNC_TOKEN}" \
      -H "Accept: application/json"); then
    printf '%s\n' "$body"
    if remaining=$(node -e 'const j=JSON.parse(process.argv[1]); if(!j.ok){console.error(j.error||"sync not ok"); process.exit(2)} process.stdout.write(String(j.remaining??0))' "$body"); then
      if [ "$remaining" = "0" ]; then
        exit 0
      fi
      echo "remaining ${remaining}, continuing" >&2
    fi
  else
    echo "sync request failed (attempt ${attempt})" >&2
  fi
  sleep 10
done

echo "ingest did not finish" >&2
exit 1
