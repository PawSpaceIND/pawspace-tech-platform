# PR #428 reconciliation record

PR #428 (`fix/payments-financial-hardening-20260902`) was reconciled against `main` at `101e64b4b86788b3496882c6706feeb8a409fe2a`.

## Production behavior preserved from main

The reconciled branch intentionally keeps current main unchanged for payment production behavior:

- the canonical payment-environment parser accepts only exact `sandbox` or `live` declarations and fails closed on missing, empty, malformed, aliased, or case-shifted values;
- live Razorpay order creation requires `PAWSPACE_PAYMENT_LIVE_APPROVED === "true"` before `/v1/orders` egress;
- scheduled Razorpay order-outbox draining uses the canonical `runRazorpayOrderOutboxSweep` path;
- existing mainline temporary transpilation fixes and grooming fixture schema-governance repairs remain authoritative.

No stale production hunk from the historical PR branch is replayed when it duplicates or weakens those semantics.

## CI baseline dependency

Release CI remains dependent on the inherited Web-test baseline tracked on `fix/inherited-test-debt-baseline` and `docs/INHERITED_TEST_DEBT_TRIAGE.md`. The measured baseline at `101e64b4` is 4033 tests, 3975 passing, 58 failing across 19 suites.

PR #428 must not be merged until the hook-path and Web suites are fully green.

## Production sign-off hold

Issue #443 tracks the administrator-only production secret/variable provisioning gap. PR #428 must not be squash-merged and the final production readiness audit must not be executed as release certification until that issue is resolved and the required deployment-registry values are provisioned.
