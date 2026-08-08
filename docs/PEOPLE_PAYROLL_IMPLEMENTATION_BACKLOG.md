# PawSpace People / Payroll Implementation Backlog

This backlog accompanies `docs/PEOPLE_PAYROLL_UAT_SPEC.md`.

**Status: Gates 1–6 engineering implemented for UAT on PR #22. PRODUCTION READY = FALSE.**

## Recommended build sequence

### Gate 1 — Employee identity + People RBAC

- canonical employee master and employment lifecycle
- user-account link
- organization/team/manager/cost-centre assignment history
- sensitive-field masking
- People/Payroll permission catalogue
- audit events

### Gate 2 — Shift + attendance + leave

- versioned shift/holiday/leave policies
- employee shift assignments
- check-in/out and attendance summary
- adjustment workflow
- leave ledger and approvals
- payroll-period lock interaction

### Gate 3 — Compensation + payroll calculation

- versioned salary structures
- employee compensation assignment
- payroll periods / locked input snapshots
- deterministic employee payroll results
- maker-checker approval
- payslip read model
- sandbox payment batch only

### Gate 4 — Incentive management

- versioned schemes by role/team/period
- canonical metric inputs
- collected/refund-adjusted revenue truth where configured
- quality guardrails from explicit policy
- hold / dispute / adjustment / reversal
- one-time approved flow into payroll

### Gate 5 — Finance + expense + statutory integration

- employee expense linkage
- payroll journal integration
- period lock and reconciliation
- statutory configuration boundary
- sandbox statutory exports
- sandbox bank batch/reconciliation references

### Gate 6 — Productivity / reports

- governed metric definitions
- employee/team rollups
- source drill-down
- manager scope
- payroll/incentive/attendance audit reports

## Non-negotiable test gates

Every implementation gate must include:

- positive path
- unauthorized-role negative path
- employee ownership/scope path
- idempotency/retry where relevant
- correction/reversal path
- audit event
- period-lock test
- no negative leave/credit/pay result unless explicit policy allows it
- no hard-coded statutory/incentive/penalty rates
- no real bank instruction or statutory filing in UAT

## Explicit policy decisions deferred until management/Finance/HR approval

- employment categories and probation rules
- attendance grace/late policy
- leave entitlements/carry-forward/encashment
- overtime eligibility/rates
- salary components
- incentive targets/formulas/caps/clawbacks
- statutory applicability/rates
- payroll schedule and cut-off
- bank payment process
- performance-review policy
- any location-based employee attendance requirement

These must remain configuration-required rather than being invented in code.
