#!/usr/bin/env bash
# Boot the built app locally for browser E2E: vinext build -> wrangler dev --local (Miniflare D1).
# No Cloudflare credentials required.
#
# PAWSPACE_DEPLOYMENT_ENV is set deliberately. lib/development-preview.ts grants superuser ["*"] on
# localhost/127.0.0.1, and its FIRST gate is `if (envValue("PAWSPACE_DEPLOYMENT_ENV")) return false`.
# Declaring a deployment environment therefore switches the preview off and forces the real
# permission model. Without this, every browser journey would pass as a superuser and prove nothing.
set -euo pipefail
PORT="${E2E_PORT:-8788}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ "${E2E_SKIP_BUILD:-}" != "1" ]; then
  echo "[e2e] building..."
  npm run build
fi

echo "[e2e] starting wrangler dev --local on 127.0.0.1:${PORT} (preview superuser DISABLED)"
exec npx wrangler dev \
  --config dist/server/wrangler.json \
  --local --ip 127.0.0.1 --port "$PORT" \
  --var PAWSPACE_DEPLOYMENT_ENV:e2e \
  --var PAWSPACE_LOCAL_PREVIEW:off
