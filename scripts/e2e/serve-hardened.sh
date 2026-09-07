#!/usr/bin/env bash
# Boot the BUILT app for browser E2E: vinext build -> wrangler dev --local (Miniflare D1).
#
# Deliberately SEPARATE from scripts/e2e/serve.sh, which runs the vite dev server on :4173 for the
# e2e/*.spec.ts persona journeys. Both are kept - replacing that one would have silently broken those
# journeys, which target a different server and port. Two differences here, both intentional:
#
#   1. It serves the BUILT worker artifact, which is what actually ships, not the dev server.
#
#   2. It declares PAWSPACE_DEPLOYMENT_ENV, switching OFF the development-preview superuser.
#      lib/development-preview.ts grants ["*"] on localhost/127.0.0.1 when PAWSPACE_LOCAL_PREVIEW=on
#      and no deployment env is declared, so a journey served without this cannot be testing
#      authorization at all. e2e/journeys/00-identity.spec.ts fails the whole run if it returns.
# No Cloudflare credentials required.
#
# PAWSPACE_DEPLOYMENT_ENV is set deliberately. lib/development-preview.ts grants superuser ["*"] on
# localhost/127.0.0.1, and its FIRST gate is `if (envValue("PAWSPACE_DEPLOYMENT_ENV")) return false`.
# Declaring a deployment environment therefore switches the preview off and forces the real
# permission model. Without this, every browser journey would pass as a superuser and prove nothing.
set -euo pipefail
PORT="${E2E_PORT:-8788}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PERSIST_DIR="$ROOT/dist/server/.wrangler/state"
cd "$ROOT"

if [ "${E2E_SKIP_BUILD:-}" != "1" ]; then
  echo "[e2e] building..."
  npm run build
fi

mkdir -p "$PERSIST_DIR"
echo "[e2e] starting wrangler dev --local on 127.0.0.1:${PORT} (preview superuser DISABLED)"
exec npx wrangler dev \
  --config dist/server/wrangler.json \
  --local --persist-to "$PERSIST_DIR" --ip 127.0.0.1 --port "$PORT" \
  --var PAWSPACE_DEPLOYMENT_ENV:e2e \
  --var PAWSPACE_LOCAL_PREVIEW:off
