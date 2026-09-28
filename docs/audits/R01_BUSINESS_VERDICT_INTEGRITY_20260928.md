# R01 — Authoritative platform business-test verdict

Date: 28 September 2026. Base: `db2c97003837663c7370e6ada2d9d1bf574e443e`.
Branch: `fix/r01-business-verdict-integrity-20260928`.
Scope: structured readiness Batch 1, local test integrity and fixture diagnosis.
Status: implementation and focused verification; not merged, deployed or production-certified.

## Reproduced causes

The unchanged platform matrix executed 81 business probes: 79 PASS and two FAIL,
yet all 15 Node test assertions passed and the process exited 0. The final matrix
asserted only that some evidence existed. Adding the strict verdict first made the
same two diagnostics fail E2E-999 and return process exit 1.

The settlement fixture used different recipient IDs but reused the original commission
booking IDs. The unchanged settlement engine correctly excludes a booking already
represented by a commission work order. Dedicated legacy per-session earnings now
use separate synthetic booking identities. No new provider model or payable authority
is introduced into application code. These seeded legacy records are a module test,
not evidence of a complete customer-created booking or hosted paid service.

The matrix's SQLite adapter executed batch SELECTs via run() and discarded their rows.
The actual AI analytics function needs the ordered D1 result sets. Repairing only the
adapter made analytics pass while settlement and the strict verdict still failed.
Repairing the settlement fixture then produced 81 PASS, zero FAIL/GAP/HARNESS.

No app, lib, worker, UI, production configuration or payment policy was changed.

## Preserved and stronger checks

- Every reported non-PASS status, including GAP, HARNESS and unknown statuses, blocks.
- Empty evidence, missing probes and duplicate identities block. The existing 81-probe
  inventory is preserved; changing it requires an explicit reviewed test update.
- Nine subprocess cases run the actual platform matrix: one healthy control and eight
  intentional faults (settlement, analytics, GAP, HARNESS, unknown, empty, missing,
  duplicate). A fault is valid evidence only when E2E-999 is the single failed test;
  setup errors, timeouts or a killed process cannot masquerade as success.
- The ten statements must still each show 900 of earned value, preserve adjustment
  arithmetic and require policy approval. Repeated refresh must remain idempotent.
- A separate 99,000 earning tied to an existing commission booking must contribute
  nothing to those statements even when its recipient differs from the work order.
- The local adapter retains ordered query rows and RETURNING data, and uses a
  synchronous savepoint batch so an exception rolls back that local sequence.

## Evidence and limits

Evidence directory: `Documents/PawSpace-fixes/r01-business-gates-evidence-20260928/`.
The baseline, gate-before-fixture-repair, adapter-only-repair and repaired-platform
logs each retain their own process exit file. Focused selections overlap the platform
suite; repeated subprocess executions are not additional unique business journeys.

Full exact-commit verification, CI review and merge remain separate gates. No hosted
D1, real gateway, carrier call, salary or partner transfer was exercised. A proposed
standalone adapter-regression file was blocked by tool safety checking and was not
written or retried through another mechanism; native-D1 adapter parity is not claimed.

D1 contract reference: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch

## Full-run follow-up: unchanged quality budget

The exact `c5f6e49b` Node 22.16.0 full tracked run completed: 8,837 assertions,
8,836 passed, one failed, zero cancelled/skipped/todo. The separate certification
batch and forced-loader focused selection passed. This is not a green full sweep.
The sole failure was the static-file ratchet: 161 classified files against the
unchanged budget of 160. The new subprocess-only top-level file caused the increase.

All nine actual gate scenarios are now registered by the existing executable
platform suite through a helper. No scenario, expectation or timeout was removed.
Only a process whose entry point is the explicit child fixture omits recursive
meta-test registration; an environment variable alone cannot suppress parent tests.
Every child still executes all 81 business probes and all 15 matrix assertions.
The parent executes the 15 matrix assertions plus the same nine gate scenarios.
A healthy child must also show exactly 15 passing assertions and zero failures.

The quality detector, exemptions and 160-file limit are byte-for-byte unchanged.
The related Node 22.16.0 selection including both quality checks passed 51/51,
zero failures, cancellations, skips or todos. Evidence: `quality-repair-focused.log`.
This is focused validation; a fresh integrated full run and cloud gates are required.
