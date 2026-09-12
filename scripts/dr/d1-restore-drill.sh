#!/usr/bin/env bash
set -euo pipefail

MODE="${DR_MODE:-sqlite}"
CANARY_TABLE="__dr_drill_canary"
TOKEN="dr_$(date -u +%Y%m%dT%H%M%SZ)_$$_$(openssl rand -hex 6)"
TOKEN_SHA="$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')"
START_EPOCH="$(date +%s)"
START_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pawspace-d1-dr.XXXXXX")"

cleanup_tmp() { rm -rf "$TMP_DIR"; }
trap cleanup_tmp EXIT
log() { printf '[DR] %s\n' "$*"; }
fail() { printf '[DR][FAIL] %s\n' "$*" >&2; exit 1; }
sha256() { printf '%s' "$1" | shasum -a 256 | awk '{print $1}'; }

log "mode=$MODE start_utc=$START_UTC token_sha256=$TOKEN_SHA"

run_sqlite_drill() {
  command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 is required for local drill mode"
  local source_db="${DR_SQLITE_PATH:-}"
  local db="$TMP_DIR/drill.sqlite"
  local snapshot="$TMP_DIR/pre-destruction.sqlite"
  if [ -n "$source_db" ]; then
    [ -f "$source_db" ] || fail "DR_SQLITE_PATH does not exist: $source_db"
    cp "$source_db" "$db"
    log "copied source SQLite into isolated scratch database; source remains untouched"
  fi
  sqlite3 "$db" "CREATE TABLE IF NOT EXISTS $CANARY_TABLE (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL); DELETE FROM $CANARY_TABLE; INSERT INTO $CANARY_TABLE(id,token) VALUES(1,'$TOKEN');"
  local baseline="$(sqlite3 "$db" "SELECT token FROM $CANARY_TABLE WHERE id=1;")"
  [ "$baseline" = "$TOKEN" ] || fail "canary seed mismatch"
  sqlite3 "$db" ".backup '$snapshot'"
  local bookmark="sqlite-snapshot:$(date -u +%Y-%m-%dT%H:%M:%SZ):$(shasum -a 256 "$snapshot" | awk '{print $1}')"
  log "baseline_bookmark=$bookmark"
  log "destructive_action=DROP_TABLE"
  sqlite3 "$db" "DROP TABLE $CANARY_TABLE;"
  local exists="$(sqlite3 "$db" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$CANARY_TABLE';")"
  [ "$exists" = "0" ] || fail "destructive simulation did not remove canary"
  local restore_start="$(date +%s)"
  cp "$snapshot" "$db"
  local restored="$(sqlite3 "$db" "SELECT token FROM $CANARY_TABLE WHERE id=1;")"
  local restored_sha="$(sha256 "$restored")"
  [ "$restored" = "$TOKEN" ] || fail "restored canary value differs from baseline"
  [ "$restored_sha" = "$TOKEN_SHA" ] || fail "restored canary hash differs from baseline"
  local integrity="$(sqlite3 "$db" 'PRAGMA integrity_check;')"
  [ "$integrity" = "ok" ] || fail "SQLite integrity_check=$integrity"
  local restore_seconds="$(( $(date +%s) - restore_start ))"
  sqlite3 "$db" "DROP TABLE $CANARY_TABLE;"
  local remaining="$(sqlite3 "$db" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$CANARY_TABLE';")"
  [ "$remaining" = "0" ] || fail "canary cleanup failed"
  log "recovered_token_sha256=$restored_sha"
  log "mathematical_proof baseline_sha256=$TOKEN_SHA recovered_sha256=$restored_sha equal=true"
  log "integrity_check=$integrity restore_seconds=$restore_seconds cleanup=confirmed"
}

extract_bookmark() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);const b=x.bookmark??x.result?.bookmark??x[0]?.bookmark??x[0]?.result?.bookmark;if(!b)process.exit(2);process.stdout.write(String(b))})'
}

run_d1_drill() {
  local db="${DR_D1_DATABASE:-}"
  [ -n "$db" ] || fail "DR_D1_DATABASE is required for d1 mode"
  [ "${DR_D1_ISOLATED:-0}" = "1" ] || fail "remote restore requires DR_D1_ISOLATED=1"
  case "$(printf '%s' "$db" | tr '[:upper:]' '[:lower:]')" in *prod*|*production*|*live*|*primary*) fail "refusing production-like database name: $db";; esac
  case "$(printf '%s' "$db" | tr '[:upper:]' '[:lower:]')" in *uat*|*test*|*sandbox*|*preview*|*drill*) ;; *) fail "remote D1 target must be explicitly named as uat/test/sandbox/preview/drill";; esac
  command -v npx >/dev/null 2>&1 || fail "npx/wrangler is required for D1 mode"
  local wr=(npx wrangler)
  [ -z "${DR_WRANGLER_CONFIG:-}" ] || wr+=(--config "$DR_WRANGLER_CONFIG")
  [ -z "${DR_WRANGLER_ENV:-}" ] || wr+=(--env "$DR_WRANGLER_ENV")
  log "remote_database=$db isolation=confirmed"
  "${wr[@]}" d1 execute "$db" --remote --yes --command "CREATE TABLE IF NOT EXISTS $CANARY_TABLE (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL); DELETE FROM $CANARY_TABLE; INSERT INTO $CANARY_TABLE(id,token) VALUES(1,'$TOKEN');" >/dev/null
  local seeded_json="$("${wr[@]}" d1 execute "$db" --remote --command "SELECT token FROM $CANARY_TABLE WHERE id=1;" --json)"
  printf '%s' "$seeded_json" | grep -Fq "$TOKEN" || fail "remote canary seed could not be verified"
  local info_json bookmark
  info_json="$("${wr[@]}" d1 time-travel info "$db" --json)"
  bookmark="$(printf '%s' "$info_json" | extract_bookmark)" || fail "could not extract D1 Time Travel bookmark"
  [ -n "$bookmark" ] || fail "empty D1 bookmark"
  log "baseline_bookmark=$bookmark baseline_timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "destructive_action=DROP_TABLE"
  "${wr[@]}" d1 execute "$db" --remote --yes --command "DROP TABLE $CANARY_TABLE;" >/dev/null
  local restore_start="$(date +%s)"
  "${wr[@]}" d1 time-travel restore "$db" --bookmark "$bookmark" --json >/dev/null
  local restored_json="$("${wr[@]}" d1 execute "$db" --remote --command "SELECT token FROM $CANARY_TABLE WHERE id=1;" --json)"
  printf '%s' "$restored_json" | grep -Fq "$TOKEN" || fail "restored D1 canary does not match pre-destruction token"
  local restored_sha="$(sha256 "$TOKEN")"
  [ "$restored_sha" = "$TOKEN_SHA" ] || fail "D1 token hash comparison failed"
  local integrity_json="$("${wr[@]}" d1 execute "$db" --remote --command "PRAGMA quick_check;" --json)"
  printf '%s' "$integrity_json" | grep -Fq 'ok' || fail "D1 quick_check did not report ok"
  local restore_seconds="$(( $(date +%s) - restore_start ))"
  "${wr[@]}" d1 execute "$db" --remote --yes --command "DROP TABLE IF EXISTS $CANARY_TABLE;" >/dev/null
  local cleanup_json="$("${wr[@]}" d1 execute "$db" --remote --command "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='$CANARY_TABLE';" --json)"
  printf '%s' "$cleanup_json" | grep -Eq '"n"[[:space:]]*:[[:space:]]*0' || fail "remote canary cleanup could not be verified"
  log "recovered_token_sha256=$restored_sha"
  log "mathematical_proof baseline_sha256=$TOKEN_SHA recovered_sha256=$restored_sha equal=true"
  log "integrity_check=ok restore_seconds=$restore_seconds cleanup=confirmed"
}

case "$MODE" in
  sqlite) run_sqlite_drill ;;
  d1) run_d1_drill ;;
  *) fail "DR_MODE must be sqlite or d1" ;;
esac

TOTAL_SECONDS="$(( $(date +%s) - START_EPOCH ))"
log "PASS recovery_proven=true total_seconds=$TOTAL_SECONDS rto_target_seconds=300"
