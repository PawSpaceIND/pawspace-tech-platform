# RX1165: partial shared payout-receipt repair

Base: `7f3a3bd63e9e8b1a0e5cf9e1ac0ae8bbcf380bd6`. Tracks issue #1165; does not close it.

## Implemented in this branch
- Extract the existing salary-path immutable receipt checks into one shared helper used by salary and partner payouts.
- Validate the payout creation response against the requested reference, beneficiary, integer amount and currency.
- Reject contradictory event/status pairs and sandbox callbacks aimed at live-labelled local payouts.
- Validate the canonical source again inside the receipt transaction, including concurrent environment changes.
- Resume RECEIVED and UNMATCHED callbacks rather than acknowledging unfinished work as processed.
- Commit provider state, source payout, related legacy statement/commission and receipt acknowledgement in one guarded D1 batch.
- Preserve completed/reversed outcomes during duplicate and out-of-order callbacks, including callbacks arriving before the creation response.
- Preserve a completed callback when the original creation response is lost or arrives later in processing state.

The shared helper reuses the salary validation pattern. No separate V2 money engine is introduced. The existing V2 aliases continue to use canonical Finance/Payroll modules.

## Verified locally
- Existing 27-file finance/payroll selection plus the expanded audit and two schema checks: **280 tests; 279 passed; 1 failed; 0 skipped**.
- The remaining failure is the existing RX-07 salary-scheduler wiring assertion. All six original runtime receipt regressions pass.
- Expanded audit: **21 tests; 20 passed; 1 failed; 0 skipped**. These overlap the 280-case selection.
- Partner transport and employee salary compatibility: **32/32 passed**, overlapping the same selection.
- Presentation/source-preservation selection: **81 tests; 76 passed; 5 failed; 0 skipped**. The five failures are unchanged exact-source fingerprint expectations for intentionally modified business sources. They are not presented as passing.
- Typecheck, targeted lint, production-format build and Worker artifact validation passed locally.
- Tests ran with Node 24.19.0, isolated synthetic SQLite/D1 data and mocked/loopback provider responses. No real RazorpayX payout was sent.

All existing behavioral assertions remain. The older synthetic webhook helper was completed with the fund-account identity expected in a real provider entity; identity validation was not relaxed to accommodate incomplete fixtures.

## Blocked edits and unfinished scope
The tool blocked the proposed salary-scheduler integration before execution. `worker/index.ts` is unchanged; the opt-in salary routine still is not scheduled. Its failing diagnostic assertion is retained, not skipped or removed.

A separate attempted exact-source fingerprint refresh was also blocked before execution. The presentation manifests remain unchanged. The five observed source-preservation failures therefore remain visible and must be resolved through the ordinary reviewed baseline process, not bypassed.

Contractor statement-to-payout handoff and final payout-in-transit/bank accounting remain unimplemented by this patch. It does not certify unattended payouts, live payroll or bank-to-ledger reconciliation. Commission payouts retain the existing automatic queue plus Finance release.

**Draft/review only: do not merge while these gates are failing.** No changes were pushed to main, no deployment was performed, and no live-money, OTP, credential, automatic-salary or payout-approval configuration was changed. Open #1163 and #1164 were not modified.

## Evidence
Authorized Mac: `Documents/PawSpace-fixes/razorpayx-v1-v2-audit-20260928-evidence/`.
- `regression-before-verified-fixture.log`: original audit failures before repair, after fixture setup was corrected.
- `receipt-first-after.log`: original receipt six passing, salary wiring still failing.
- `create-race-before.log` / `create-race-after.log`: reproduced and corrected creation-response races.
- `receipt-verification-inventory.json` / `receipt-verification.log`: complete selected file list and 280-case result.
- `presentation-contract-check.log`: five outstanding exact-source baseline failures.
- `receipt-typecheck.log` / `receipt-build.log`: local compilation and artifact checks.

Provider documentation consulted for protocol expectations: Razorpay's Test Mode payout lifecycle and webhook validation guidance. Provider-side TEST connection, actual signed callbacks and hosted V1/V2 acceptance remain separate future gates; passing local fixtures is not provider certification.
