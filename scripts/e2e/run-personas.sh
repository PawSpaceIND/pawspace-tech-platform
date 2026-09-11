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

# The persistent Sitting journey books ahead, then proves provider execution in the same browser case.
# Advance only the server-owned clock into that care window. service-execution-clock.ts independently
# refuses this override unless every isolated test/UAT guard above is present.
export PW_UAT_SERVICE_DATE="$(node -e 'const d=new Date(Date.now()+5*86400000);process.stdout.write(d.toISOString().slice(0,10))')"
export PAWSPACE_UAT_SERVICE_CLOCK="on"
export PAWSPACE_UAT_EXECUTION_NOW_MS="$(node -e 'process.stdout.write(String(Date.parse(process.env.PW_UAT_SERVICE_DATE+"T08:30:00.000Z")))')"

# Vinext/Miniflare reads Cloudflare runtime bindings from .dev.vars. CI creates that file with the
# disposable staff/maps secrets before this runner starts, so upsert only the non-secret service clock.
if [ "${CI:-}" = "true" ]; then
  if [ ! -f "$ROOT/.dev.vars" ]; then
    echo "[persona-e2e] refusing to start: CI must provision .dev.vars before service-clock injection" >&2
    exit 1
  fi
  python3 - "$ROOT/.dev.vars" "$PAWSPACE_UAT_SERVICE_CLOCK" "$PAWSPACE_UAT_EXECUTION_NOW_MS" <<'PYVARS'
import json, sys
from pathlib import Path
path=Path(sys.argv[1])
updates={"PAWSPACE_UAT_SERVICE_CLOCK":sys.argv[2],"PAWSPACE_UAT_EXECUTION_NOW_MS":sys.argv[3]}
lines=path.read_text().splitlines()
lines=[line for line in lines if not any(line.startswith(key+"=") for key in updates)]
lines.extend(f"{key}={json.dumps(value)}" for key,value in updates.items())
path.write_text("\n".join(lines)+"\n")
PYVARS
fi

seed_persona_db() {
  # Each viewport gets a fresh disposable D1 so persisted reservations from desktop cannot influence mobile.
  # --local and the explicit project-local state path prevent any remote database writes.
  rm -rf "$ROOT/.wrangler/state"
  npx wrangler d1 execute site-creator-d1 --local \
    --config scripts/e2e/persona-local-db.jsonc --persist-to "$ROOT/.wrangler/state" \
    --file scripts/e2e/persona-provider-home-base.sql
}

# Vite lane: real sandbox customer/provider OTP plus fault injection. Run the two viewports independently
# so their state is isolated while both exercise the same governed service-time boundary.
for project in chromium mobile-chromium; do
  seed_persona_db
  npx playwright test \
    e2e/customer-booking.spec.ts \
    e2e/partner-journey.spec.ts \
    e2e/frontend-resilience.spec.ts \
    --project="$project" \
    --retries=0
done

# Seeded built-worker journeys are deliberately certified by the independent required Browser E2E
# hardened workflow. Keeping that gate separate avoids running the same Wrangler/Miniflare journey
# twice while preserving both mandatory exact-head certifications.
