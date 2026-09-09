# Infrastructure and golden journey audit

Status: local regression evidence established; deployed human-beta closure is not certified.
Baseline: GitHub main ccfe2ee5. Branch: audit/infrastructure-golden-journey.

## Defects fixed

1. The canonical payment parser accepted live mode even when FORBID_PRODUCTION was true. It now refuses that combination before provider I/O, including when live approval is also true.
2. Razorpay sandbox credential variables accepted a live-prefixed key. Shared validation now rejects that key in orders, payment links, sandbox refunds, subscriptions, plan verification and settlement reconciliation. Error messages contain no credential values.
3. Subscription and plan adapters silently defaulted an absent mode to sandbox and mapped unrecognized modes to live. Both now use the exact canonical parser and exact live-approval comparison.
4. Release CI had the intended three safety declarations but no reusable assertion of their exact values. The web-test job now asserts all three before running tests. The infrastructure runner rejects absent, malformed or contradictory declarations before spawning its test process.

The regression tests intercept fetch and assert zero calls for rejected configurations; an order retry succeeds after replacing a mislabeled live key with a test key. No external financial operation is needed to reproduce these defects.

## Evidence by requested phase

| Phase | Local evidence | Remaining closure evidence |
| --- | --- | --- |
| Golden journey | Grooming connected route journey, four vertical execution suites, assignment/provider execution, cancellation/refund and subscription suites | One correlated browser-to-warehouse journey through lead, signup, payout, repeat purchase, retention and win-back on the selected staging deployment |
| Data integrity | Real SQLite transaction rollback injection, concurrent checkout/webhook/release tests, migrations, query-plan and booking-state checks | Deployed D1 schema/foreign-key/drift queries and concurrent distributed clients; local adapters do not prove production lock behavior |
| Integrations/webhooks | Local Razorpay HTTP contract failures, signature/replay checks, Meta webhook tests and stricter outbound financial boundaries | Sandbox evidence for Razorpay/RazorpayX, approved messaging/telephony recipients, IDfy, Maps, media, push and email; provider callback/delivery receipts |
| Queues/realtime | Outbox policy, stale claim/retry and delivery ordering regressions | Deployed queue/DLQ inspection, monitoring alert receipt, reconnect/resume and duplicate handling under actual browser/device network loss |
| Resilience | Injected transaction failures, provider 4xx/5xx, timeout/network errors, duplicate requests and lost-lease recovery | Staging outages and interrupted browser payment/service sessions with recovery evidence |
| Security/observability | Auth/security, GPS controls, immutable-write rollback and authorization suites | Deployed RBAC/upload/log-redaction checks, actual alert delivery and measured p95 under an agreed concurrency and latency budget |
| Analytics/release | Analytics scale/truth regressions, release-gate tests, successful build and typecheck | Warehouse reconciliation, deployed migration/rollback drill and feature-flag inspection |
| Sandbox enforcement | Exact local/CI declarations asserted; rejected modes and mislabeled keys produce zero provider calls | Read and verify the effective deployed Worker bindings before any staging certification or merge |

The repository contains both executable tests and source-contract checks. A green test count is not a percentage of business readiness. No 95% readiness, zero-drift deployment claim, complete security certification, or live-provider success is asserted here.

## Reproduce local checks

```bash
npm ci
npm run build
npm run typecheck
PAWSPACE_PAYMENT_ENV=sandbox FORBID_PRODUCTION=true PAWSPACE_PAYMENT_LIVE_APPROVED=false npm run test:infrastructure-closure
```

The runner prints only these non-secret safety declarations:

```text
PAWSPACE_PAYMENT_ENV=sandbox
FORBID_PRODUCTION=true
PAWSPACE_PAYMENT_LIVE_APPROVED=false
```

A caller must supply these values: the runner does not overwrite an unsafe configuration to make the assertion pass. This validates its local process, not a remote deployment.

## External blocker

A staging URL/Worker name and approved customer/provider test identities have been requested. No staging target has been selected for this task. Deployed credential configuration, callback receipts, D1 data and telemetry have not been inspected. Keep human-beta release closure open until that target is supplied and the remaining evidence above is collected. Do not interpret local mocks, SQLite adapters, source-contract tests or a build manifest as external-service certification.

## Validation results

- Full local suite: **4,647 passed, 0 failed, 0 skipped** (323.5 seconds).
- Infrastructure closure subset: **293 passed, 0 failed, 0 skipped**. This overlaps the full suite; do not add the counts.
- Focused subscription/settlement/payment guard run: **31 passed**.
- Application build, TypeScript check and `git diff --check`: passed.
- Unsafe runner smoke check: live settings refused with exit 1 before test spawning.

The first diagnostic full run preceded the build artifact and overlapped creation of a separate guard test file. It reported a missing rendered-worker artifact and a test-quality ratchet failure. The artifact was built and the guard cases consolidated into the executable payment test; both targeted reruns and the subsequent full suite passed. Settlement test transpilation loaders were updated to resolve the newly shared guard module.

Runtime: Node v24.19.0 locally. Release CI is configured for Node 22.16.0; its remote run has not been dispatched by this task. Build success is local evidence, not a deployed smoke test.
