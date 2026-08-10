#!/usr/bin/env bash
# Runs scan.py across every customer- and partner-facing file that was covered
# by the original dead-button audit (see README.md in this folder for context).
# Usage: ./run-full-scan.sh   (run from anywhere; paths are resolved relative to repo root)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

python3 tools/button-audit/scan.py \
  app/account/page.tsx app/assisted-booking/page.tsx app/boarding/page.tsx app/business/page.tsx app/chat/page.tsx \
  app/driver/canonical-driver-page.tsx app/driver/page.tsx app/driver/proof/page.tsx app/driver/recovery/page.tsx \
  app/food/canonical-food-page.tsx app/food/manage/food-customer-incidents.tsx app/food/manage/food-customer-management.tsx app/food/manage/page.tsx app/food/page.tsx app/food/subscription-invoice/page.tsx app/food/subscription-payment/page.tsx app/food/subscriptions/page.tsx \
  app/funeral-memorial/page.tsx app/groomer/page.tsx app/host/boarding-proof-workspace.tsx app/host/page.tsx app/host/proof/page.tsx \
  app/mobile-app/boarding-customer-stay-panel.tsx app/mobile-app/boarding-customer-stay-status.tsx app/mobile-app/coupon-field.tsx app/mobile-app/grooming-flow.tsx app/mobile-app/page.tsx app/mobile-app/provider-tracking-card.tsx app/mobile-app/referral-card.tsx app/mobile-app/stay-flow.tsx app/mobile-app/training-flow.tsx \
  app/page.tsx \
  app/partner-app/canonical-grooming-jobs.tsx app/partner-app/grooming-route-card.tsx app/partner-app/page.tsx app/partner-mobile/page.tsx app/partner/funeral/page.tsx app/partner/onboarding/page.tsx app/partner/page.tsx \
  app/relocation/page.tsx app/sitter/page.tsx app/sitter/proof/page.tsx app/sitter/sitting-workspace.tsx \
  app/sitting/manage/page.tsx app/sitting/manage/sitting-customer-booking.tsx app/sitting/manage/sitting-customer-incidents.tsx app/sitting/page.tsx \
  app/taxi/canonical-taxi-page.tsx app/taxi/manage/page.tsx app/taxi/manage/taxi-customer-incidents.tsx app/taxi/manage/taxi-customer-management.tsx app/taxi/page.tsx \
  app/trainer/page.tsx app/training/page.tsx \
  app/walker/page.tsx app/walker/proof/page.tsx app/walker/recovery/page.tsx \
  app/walking/manage/page.tsx app/walking/manage/walking-customer-incidents.tsx app/walking/manage/walking-customer-management.tsx app/walking/page.tsx

echo "=== Scan complete. No output above other than this line means every file is clean. ==="
