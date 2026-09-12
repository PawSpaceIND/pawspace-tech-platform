#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${PAWSPACE_EDGE_TEST_BASE_URL:-https://pawspace-staging.karthik-fce.workers.dev}"
AUTH_PATH="${PAWSPACE_EDGE_AUTH_PATH:-/api/customer-otp}"
BURST_COUNT="${PAWSPACE_EDGE_BURST_COUNT:-8}"
CURL_TIMEOUT="${PAWSPACE_EDGE_CURL_TIMEOUT:-10}"

log(){ printf '[EDGE] %s\n' "$*"; }
fail(){ printf '[EDGE][FAIL] %s\n' "$*" >&2; exit 1; }
request_code(){
  local url="$1"
  curl -sS -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$url"
}

case "$BASE_URL" in
  http://127.0.0.1*|http://localhost*)
    fail "local Miniflare/Wrangler cannot prove Cloudflare zone WAF pre-Worker blocking"
    ;;
esac

log "target=$BASE_URL"
SQLI_CODE="$(request_code "$BASE_URL/?q=%27%20OR%201%3D1--")"
XSS_CODE="$(request_code "$BASE_URL/?q=%3Cscript%3Ealert%281%29%3C%2Fscript%3E")"
log "sqli_http=$SQLI_CODE expected=403"
log "xss_http=$XSS_CODE expected=403"
FAILURES=0
if [[ "$SQLI_CODE" != "403" ]]; then log "FAIL sqli_not_blocked=true"; FAILURES=$((FAILURES+1)); fi
if [[ "$XSS_CODE" != "403" ]]; then log "FAIL xss_not_blocked=true"; FAILURES=$((FAILURES+1)); fi

RATE_LIMITED=0
CODES=""
for _ in $(seq 1 "$BURST_COUNT"); do
  code="$(request_code "$BASE_URL$AUTH_PATH")"
  CODES="${CODES}${code} "
  if [[ "$code" == "429" ]]; then RATE_LIMITED=1; fi
done
log "auth_burst_codes=${CODES% }"
if [[ "$RATE_LIMITED" != "1" ]]; then log "FAIL auth_rate_limit_missing=true"; FAILURES=$((FAILURES+1)); fi

if (( FAILURES > 0 )); then
  fail "EDGE_SECURITY_RESULT=FAIL failures=$FAILURES"
fi
log "EDGE_SECURITY_RESULT=SUCCESS waf=403 rate_limit=429"
log "NOTE status-code proof alone does not prove zero Worker CPU/D1; pair with Cloudflare Security Events or Worker tail absence for pre-Worker certification"
