# Employee V1 reuse implementation — expanded closure candidate

Repository: PawSpaceIND/pawspace-tech-platform. Branch: fix/employee-reuse-payroll-integrity-20260927. PR: #1149.

## Implemented on the shared V1/V2 foundation

- Payroll creation and source consumption remain atomic, with duplicate/overlap protection. Review follow-ups now compare each saved component's code, label, amount, kind, source and policy to the snapshot and require a matching payslip per result. Missing or altered evidence is refused.
- Partial employment periods require an explicit salary calculation policy. Finance can choose full-period pay or calendar-day proration for explicitly selected components. The latter requires one complete IST month. Used policy versions cannot be changed. This does not invent absence deductions, overtime rates or statutory treatment.
- Payroll setup screens now create structures, assign compensation, record approved proration rules and calculate a monthly run with a stable retry key, using existing API permissions.
- Employee attendance uses its assigned timezone (India fallback) and recognizes overnight shifts. Future timestamps, check-out without check-in, duplicate open check-ins and out-of-order events are refused. Event/day writes are atomic, with concurrent-snapshot validation.
- Leave validates real ordered dates and whole/half-day units. Multi-day leave requires an assigned work calendar and must match its working-day count. Partial days are separate requests. Correction approval and leave approval require distinct requesters/approvers.
- Staff lead assignment always respects explicit unavailability and linked employee approved leave/inactive status. Assigned employee shift windows/weekly-off rules apply before workload ranking. Pending leave is not silently approved. This is staff lead routing, not the separate G15–G19 provider booking/calendar workstream.
- Daily incentive failures remain in a durable pending-day queue. Later ticks recover bounded older work; successful rows are not duplicated. Monthly approval refuses unfinished or changed daily evidence.
- Performance selects a completed fact run for the requested team rather than the latest global run.
- Payroll reporting and self-service exclude unapproved or conflicting results. Reports show withheld-record counts and a 500-result limitation warning instead of hiding uncertainty. Approved pay is explicitly distinguished from a bank payment.

## Employee-specific sandbox salary transport

Existing RazorpayX sandbox transport is reused, without treating an employee as a partner or commission provider. Payroll has its own beneficiary evidence and instruction records; amount comes from the approved employee result, not a browser-supplied amount.

The flow is: reviewed TEST beneficiary evidence -> non-maker salary authorization after payroll approval/preparation -> one instruction per result -> sandbox dispatch with unchanged idempotency key -> signed provider confirmation/reconciliation -> paid_sandbox result. Reversal returns the payroll to review/prepared state. Invalid signature, amount, currency or beneficiary cannot settle salary. Provider failures do not claim payment.

All salary API writes require payroll.approve, explicit confirmSandbox=true and complete sandbox-only provider configuration. The transport rejects live posture. A background sweep processes already-authorized TEST instructions only when PAWSPACE_EMPLOYEE_SALARY_SANDBOX_AUTODISPATCH=on; this flag has not been enabled in any hosted environment. Uncertain or terminal failed instructions are not automatically requeued by that sweep.

Manual beneficiary evidence is labelled reviewed, not automatically bank-verified. No actual bank account, live credential or real salary transfer was used in tests. Tests use disposable SQLite and a loopback HTTP provider.

Razorpay contract references checked for the adaptation: https://razorpay.com/docs/api/x/payouts/create/bank-account/ and https://razorpay.com/docs/api/x/payout-idempotency/ (salary purpose, paise amounts, immutable idempotent retry).

## Verification checkpoint

Before publication of this expanded candidate: 241 selected employee/regression tests passed, zero failures/skips; 34 salary/provider-transport tests passed, zero failures/skips (the salary subset overlaps the employee selection); schema governance 14/14 passed. TypeScript and changed-file ESLint passed. Later additions and the final exact commit must be rechecked; these are not a full-repository or hosted end-to-end claim.

Historical source/presentation fingerprints were refreshed only for intentional changes. Each original raw/semantic hash was compared with the current PR base before updating; no unrelated assertion was removed. Positive fixtures now include actual payroll approval before released payslips and an explicit assigned calendar before multi-day leave.

## Boundaries still requiring acceptance

- Hosted staff login/MFA and real role-specific browser journeys have not been certified by these local unit/contract tests.
- Sandbox provider tests use loopback transport, not real bank deposits. Live employee salary remains disabled. Real provider onboarding, reviewed beneficiary proof, bank funding, provider credentials/network approval and live-money sign-off are separate.
- Calendar-day proration is explicit, not a substitute for approved absence/overtime/holiday/statutory policies. Multi-day leave currently uses the assigned weekly-off calendar; public-holiday/encashment policy and full final-settlement/offboarding orchestration are not claimed complete.
- Conservative overlap protection refuses a second active payroll until a governed correction/supersession process is agreed. No historical payroll or employee record is silently deleted.
- Payroll report result windows are bounded and visibly labelled; they are not a new all-history financial export.
- Provider booking leave/open-slot/G15–G19 requirements remain with the separate provider-scheduling workstream.

No production settings, employee records, salary beneficiaries, actual payroll or live disbursement were changed by this implementation session. Source and test changes remain subject to exact-head CI, review and authorized staging acceptance before merge/deployment.
