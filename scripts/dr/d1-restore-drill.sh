#!/usr/bin/env bash
set -euo pipefail

DB="${1:-${PAWSPACE_DR_D1_DATABASE:-}}"
RPO_LIMIT_SECONDS="${PAWSPACE_DR_RPO_LIMIT_SECONDS:-60}"
RTO_LIMIT_SECONDS="${PAWSPACE_DR_RTO_LIMIT_SECONDS:-300}"
ORIGINAL_BOOKMARK=""
CLEANUP_REQUIRED=0

log(){ printf '[DR] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die(){ log "FAIL: $*"; exit 1; }
wrangler(){ npx wrangler "$@"; }
sha256(){ shasum -a 256 | awk '{print $1}'; }

[[ -n "$DB" ]] || die "database required: pass name as argv[1] or PAWSPACE_DR_D1_DATABASE"
case "$DB" in
  *prod*|*production*|*live*|*golden*|pawspace-release-preview) die "refusing protected/non-drill target: $DB" ;;
esac
case "$DB" in
  pawspace-dr-drill-*|*[-_]uat[-_]*|*[-_]test[-_]*|*[-_]sandbox[-_]*) ;;
  *) die "target is not explicitly classified as DR/UAT/test/sandbox: $DB" ;;
esac
command -v jq >/dev/null || die "jq is required"
command -v shasum >/dev/null || die "shasum is required"

cleanup_on_error(){
  status=$?
  if [[ $status -ne 0 && "$CLEANUP_REQUIRED" == 1 && -n "$ORIGINAL_BOOKMARK" ]]; then
    log "attempting emergency cleanup to original bookmark"
    wrangler d1 time-travel restore "$DB" --bookmark "$ORIGINAL_BOOKMARK" --json >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_on_error EXIT

log "target=$DB"
ORIGINAL_INFO="$(wrangler d1 time-travel info "$DB" --json)"
ORIGINAL_BOOKMARK="$(jq -er '.bookmark' <<<"$ORIGINAL_INFO")"
CLEANUP_REQUIRED=1
log "original_bookmark=$ORIGINAL_BOOKMARK"

EXISTING="$(wrangler d1 execute "$DB" --remote --command "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='__dr_drill_canary';" --json)"
[[ "$(jq -r '.[0].results[0].n' <<<"$EXISTING")" == 0 ]] || die "__dr_drill_canary already exists; refusing to overwrite"

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TOKEN="dr-$(date -u +%Y%m%dT%H%M%SZ)-$$"
CHECKSUM="$(printf '%s|%s' "$TOKEN" "$STAMP" | sha256)"
WRITE_EPOCH="$(date +%s)"
SQL="CREATE TABLE __dr_drill_canary (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, checksum TEXT NOT NULL); INSERT INTO __dr_drill_canary(id,token,created_at,checksum) VALUES(1,'$TOKEN','$STAMP','$CHECKSUM');"
wrangler d1 execute "$DB" --remote --command "$SQL" --json >/dev/null

BASELINE_RAW="$(wrangler d1 execute "$DB" --remote --command "SELECT id,token,created_at,checksum FROM __dr_drill_canary ORDER BY id;" --json)"
BASELINE="$(jq -cS '.[0].results' <<<"$BASELINE_RAW")"
BASELINE_SHA="$(printf '%s' "$BASELINE" | sha256)"
[[ "$(jq -r '.[0].results | length' <<<"$BASELINE_RAW")" == 1 ]] || die "canary baseline row count is not 1"
[[ "$(jq -r '.[0].results[0].token' <<<"$BASELINE_RAW")" == "$TOKEN" ]] || die "canary token mismatch before corruption"
log "canary_baseline_sha256=$BASELINE_SHA token=$TOKEN"

RECOVERY_INFO="$(wrangler d1 time-travel info "$DB" --json)"
RECOVERY_BOOKMARK="$(jq -er '.bookmark' <<<"$RECOVERY_INFO")"
BOOKMARK_EPOCH="$(date +%s)"
RPO_SECONDS=$((BOOKMARK_EPOCH-WRITE_EPOCH))
log "recovery_bookmark=$RECOVERY_BOOKMARK measured_rpo_seconds=$RPO_SECONDS"
(( RPO_SECONDS < RPO_LIMIT_SECONDS )) || die "RPO ${RPO_SECONDS}s exceeds ${RPO_LIMIT_SECONDS}s"

wrangler d1 execute "$DB" --remote --command "DROP TABLE __dr_drill_canary;" --json >/dev/null
ABSENT="$(wrangler d1 execute "$DB" --remote --command "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='__dr_drill_canary';" --json)"
[[ "$(jq -r '.[0].results[0].n' <<<"$ABSENT")" == 0 ]] || die "catastrophic-drop simulation did not remove canary"
log "catastrophic_drop_confirmed=true"

RESTORE_START="$(date +%s)"
RESTORE_OUTPUT="$(wrangler d1 time-travel restore "$DB" --bookmark "$RECOVERY_BOOKMARK" --json)"
log "restore_result=$(jq -cS '.' <<<"$RESTORE_OUTPUT")"

RECOVERED_RAW="$(wrangler d1 execute "$DB" --remote --command "SELECT id,token,created_at,checksum FROM __dr_drill_canary ORDER BY id;" --json)"
RECOVERED="$(jq -cS '.[0].results' <<<"$RECOVERED_RAW")"
RECOVERED_SHA="$(printf '%s' "$RECOVERED" | sha256)"
RESTORE_END="$(date +%s)"
RTO_SECONDS=$((RESTORE_END-RESTORE_START))
[[ "$RECOVERED" == "$BASELINE" ]] || die "restored canary rowset differs from baseline"
[[ "$RECOVERED_SHA" == "$BASELINE_SHA" ]] || die "restored canary digest differs from baseline"
(( RTO_SECONDS < RTO_LIMIT_SECONDS )) || die "RTO ${RTO_SECONDS}s exceeds ${RTO_LIMIT_SECONDS}s"
log "restored_canary_sha256=$RECOVERED_SHA measured_rto_seconds=$RTO_SECONDS exact_match=true"

log "restoring original pre-drill bookmark for cleanup"
wrangler d1 time-travel restore "$DB" --bookmark "$ORIGINAL_BOOKMARK" --json >/dev/null
CLEAN="$(wrangler d1 execute "$DB" --remote --command "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='__dr_drill_canary';" --json)"
[[ "$(jq -r '.[0].results[0].n' <<<"$CLEAN")" == 0 ]] || die "cleanup did not return database to pre-drill state"
CLEANUP_REQUIRED=0
trap - EXIT

log "cleanup_pre_drill_state=true"
log "DR_DRILL_RESULT=SUCCESS database=$DB rpo_seconds=$RPO_SECONDS rto_seconds=$RTO_SECONDS baseline_sha256=$BASELINE_SHA recovered_sha256=$RECOVERED_SHA"
