#!/usr/bin/env bash
set -euo pipefail

PORT="${PW_PORT:-4173}"

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
export PAWSPACE_LOCAL_PREVIEW="${PAWSPACE_LOCAL_PREVIEW:-on}"
export PAWSPACE_VOICE_TRANSPORT="${PAWSPACE_VOICE_TRANSPORT:-local_simulator_non_production}"
export PAWSPACE_SCHEDULING_ENV="${PAWSPACE_SCHEDULING_ENV:-uat}"
export PAWSPACE_MEDIA_ENV="${PAWSPACE_MEDIA_ENV:-uat}"
export PAWSPACE_PAYMENT_ENV="sandbox"
export PAWSPACE_PAYMENT_LIVE_APPROVED="false"
export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-.wrangler/e2e.log}"
export MINIFLARE_REGISTRY_PATH="${MINIFLARE_REGISTRY_PATH:-.wrangler/e2e-registry}"

mkdir -p .wrangler
exec npm run dev -- --host 127.0.0.1 --port "$PORT"
