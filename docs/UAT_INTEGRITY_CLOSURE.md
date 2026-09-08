# UAT integrity closure

This change addresses audit PS-07, PS-08, PS-09, PS-10, PS-11 and PS-12. It is a candidate repair, not all-module UAT or native-device certification.

## Product behavior

- Staff customer 360, pet creation and communication preferences enforce city scope. Only the explicitly global super administrator may cross cities. Customers remain owner-scoped and providers cannot read customer communication preferences.
- Sandbox payout checker identity, audit event and instruction status commit in one D1 batch. The guarded event insert rejects stale state inside the transaction. A legacy awaiting-approval record without a first checker is refused rather than accepted by the second checker.
- Subscription consumption atomically commits the event, wallet counters and booking usage. Failure leaves the reservation intact; retry consumes it once. Competing requests cannot consume the same reservation twice.
- Database failures propagate from finance anomaly and forecast reads; API error handling reports unavailability instead of a clean ledger or stable forecast.

## Evidence and regression

`tests/uat-integrity-recovery.test.mjs` injects SQLite trigger failures at every payout write boundary, both approval levels and each subscription write boundary. It also covers concurrent checkers/consumers, retry, incomplete legacy approvals, finance read errors and batch isolation.

`backend/test/customer-scope.test.ts` exercises real signed-token requests against an isolated MemoryRepository.

Run `node scripts/run-uat-integrity-d1.mjs` for the local-only Cloudflare D1 regression. It starts its own worker and disposable database, verifies rollback and retry, and tears them down. `wrangler.uat-integrity.jsonc` is a regression configuration, not a deployment target. Release CI runs the same script.

The shared Node SQLite D1 adapter now rolls back failed batches and serializes concurrent batches. The money-hardening and payout suites use that adapter instead of duplicate non-transactional versions. Existing business assertions are retained.

## Integration notes

PR585 also repairs batch rollback in the shared execution harness. Preserve its vertical coverage and module-hook changes when combining work. This change additionally serializes concurrent batches and migrates two duplicate adapters. No native files associated with PR590 are changed.

No data repair runs automatically. Previously inconsistent payout or subscription records require identification and controlled reconciliation; a fresh UAT seed must not be mistaken for repair of existing data. Live payments, payouts, provider delivery and production deployment remain separate gates.
