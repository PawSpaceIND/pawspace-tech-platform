#!/usr/bin/env bash
set -euo pipefail

PORT="${PW_PORT:-4173}"
export NODE_ENV="${NODE_ENV:-test}"
export APP_ENV="${APP_ENV:-staging}"
export FORBID_PRODUCTION="${FORBID_PRODUCTION:-true}"
export PAWSPACE_LOCAL_PREVIEW="${PAWSPACE_LOCAL_PREVIEW:-on}"
export PAWSPACE_VOICE_TRANSPORT="${PAWSPACE_VOICE_TRANSPORT:-local_simulator_non_production}"
export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-.wrangler/e2e.log}"
export MINIFLARE_REGISTRY_PATH="${MINIFLARE_REGISTRY_PATH:-.wrangler/e2e-registry}"

mkdir -p .wrangler
exec npm run dev -- --host 127.0.0.1 --port "$PORT"
