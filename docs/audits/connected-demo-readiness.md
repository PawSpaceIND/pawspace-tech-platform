# Connected demo readiness audit — 9 September 2026

**Target: 95% human-test readiness. Not certified.** All activity used synthetic local data and sandbox financial events. Nothing was deployed, merged, or paid out. The full requested journey is not yet closed.

## Candidate and defects repaired

Baseline: upstream `ccfe2ee5`, with sandbox-boundary commit `cc36bf3e`. This follow-up repairs:

1. CX rendered a recovery screen with HTTP 200. Its keyed client template also remounted the page on stream updates. The template now passes through its children; deduplicated SSE updates refresh data inside the page, preserving search and draft state. Render checks now reject the HTTP-200 recovery screen.
2. The API gateway rejected a customer's own order notifications. GET/POST are mapped to the customer booking permission; the handler still enforces ownership. Owner, stranger and anonymous requests are exercised through the actual gateway.
3. Notification delivery status stayed at the enqueue snapshot after dispatch failure. Reads now join the canonical message/outbox state, so DLQ errors are visible without changing in-app read/unread state.
4. Subscription cron reconciled plans before creating its billing/governance schema. Initialization now precedes reconciliation, including on a fresh database.
5. The global blocklist trigger used multiline D1 `exec`, which failed with `incomplete input` although ordinary SQLite accepted it. The trigger uses one prepared statement. Tests verify both trigger installation and rejection of blocked bookings.

The local harness also passes `FORBID_PRODUCTION=true` into Worker bindings, preserves an optional D1 state directory across builds, and supports an API/cron probe mode without the local assets router.

## Actual connected demo evidence

Two grooming bookings were completed through HTTP against the built Worker and persisted local D1:

- `PS-UAT-MTSZLW1H-D43A`: ₹1,899 sandbox payment.
- `PS-UAT-MTSZXO5Z-66EF`: ₹1,899 sandbox payment; two simultaneous booking submissions returned the same booking ID with duplicate prevention.

The correlated flow covers a seeded customer/pet → reservation → canonical booking → governed service location → synthetic payment capture → provider acceptance → trusted GPS → arrival/start → UAT photo references/checklist → completion → issued invoice → balanced ledger/payout accrual → admin visibility → customer notifications. Notification reads are idempotent.

This is **not** proof of lead/signup UI, live geocoding, uploaded R2 photos, real gateway callbacks, actual payout, review, or subsequent subscription/retention/cross-sell/win-back. Those steps were not fabricated into the demo.

Analytics includes the separate ₹1,500 seeded booking: **3 bookings, 2 completed, ₹5,298 GMV and collections**. After cron initialization, the analytics response reports no degraded sources. Contribution margin still requires configuration.

The built scheduled handler returned **HTTP 200 `ok`** against local D1. Persisted scheduler records show completed runs without `last_error`; `PRAGMA integrity_check` is `ok`, foreign-key checks return no violations, and the blocklist trigger exists. This proves these records, not universal schema correctness.

The native desktop browser rendered CX and retained the entered search across a real Worker restart/reconnect while new demo notifications became visible. Automated headless Chromium launch was blocked by the host's Mach-port sandbox; the added browser reconnect test remains to be executed in CI/staging.

## Delivery gap exposed, not concealed

The scheduled dispatcher moved **13 chat messages to DLQ** with `unsupported_outbox_channel`. Their in-app notifications remain visible. The external chat adapter is not implemented in that generic dispatcher's execution path; a successful cron response must not be interpreted as successful external delivery. The corrected notification API now exposes this failure instead of stale `queued` status.

No Razorpay/RazorpayX receipt, WhatsApp/SMS/email/push delivery receipt, IDfy result, or storage-provider result was obtained. Full external delivery and recovery require an approved sandbox deployment and its configured providers.

## Reproduction

Run from the repository. Install dependencies and build first. Keep these financial locks explicit:

```sh
PAWSPACE_PAYMENT_ENV=sandbox PAWSPACE_PAYMENT_LIVE_APPROVED=false FORBID_PRODUCTION=true npm run test:infrastructure-closure
npm run typecheck
```

After the hardened identity seed procedure, run the HTTP-only demo against the local Worker. Choose an unused future day offset when retaining an existing demo database:

```sh
E2E_BASE_URL=http://127.0.0.1:8891 E2E_DEMO_DAY_OFFSET=9 npx playwright test --config playwright.e2e.config.ts --project=chromium e2e/journeys/06-http-connected-demo.spec.ts
```

For a cron probe, start `scripts/e2e/serve-hardened.sh` with `E2E_TEST_SCHEDULED=1`, `E2E_SKIP_BUILD=1`, an isolated `E2E_PERSIST_DIR`, and the financial locks above. This mode omits static assets so Wrangler reaches the scheduled handler directly. Request `/cdn-cgi/handler/scheduled?cron=%2A%2F5%20%2A%20%2A%20%2A%20%2A`. Use default mode for UI assets. Never seed SQLite while Wrangler owns its backing file.

## Remaining acceptance gates

The accompanying `human-readiness-checklist.md` retains every requested item and its current evidence boundary. A 95% result requires measured acceptance criteria and linked proof across each complete pipeline, with all financial/P0 gates passing. Unit-test counts are not a readiness percentage.

Required next evidence: the target staging URL/Worker, effective non-secret sandbox configuration, approved customer/provider/admin test identities, provider callback/delivery receipts, browser execution, measured p95/error rates at an agreed load, and rollback rehearsal. The current local work cannot certify those deployment-dependent outcomes.

The hardened runner now uses Node's detached spawn instead of the missing macOS `setsid` executable. A local startup smoke returned HTTP 200. Cross-command process signals were denied by this host sandbox, so detached cleanup is not certified here; the ordinary attached Worker was stopped/restarted successfully through its tool session.

## Final validation

- Full final local suite: **4,652 passed, 0 failed, 0 skipped** (294.3 seconds).
- Infrastructure subset: **301 passed**, overlapping the full suite.
- Built-Worker HTTP connected demo: passed; identity API subset: 3 passed.
- Build, TypeScript, shell syntax, and `git diff --check`: passed.
- Final notification HTTP read reports `dead_letter`, matching actual dispatch state.
- Local financial lock assertion passed: `PAWSPACE_PAYMENT_ENV=sandbox`, `FORBID_PRODUCTION=true`, `PAWSPACE_PAYMENT_LIVE_APPROVED=false`. This is not an attestation of any deployed environment.
