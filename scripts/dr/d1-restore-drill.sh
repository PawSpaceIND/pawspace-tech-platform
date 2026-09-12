#!/usr/bin/env bash
set -euo pipefail

DB="${1:-pawspace-staging}"
if [[ "$DB" != "pawspace-staging" ]]; then
  echo "REFUSED: destructive Time Travel drill is allowed only for pawspace-staging (got: $DB)" >&2
  exit 2
fi

WRANGLER=(npx wrangler)
SENTINEL_ID="pre-freeze-dr-sentinel"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BASELINE_PAYLOAD="baseline-${RUN_ID}"
CORRUPTED_PAYLOAD="CORRUPTED-${RUN_ID}"
START_MS="$(node -e 'process.stdout.write(String(Date.now()))')"

query_row() {
  "${WRANGLER[@]}" d1 execute "$DB" --remote --json --command \
    "SELECT id,payload,generation,updated_at FROM dr_restore_drill_sentinel WHERE id='${SENTINEL_ID}'" \
    | node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(0,"utf8"));const row=x?.[0]?.results?.[0]??null;process.stdout.write(JSON.stringify(row));'
}

bookmark() {
  "${WRANGLER[@]}" d1 time-travel info "$DB" --json \
    | node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(0,"utf8"));if(!x.bookmark)process.exit(3);process.stdout.write(String(x.bookmark));'
}

echo "[DR] target database: $DB"
echo "[DR] preparing isolated synthetic sentinel"
"${WRANGLER[@]}" d1 execute "$DB" --remote --yes --command \
  "CREATE TABLE IF NOT EXISTS dr_restore_drill_sentinel (id TEXT PRIMARY KEY,payload TEXT NOT NULL,generation INTEGER NOT NULL,updated_at TEXT NOT NULL); INSERT INTO dr_restore_drill_sentinel (id,payload,generation,updated_at) VALUES ('${SENTINEL_ID}','${BASELINE_PAYLOAD}',1,datetime('now')) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,generation=1,updated_at=excluded.updated_at;" >/dev/null

BEFORE="$(query_row)"
BOOKMARK="$(bookmark)"
if [[ -z "$BOOKMARK" || "$BEFORE" == "null" ]]; then
  echo "FAIL: baseline row or Time Travel bookmark could not be captured" >&2
  exit 1
fi
printf '[DR] bookmark: %s\n' "$BOOKMARK"
printf '[DR] pre-corruption state: %s\n' "$BEFORE"

echo "[DR] injecting synthetic destructive corruption"
"${WRANGLER[@]}" d1 execute "$DB" --remote --yes --command \
  "UPDATE dr_restore_drill_sentinel SET payload='${CORRUPTED_PAYLOAD}',generation=999,updated_at=datetime('now') WHERE id='${SENTINEL_ID}';" >/dev/null
CORRUPTED="$(query_row)"
printf '[DR] corrupted state: %s\n' "$CORRUPTED"
if [[ "$CORRUPTED" == "$BEFORE" || "$CORRUPTED" != *"${CORRUPTED_PAYLOAD}"* ]]; then
  echo "FAIL: synthetic corruption was not observable" >&2
  exit 1
fi

RESTORE_START_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
echo "[DR] restoring in place to captured bookmark"
"${WRANGLER[@]}" d1 time-travel restore "$DB" --bookmark="$BOOKMARK"
RESTORE_END_MS="$(node -e 'process.stdout.write(String(Date.now()))')"

AFTER="$(query_row)"
END_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
printf '[DR] post-restore state: %s\n' "$AFTER"

if [[ "$AFTER" != "$BEFORE" ]]; then
  echo "FAIL: restored state does not exactly match pre-corruption state" >&2
  exit 1
fi

RESTORE_MS=$((RESTORE_END_MS-RESTORE_START_MS))
TOTAL_MS=$((END_MS-START_MS))
printf '[DR] restore duration: %d ms\n' "$RESTORE_MS"
printf '[DR] total drill duration: %d ms\n' "$TOTAL_MS"
if (( RESTORE_MS >= 300000 )); then
  echo "FAIL: RTO objective (<5 minutes) missed" >&2
  exit 1
fi

echo "PASS: D1 Time Travel restored the sentinel exactly to the captured bookmark; synthetic corruption is absent."
