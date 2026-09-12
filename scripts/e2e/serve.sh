#!/usr/bin/env bash
set -euo pipefail

PORT="${PW_PORT:-4185}"

DEV_VARS="$PWD/.dev.vars"

# Persona E2E is a non-production harness. Refuse an inherited live-money posture before rewriting
# anything so a dangerous caller configuration is visible and the server can never start ambiguously.
if [ "${PAWSPACE_PAYMENT_ENV:-sandbox}" != "sandbox" ]; then
  echo "[persona-e2e] refusing to start: PAWSPACE_PAYMENT_ENV must be sandbox" >&2
  exit 1
fi
if [ "${PAWSPACE_PAYMENT_LIVE_APPROVED:-false}" != "false" ]; then
  echo "[persona-e2e] refusing to start: PAWSPACE_PAYMENT_LIVE_APPROVED must be false" >&2
  exit 1
fi

export NODE_ENV="${NODE_ENV:-test}"
export APP_ENV="${APP_ENV:-staging}"
export FORBID_PRODUCTION="${FORBID_PRODUCTION:-true}"
export PAWSPACE_DEPLOYMENT_ENV="e2e"
export PAWSPACE_LOCAL_PREVIEW="off"
export PAWSPACE_VOICE_TRANSPORT="${PAWSPACE_VOICE_TRANSPORT:-local_simulator_non_production}"
export PAWSPACE_SCHEDULING_ENV="${PAWSPACE_SCHEDULING_ENV:-uat}"
export PAWSPACE_MEDIA_ENV="${PAWSPACE_MEDIA_ENV:-uat}"
export PAWSPACE_PAYMENT_ENV="sandbox"
export PAWSPACE_PAYMENT_LIVE_APPROVED="false"
export PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE="on"
export PAWSPACE_MAPS_ENV="sandbox"
export PAWSPACE_UAT_LOGIN="on"
export PAWSPACE_UAT_ACCESS_CODE="${PAWSPACE_UAT_ACCESS_CODE:-${PW_STAFF_UAT_ACCESS_CODE:-pawspace-e2e-access-only}}"
export PAWSPACE_UAT_SIGNING_KEY="${PAWSPACE_UAT_SIGNING_KEY:-pawspace-e2e-signing-key-local-only-20260911}"
export PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT="$PAWSPACE_UAT_SIGNING_KEY"
export PAWSPACE_IDENTITY_ENV="sandbox"
export PAWSPACE_WORKSPACE_IDENTITY_TRUST="openai-dispatch"
export PW_STAFF_UAT_ACCESS_CODE="$PAWSPACE_UAT_ACCESS_CODE"

export PW_UAT_SERVICE_DATE="${PW_UAT_SERVICE_DATE:-$(date -u -v+5d +%Y-%m-%d)}"
export PAWSPACE_UAT_SERVICE_CLOCK="on"
export PAWSPACE_UAT_EXECUTION_NOW_MS="${PAWSPACE_UAT_EXECUTION_NOW_MS:-$(node -e 'console.log(Date.parse(process.argv[1]+"T08:30:00.000Z"))' "$PW_UAT_SERVICE_DATE")}"
cat > "$DEV_VARS" <<EOF_VARS
PAWSPACE_UAT_LOGIN="on"
PAWSPACE_UAT_ACCESS_CODE="$PAWSPACE_UAT_ACCESS_CODE"
PAWSPACE_UAT_SIGNING_KEY="$PAWSPACE_UAT_SIGNING_KEY"
PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT="$PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT"
PAWSPACE_IDENTITY_ENV="$PAWSPACE_IDENTITY_ENV"
PAWSPACE_PAYMENT_ENV="sandbox"
PAWSPACE_PAYMENT_LIVE_APPROVED="false"
PAWSPACE_SCHEDULING_ENV="uat"
PAWSPACE_MEDIA_ENV="uat"
PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE="on"
PAWSPACE_UAT_SERVICE_CLOCK="$PAWSPACE_UAT_SERVICE_CLOCK"
PAWSPACE_UAT_EXECUTION_NOW_MS="$PAWSPACE_UAT_EXECUTION_NOW_MS"
EOF_VARS

export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-.wrangler/e2e.log}"
export MINIFLARE_REGISTRY_PATH="${MINIFLARE_REGISTRY_PATH:-.wrangler/e2e-registry}"

mkdir -p .wrangler
rm -rf .wrangler/state
npx wrangler d1 execute site-creator-d1 --local --config scripts/e2e/persona-local-db.jsonc --persist-to "$PWD/.wrangler/state" --file scripts/e2e/persona-provider-home-base.sql >/dev/null
node --experimental-strip-types scripts/e2e/seed-identities.mjs >/dev/null
exec npm run dev -- --host 127.0.0.1 --port "$PORT"
