#!/usr/bin/env bash
# One-shot loader for a fully testable staging database.
#
# Run this from the repo root by whoever has Cloudflare access to the pawspace-staging worker + D1.
# It loads the three seed layers (customers/bookings, employees/HR, module demo data) plus the
# full-access founder login, in order. Every file is idempotent (INSERT OR IGNORE), so re-running is safe.
#
#   ./scripts/load-staging-seeds.sh
#
# Requires: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment (same as any wrangler deploy).
set -euo pipefail

DB="${STAGING_D1_NAME:-pawspace-staging}"
cd "$(dirname "$0")/.."

for file in staging-seed.sql employee-seed.sql uat-demo-seed.sql staging-founder-login.sql staging-payment-reconciliation.sql; do
  echo "==> loading scripts/${file}"
  npx wrangler d1 execute "$DB" --remote --file="scripts/${file}"
done

cat <<'DONE'

Seeds loaded.

Next:
  1. Make sure staging is running the latest build of branch claude/pawspace-testing-setup-hw4glk
     (redeploy if it isn't — otherwise the app fixes are not live).
  2. Open https://<staging-host>/staging-login and sign in with the UAT access code as:
        founder@pawspace.in    (full access — opens every module)
     Or, to test a specific role boundary, use a seeded role login from docs/UAT-TESTER-GUIDE.md
     (manager: jyoti.manager39@tkpetcare.in, finance: anjali.finance33@tkpetcare.in, etc.).
DONE
