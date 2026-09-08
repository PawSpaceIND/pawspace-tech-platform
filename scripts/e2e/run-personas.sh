#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# This runner is the one supported entrypoint for persona/resilience certification. The values are intentionally
# hard-pinned, not inherited, so a caller cannot turn a browser test into a live-money exercise.
export PAWSPACE_PAYMENT_ENV="sandbox"
export PAWSPACE_PAYMENT_LIVE_APPROVED="false"
export NODE_ENV="test"
export APP_ENV="staging"
export FORBID_PRODUCTION="true"
export PAWSPACE_DEPLOYMENT_ENV="e2e"
export PAWSPACE_LOCAL_PREVIEW="on"
export PAWSPACE_VOICE_TRANSPORT="local_simulator_non_production"
export PAWSPACE_SCHEDULING_ENV="uat"
export PAWSPACE_MEDIA_ENV="uat"

# Vite lane: real sandbox customer/provider OTP plus fault injection. Declaring PAWSPACE_DEPLOYMENT_ENV
# keeps OTP sandbox enabled but disables the localhost wildcard preview actor.
npx playwright test \
  e2e/customer-booking.spec.ts \
  e2e/partner-journey.spec.ts \
  e2e/frontend-resilience.spec.ts \
  e2e/mobile-internal-wiring.spec.ts \
  --project=chromium \
  --project=mobile-chromium

# Seeded built-worker journeys are deliberately certified by the independent required Browser E2E
# hardened workflow. Keeping that gate separate avoids running the same Wrangler/Miniflare journey
# twice while preserving both mandatory exact-head certifications.
