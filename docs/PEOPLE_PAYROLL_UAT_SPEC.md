# PawSpace People, Attendance, Payroll & Incentive Management — UAT Specification

## Status

**DESIGN / UAT SPECIFICATION ONLY**

**PRODUCTION READY = FALSE**

This document defines the canonical People/HR, attendance, payroll, employee incentive and productivity boundaries to be implemented and tested before any launch decision. It does not approve statutory rates, salary structures, incentive formulas, payroll disbursement or employee monitoring policy.

## Current repository gap

- `/team/people` currently aliases the Operations page rather than providing a dedicated People/HR system.
- Finance has expense, vendor, bill, journal, bank, budget, period-lock and audit foundations, but Payroll is only surfaced as `integration-ready`.
- An older Revenue CRM path contains provisional sales performance/incentive rows with hard-coded people and formula assumptions. Those must not become canonical payroll or incentive truth.

## Design principles

1. One canonical employee identity across HR, attendance, payroll, expenses, incentives, productivity and user access.
2. Service providers/partners are not silently treated as employees. Provider earnings and settlements remain in Partner Finance unless an explicit employment relationship exists.
3. No salary, deduction, statutory rate, incentive formula, fine or bonus is hard-coded as company policy.
4. Payroll is derived from approved source facts and locked policy versions.
5. Every adjustment is auditable and reversible through explicit correction entries rather than silent history edits.
6. Maker-checker separation applies to payroll approval and payment preparation.
7. Employee privacy is part of the data model. Productivity means business outcomes and SLA/work completion, not covert surveillance.
8. UAT never sends a live bank instruction or statutory filing.

---

## Module A — Employee Master / HRIS

### Canonical objects

- `employees`
- `employment_contracts`
- `employee_org_assignments`
- `employee_documents`
- `employee_bank_profiles` (masked / encrypted reference only)
- `employee_statutory_profiles`
- `employee_emergency_contacts`
- `employee_assets`
- `employee_lifecycle_events`
- `employee_audit_events`

### Required fields / concepts

- stable employee ID
- legal/preferred name
- work email / authenticated user link
- phone with role-based masking
- department / team / city / cost centre
- reporting manager
- employment type
- joining date / probation / confirmation
- active / notice / exited lifecycle
- salary structure version reference
- shift policy reference
- leave policy reference
- incentive scheme references
- statutory profile references
- bank profile reference
- document/KYC/compliance expiry states

### UAT acceptance

- [ ] Create a synthetic employee.
- [ ] Duplicate employee identity is detected by governed matching rules.
- [ ] Move employee between manager/team/cost centre with dated history.
- [ ] Disable/exited employee cannot remain active in attendance/payroll/user-access workflows.
- [ ] Sensitive salary/bank/statutory fields are hidden from unauthorized roles.
- [ ] Every lifecycle change creates an audit event.

---

## Module B — Shift, Attendance & Time

### Canonical objects

- `shift_policies`
- `employee_shift_assignments`
- `attendance_days`
- `attendance_events`
- `attendance_adjustment_requests`
- `overtime_requests`
- `holiday_calendars`

### Required states

`scheduled -> present / absent / leave / holiday / weekly_off`

Optional operational evidence may include check-in/check-out, approved field-work event or manager adjustment. GPS must never be silently required for office staff; any location-based attendance rule needs explicit policy and privacy approval.

### UAT acceptance

- [ ] Scheduled shift is created from versioned policy.
- [ ] Check-in/check-out produces one attendance day summary.
- [ ] Duplicate/replayed check-in is idempotent.
- [ ] Missing checkout creates an exception rather than fabricated hours.
- [ ] Attendance correction requires reason and approver.
- [ ] Approved leave overrides absence correctly.
- [ ] Holiday/weekly-off is not treated as absence.
- [ ] Overtime remains pending until approved.
- [ ] Locked payroll period blocks retroactive attendance mutation without correction workflow.

---

## Module C — Leave Management

### Canonical objects

- `leave_policies`
- `employee_leave_balances`
- `leave_requests`
- `leave_approval_events`
- `leave_ledger_events`

### UAT acceptance

- [ ] Policy is versioned by effective date.
- [ ] Leave request checks employee eligibility and balance.
- [ ] Approval/rejection records approver and reason.
- [ ] Approved leave posts an immutable ledger event.
- [ ] Cancellation/reversal restores eligible balance through a new ledger event.
- [ ] Negative leave balance is impossible unless an explicit policy permits it.
- [ ] Payroll consumes approved leave facts, not UI counters.

---

## Module D — Salary Structure & Compensation

### Canonical objects

- `salary_structure_versions`
- `employee_compensation_assignments`
- `pay_components`
- `employee_recurring_adjustments`

### Rules

- Salary structures are effective-dated and immutable after use in an approved payroll run.
- Components distinguish earning, deduction, reimbursement and employer-cost categories.
- Statutory calculations reference approved configuration, not code constants.
- Retroactive compensation change creates an explicit arrears/correction path.

### UAT acceptance

- [ ] Employee salary structure is resolved by payroll period effective date.
- [ ] Old structure remains historically reproducible after a raise.
- [ ] Unauthorized role cannot view/change compensation.
- [ ] Retroactive change does not silently rewrite an approved payroll run.

---

## Module E — Payroll Engine

### Canonical objects

- `payroll_periods`
- `payroll_runs`
- `employee_payroll_results`
- `payroll_result_lines`
- `payroll_adjustments`
- `payroll_approval_events`
- `payslips`
- `payroll_payment_batches`
- `payroll_reconciliation`

### Payroll input sources

- active employee + employment contract
- salary structure version
- attendance summary
- approved leave
- approved overtime
- approved incentive/bonus
- approved deductions
- approved reimbursements where payroll-paid
- statutory configuration version
- prior-period correction/arrears entries

### Payroll states

`draft -> calculated -> reviewed -> approved -> payment_prepared -> paid/reconciled`

UAT stops before any real payment instruction.

### UAT acceptance

- [ ] Payroll calculation is deterministic for a locked input snapshot.
- [ ] Re-running calculation before approval is idempotent.
- [ ] Approved payroll cannot be silently recalculated.
- [ ] Maker cannot approve their own payroll run.
- [ ] Negative net pay is blocked or routed to explicit exception policy.
- [ ] Every result line explains its source/policy version.
- [ ] Payroll total reconciles to employee result totals.
- [ ] Approved payroll produces balanced Finance journal draft/posting according to Finance controls.
- [ ] Payment batch is sandbox/test-only and never transmits to a bank in UAT.
- [ ] Payslip exposes only the employee's own result unless privileged HR/Finance role.

---

## Module F — Statutory / Compliance Configuration

PawSpace must not hard-code or infer statutory rates. The system should support configuration and evidence for applicable Indian payroll requirements such as PF, ESI, professional tax, TDS and other required deductions/employer contributions, but actual applicability/rates must be approved by Finance/HR/legal/tax professionals before production.

### Canonical objects

- `statutory_policy_versions`
- `employee_statutory_elections`
- `statutory_payroll_lines`
- `statutory_reconciliation_runs`
- `statutory_export_batches`

### UAT acceptance

- [ ] Missing statutory policy results in `configuration_required`.
- [ ] No fallback percentage is invented.
- [ ] Effective-dated configuration is reproducible.
- [ ] Employee applicability is explicit.
- [ ] Filing/export remains sandbox until external compliance approval/integration exists.

---

## Module G — Employee Expense / Reimbursement linkage

Reuse the existing Finance expense foundation rather than creating a second expense ledger.

### UAT acceptance

- [ ] Expense claimant links to canonical employee ID.
- [ ] Duplicate expense detection remains active.
- [ ] Manager/Finance approval separation is enforced.
- [ ] Approved employee-paid reimbursement either enters payroll or AP based on configured settlement path.
- [ ] Same reimbursement cannot be paid through both payroll and Finance AP.
- [ ] Locked Finance/payroll period requires correction workflow.

---

## Module H — Incentive & Bonus Management

The existing provisional Revenue CRM formula is not policy authority.

### Canonical objects

- `incentive_scheme_versions`
- `incentive_eligibility_rules`
- `employee_incentive_periods`
- `employee_incentive_results`
- `incentive_result_lines`
- `incentive_adjustments`
- `incentive_disputes`
- `incentive_approval_events`

### Supported business signals

Examples only; enabled metrics must be approved per role/scheme:

- collected revenue
- converted bookings
- subscription renewals
- first-response SLA
- follow-up completion
- ticket SLA / reopen quality
- refund/cancellation quality guardrails
- service completion/evidence quality for operational roles
- data-quality / compliance requirements

### Rules

- Scheme is versioned by role/team/period.
- Target and formula are configuration, never hard-coded.
- Revenue means configured canonical financial truth (e.g. collected or refund-adjusted), not expected opportunity revenue.
- Quality guardrails can reduce/block incentive only when explicitly configured.
- Human approval is required before payroll inclusion.
- Clawback/reversal is a new ledger event, never a history edit.

### UAT acceptance

- [ ] Employee eligible under correct scheme/version.
- [ ] Ineligible employee gets no calculated incentive.
- [ ] Expected/pipeline revenue cannot count as collected revenue.
- [ ] Refunded revenue is treated according to configured scheme rule.
- [ ] Duplicate source event does not double-count.
- [ ] Result shows metric evidence and formula version.
- [ ] Manager cannot secretly edit a finalized result without adjustment event.
- [ ] Approved incentive flows once into Payroll.
- [ ] Disputed incentive remains on hold until resolution.

---

## Module I — Productivity & Performance

### Principle

Measure operational outcomes, not covert employee surveillance.

### Canonical objects

- `productivity_metric_definitions`
- `employee_daily_productivity`
- `team_productivity_rollups`
- `performance_goals`
- `performance_reviews`
- `performance_review_evidence`

### UAT acceptance

- [ ] Every productivity metric has a documented source and calculation.
- [ ] Static/demo counters are not accepted as performance truth.
- [ ] Employee can see permitted own metrics.
- [ ] Manager can see only assigned team scope.
- [ ] Metric can be traced to source booking/lead/ticket/activity records.
- [ ] Corrections propagate through governed recomputation rather than manual counter edits.
- [ ] Performance review remains separate from automatic disciplinary action.

---

## Module J — People RBAC

Current generic platform roles are insufficient for sensitive HR/payroll data. Add explicit permissions such as:

- `people.view`
- `people.manage`
- `attendance.view`
- `attendance.manage`
- `leave.manage`
- `compensation.view`
- `compensation.manage`
- `payroll.view`
- `payroll.manage`
- `payroll.approve`
- `incentives.view`
- `incentives.manage`
- `performance.view`
- `performance.manage`

Role design should support HR, Payroll/Finance, Manager, Employee self-service, Founder/Superuser and Auditor with least privilege.

### UAT acceptance

- [ ] Associate/customer/provider roles cannot access employee payroll.
- [ ] Manager cannot see compensation unless explicitly granted.
- [ ] Employee can view own attendance/leave/payslip only.
- [ ] Payroll approver separation is enforced.
- [ ] Auditor has read-only masked access.

---

## Finance integration

Payroll should integrate with the existing Finance journal/period-lock controls:

- approved payroll -> payroll payable + salary/benefit/employer-cost journals
- employee reimbursements -> configured payroll/AP path
- payment batch -> bank reconciliation reference
- locked Finance period -> no silent historical mutation
- payroll close -> contributes to Finance close checklist

No account codes should be considered final production policy until Finance approves the chart-of-accounts mapping.

---

## Required reports

- headcount and active/inactive employees
- joiners/leavers
- attendance/absence/late exceptions
- leave balances and pending approvals
- payroll register
- payroll variance vs prior period
- department/cost-centre payroll cost
- statutory reconciliation status
- incentive earned/pending/held/reversed
- reimbursement pending/paid
- overtime exceptions
- payroll approval/audit report
- productivity outcome report by team/role with source drill-down

---

## Test data policy

Use synthetic employees, synthetic bank references and sandbox statutory configurations only. Do not commit real PAN/Aadhaar/bank details or real employee salary data to source control.

## Exit definition

### Ready for staff UAT

- code implemented
- exact-head CI green
- permissions mapped
- migrations/schema included
- permanent positive/negative/idempotency tests included
- no live bank/statutory integration enabled

### UAT closed

- staff UAT evidence attached
- payroll reconciliation proven
- negative permission tests passed
- correction/reversal cases passed
- audit evidence captured

### Production ready

Not granted by this specification. Production requires approved HR/payroll policies, statutory/legal review, live identity/security, bank/payroll payment integration, statutory exports/filings as applicable, privacy/security review, migration of real employee data, backup/restore, monitoring and controlled payroll parallel-run validation.
