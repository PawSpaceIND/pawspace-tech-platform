#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export E2E_PORT="${E2E_PORT:-8788}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://127.0.0.1:${E2E_PORT}}"
export PAWSPACE_PAYMENT_ENV="sandbox"
export PAWSPACE_PAYMENT_LIVE_APPROVED="false"
export SERVE_LOG="${SERVE_LOG:-/tmp/serve.log}"
export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-/tmp/wrangler-e2e.log}"
PID_FILE="${E2E_PID_FILE:-/tmp/e2e-server.pid}"

log_tail() {
  echo "--- server log ---" >&2
  tail -120 "$SERVE_LOG" 2>/dev/null || true
  echo "--- wrangler log ---" >&2
  tail -120 "$WRANGLER_LOG_PATH" 2>/dev/null || true
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

  echo "[e2e] server did not release ${E2E_BASE_URL}" >&2
  log_tail
  return 1
}

start_server() {
  stop_server || true
  if ! port_closed; then
    echo "[e2e] refusing to start: ${E2E_BASE_URL} is already occupied" >&2
    log_tail
    return 1
  fi

  local pid
  if command -v setsid >/dev/null 2>&1; then
    setsid env E2E_SKIP_BUILD=1 bash scripts/e2e/serve-hardened.sh >> "$SERVE_LOG" 2>&1 &
    pid=$!
  else
    # macOS does not ship setsid. Node's detached mode creates a new POSIX session/process group,
    # preserving the negative-PID group cleanup semantics used by stop_server.
    pid="$(SERVE_LOG="$SERVE_LOG" node <<'NODE'
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const logFd = fs.openSync(process.env.SERVE_LOG, "a");
const child = spawn("bash", ["scripts/e2e/serve-hardened.sh"], {
  cwd: process.cwd(),
  detached: true,
  env: { ...process.env, E2E_SKIP_BUILD: "1" },
  stdio: ["ignore", logFd, logFd],
});
fs.closeSync(logFd);

if (!child.pid) {
  process.exit(1);
}

child.unref();
process.stdout.write(String(child.pid));
NODE
)"
  fi
  echo "$pid" > "$PID_FILE"

  for _ in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[e2e] server exited before becoming ready" >&2
      log_tail
      return 1
    fi
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$E2E_BASE_URL/" || true)"
    if [ "$code" != "000" ]; then
      echo "[e2e] app up (HTTP $code)"
      return 0
    fi
    sleep 2
  done

  echo "[e2e] app did not become ready" >&2
  log_tail
  return 1
}

trap 'stop_server || true' EXIT INT TERM

: > "$SERVE_LOG"
: > "$WRANGLER_LOG_PATH"

if [ "${E2E_SKIP_BUILD:-}" != "1" ]; then
  npm run build
fi

# Materialize app_users, then seed only while Miniflare is fully stopped. Direct SQLite writes while
# Wrangler owns the D1 backing file can terminate the local server and create a misleading E2E crash.
start_server
curl -s -o /dev/null -H "oai-authenticated-user-email: e2e.admin@pawspace.test" \
  "$E2E_BASE_URL/api/canonical-bookings?customerId=E2E-CUS-UI-001" || true
stop_server
node scripts/e2e/seed-identities.mjs

# Warm lazy canonical tables using the seeded admin, then stop before the second offline seed pass.
start_server
for path in "/api/canonical-bookings?customerId=E2E-CUS-UI-001" \
            "/api/partner-job-feed?providerId=E2E-PRV-UI-001" \
            "/api/booking-command-center"; do
  curl -fsS -o /dev/null -H "oai-authenticated-user-email: e2e.admin@pawspace.test" \
    "$E2E_BASE_URL$path" || true
done
stop_server
node scripts/e2e/seed-identities.mjs

# Wrangler/workerd can lose its local proxy connection after repeated Playwright browser-project
# contexts even when the route itself correctly returns a governed response. Keep the same persisted
# Miniflare D1 state, but give every journey/project pair a fresh built-worker process. This is not a
# retry and does not weaken any assertion: each Desktop Chrome and Pixel 7 execution still runs once.
journeys=(
  e2e/journeys/00-identity.spec.ts
  e2e/journeys/01-customer.spec.ts
  e2e/journeys/02-partner.spec.ts
  e2e/journeys/03-admin.spec.ts
  e2e/journeys/04-multi-actor.spec.ts
)
projects=(chromium mobile-chromium)

for journey in "${journeys[@]}"; do
  for project in "${projects[@]}"; do
    echo "[e2e] running ${journey} (${project}) with a fresh built-worker server"
    start_server
    if ! npx playwright test --config playwright.e2e.config.ts --project="$project" --output="test-results/$(basename "$journey" .spec.ts)/$project" "$journey"; then
      echo "[e2e] journey failed: ${journey} (${project})" >&2
      log_tail
      stop_server || true
      exit 1
    fi
    stop_server
  done
done

# The CX communication-visibility proof owns its own isolated SQLite/D1 harness and browser server.
# Keep Wrangler stopped so the proof can run independently and reproduce the exact terminal command
# used during local development.
echo "[e2e] running Razorpay capture -> Meta 503 -> CX visibility proof"
stop_server
npx playwright test --config playwright.cx-visibility.config.ts tests/e2e/09-webhook-flood-cx-visibility.spec.ts
