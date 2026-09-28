# Employee reuse build — payroll integrity, first delivery

Date: 27 September 2026 (Asia/Kolkata).
Base: `610b3eb6c3dd842a965d2968640d2488d48ed64e`.
Scope: repair the shared V1/V2 payroll engine; no second employee master or payroll authority.

## Implemented

- PAY-02: reject a second active same/overlapping-period calculation. This engine calculates the whole active employee population; an independent overlapping payroll is not silently created under another request key.
- PAY-03: collect run, result, component line, payslip, incentive link and advance recovery writes into one D1 batch. A failed business write rolls back the full calculation. Same-key replay checks period, expected employee/line counts, snapshot identity and result arithmetic.
- PAY-04: conditional checks execute in the same batch as payment preparation. Concurrent calls converge on a single sandbox batch and preparation event. Historical duplicate batches and incomplete runs fail closed for human review rather than being deleted.
- Revalidate included incentive and advance source status/amount inside the calculation transaction, not only when first reading the source.
- Existing incentive and advance functions accept an optional statement collector. Their models and ordinary callers remain intact.

The additive `payroll_integrity_checks` table is owned by `ensurePayrollTables`. Its named CHECK constraint is used for transaction assertions; assertion rows are removed within the same batch. A failure rolls back the transaction. No existing payroll table or historical row is dropped.

## Executed verification before publication

- The original eight new payroll regressions failed on the old implementation and passed after repair.
- The expanded SQLite-backed suite passes **13/13**, including late-failure rollback of incentive consumption and advance recovery, changing source evidence, and concurrent different request keys.
- Local Cloudflare D1/Miniflare integration passes **2/2**: late-write rollback/retry, four concurrent calculations and six concurrent payment-preparation calls. No remote D1 or bank writes are used.
- TypeScript and changed-source/test ESLint pass on the updated base.
- Full repository `npm test` was started; its final result is not claimed in this commit. Consult the PR's latest verification status.

The D1 test uses the installed Miniflare 5 compatibility converter. Runtime setup is isolated and disposable; it does not read production credentials. SQLite tests execute real payroll functions and SQL with transactional D1-batch semantics; they are not mocked payroll totals.

## Preserved boundaries

No OTP, MFA, authorization, customer booking, partner scheduling, or payout-provider behavior was replaced. The upstream Founder-access repair and partner-page syntax correction are included through the new base, not rewritten here.

Only the four intentionally changed existing source files have refreshed fingerprints in nine historical presentation manifests (36 entries). No guard assertion or unrelated source fingerprint was removed.

## Not closed by this delivery

PAY-01 proration/attendance-driven salary; salary-structure and new-run UI; payroll report/payslip release rules; attendance/timezone and leave validation; incentive sweep recovery; team-specific performance selection; employee leave-aware lead assignment; payroll beneficiary/dispatch/reconciliation; employee exit/final settlement; hosted staff login/MFA and full browser acceptance.

The six pending operations acceptance cases from the preceding turn remain preserved in the separate audit evidence directory. They are not represented as passing or included in this payroll-only slice. The previous combined operations edit was not applied or retried here.

New calculations with no eligible employees are refused. Existing incomplete runs or duplicate historical batches require explicit reconciliation; this patch does not invent cancellation, supersession, correction payroll, statutory rates, absence deductions or overtime policy. The overlap guard is intentionally conservative until a governed correction-run workflow is built.

Salary payment remains **sandbox preparation only**, with `externalTransmission: false` and no enabled automatic bank disbursement. Neither a successful unit test nor a local D1 test is a production payout approval.

## Remaining acceptance

1. Complete exact-source full tests, schema checks and both module-loader paths.
2. Review the PR and all required GitHub checks; fix findings rather than bypassing gates.
3. Verify the scoped behavior on an authorized staging candidate without replacing parallel booking/UI work.
4. Continue the remaining employee workstreams separately and verify one continuous employee journey before claiming complete sign-off.

Evidence on the authorized Mac: `Documents/PawSpace-audits/employee-build-20260927/evidence/`. This delivery contains no live employee data or credentials.
