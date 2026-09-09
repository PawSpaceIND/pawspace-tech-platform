#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export E2E_PORT="${E2E_PORT:-8788}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://127.0.0.1:${E2E_PORT}}"
export PAWSPACE_PAYMENT_ENV="sandbox"
export PAWSPACE_PAYMENT_LIVE_APPROVED="false"
export FORBID_PRODUCTION="true"
export SERVE_LOG="${SERVE_LOG:-/tmp/finance-closure-serve.log}"
export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-/tmp/wrangler-e2e.log}"
PID_FILE="${E2E_PID_FILE:-/tmp/finance-closure-server.pid}"

log_tail() {
  echo "--- server log ---" >&2
  tail -160 "$SERVE_LOG" 2>/dev/null || true
  echo "--- wrangler log ---" >&2
  tail -160 "$WRANGLER_LOG_PATH" 2>/dev/null || true
}

port_closed() {
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 1 "$E2E_BASE_URL/" || true)"
  [ "$code" = "000" ]
}

stop_server() {
  [ -f "$PID_FILE" ] || return 0
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  rm -f "$PID_FILE"
  [ -n "$pid" ] || return 0
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    port_closed && return 0
    sleep 1
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    port_closed && return 0
    sleep 1
  done
  echo "[finance-closure] server did not release ${E2E_BASE_URL}" >&2
  log_tail
  return 1
}

start_server() {
  stop_server || true
  if ! port_closed; then
    echo "[finance-closure] refusing to start: ${E2E_BASE_URL} is occupied" >&2
    log_tail
    return 1
  fi
  local pid
  pid="$(node scripts/e2e/start-server.mjs "$SERVE_LOG")"
  echo "$pid" > "$PID_FILE"
  for _ in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[finance-closure] server exited before readiness" >&2
      log_tail
      return 1
    fi
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$E2E_BASE_URL/" || true)"
    if [ "$code" != "000" ]; then
      echo "[finance-closure] app up (HTTP $code)"
      return 0
    fi
    sleep 2
  done
  echo "[finance-closure] app did not become ready" >&2
  log_tail
  return 1
}

trap 'stop_server || true' EXIT INT TERM
: > "$SERVE_LOG"
: > "$WRANGLER_LOG_PATH"

# Match the repository's hardened E2E bootstrap exactly: materialize D1 first, seed only while the
# local worker is stopped, warm lazy tables, stop again, then perform the final governed identity seed.
start_server
curl -s -o /dev/null -H "oai-authenticated-user-email: e2e.admin@pawspace.test" \
  "$E2E_BASE_URL/api/canonical-bookings?customerId=E2E-CUS-UI-001" || true
stop_server
node scripts/e2e/seed-identities.mjs | tee remote-finance-seed-pass1.log

start_server
for path in "/api/canonical-bookings?customerId=E2E-CUS-UI-001" \
            "/api/partner-job-feed?providerId=E2E-PRV-UI-001" \
            "/api/booking-command-center"; do
  curl -fsS -o /dev/null -H "oai-authenticated-user-email: e2e.admin@pawspace.test" \
    "$E2E_BASE_URL$path" || true
done
stop_server
node scripts/e2e/seed-identities.mjs | tee remote-finance-seed-pass2.log

start_server
npx playwright test --config playwright.e2e.config.ts --project=chromium \
  e2e/journeys/08-http-cancellation-demo.spec.ts 2>&1 | tee remote-finance-playwright.log
stop_server

echo "FINANCE_CLOSURE_E2E=PASS"
