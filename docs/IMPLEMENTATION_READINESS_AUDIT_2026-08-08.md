# PawSpace Implementation Readiness Audit — 2026-08-08

## Status

**Execution-order audit only. PRODUCTION READY = FALSE.**

This document converts the current UAT/specification backlog into an operational queue. It separates work that can move now from work blocked by manual UAT, external integrations, policy approval, or CI tooling.

Taxi is excluded from the active execution queue unless explicitly resumed.

## Current repository execution picture

### Exact-head CI green / ready for staff UAT

1. **PR #6 — Shared Platform Closure**
   - branch: `agent/platform-closure`
   - head: `e25a95f3d014077223f25c39b122a19267494dee`
   - workflow run #701: success
   - next gate: staff UAT evidence, negative permissions, replay/idempotency, canonical source drill-down

2. **PR #8 — Assisted Orders UAT**
   - branch: `agent/assisted-orders-uat`
   - head: `91e55f68b240e26028c85f7ef8aa14be29323074`
   - workflow run #706: success
   - next gate: staff UAT only; keep draft

3. **PR #9 — Subscription Wallet UAT**
   - branch: `agent/subscription-wallet-uat`
   - head: `0ce7898d4de64b8df092b63c74ec273a05ce2009`
   - workflow run #708: success
   - next gate: staff UAT only; keep draft

### Engineering blocker

4. **PR #10 — Coupon Governance UAT**
   - branch: `agent/coupon-governance-uat`
   - head: `da0197cd24d40b15ef684ae48511ee6f922e9dae`
   - workflow run #714: failure
   - backend job: success
   - web `npm test`: failure
   - lint/artifact validation did not run after the web-test failure
   - exact root cause is not claimed here because the required CI-debug workflow depends on GitHub CLI log inspection, and `gh` is unavailable in the current execution runtime
   - remaining architecture work also includes fully binding coupon quote authority to canonical booking/redemption rather than trusting browser discount state

### Workflow/tooling blocker rather than observed code failure

5. **PR #4 — Dog Walking Gates 1–5**
   - branch: `agent/walking-gates1-5`
   - head: `b898c2942dd6d288deeb0f8ea6fd52b861e0be6c`
   - workflow run #657: `action_required`
   - jobs created: none
   - status: not CI-certified; do not infer code failure or success

### Deprioritized / out of active scope

- PR #5 Pet Taxi — leave inactive unless explicitly resumed
- PR #7 Food is stacked on Taxi and therefore not in the immediate active execution lane
- PR #3 is an older Walking branch and is not the primary Walking closure candidate

## Main branch note

`main` has advanced since the service branches were created because the new People/Payroll, GST/Accounting, Integration Readiness, Revenue Mission Control, GPS/Lateness and Pre-live Regression specifications were committed directly to `main`.

Before final integration, active feature branches must be refreshed/rebased/merged against the current `main` and exact-head CI must be rerun. A previously green feature head does not certify the eventual integrated tree.

---

# Execution queue

## Lane A — Start now: manual staff UAT

These require no external production credentials and no new policy invention.

### A1 — Shared Platform Closure #6

Execute the UAT Master Gate for:
- Customer 360 / CRM
- Revenue Intelligence / CRM automation
- Unified Conversation / CX
- Partner Finance sandbox governance
- Marketing draft/holdout/suppression
- Company Analytics source drill-down
- AI governance / prohibited autonomous actions

**Exit:** staff evidence attached/referenced; unresolved defects classified.

### A2 — Assisted Orders #8

Run:
- staff authorization/negative role
- consent required
- server-owned price
- canonical scheduler/provider
- booking/work-order/payment identity chain
- `assisted_staff` channel
- duplicate submit / lost-response retry
- audit event
- no live-money assertion

**Exit:** UAT closed only after evidence.

### A3 — Subscription Wallet #9

Run:
- wallet reconciliation
- reserve/consume/release
- customer ownership
- insufficient credit
- duplicate/retry
- completion gate
- pause/resume
- no auto-renewal / no invented renewal price

**Exit:** UAT closed only after evidence.

---

## Lane B — First engineering fix when CI log tooling is available

### B1 — Coupon Governance #10

Priority: **highest current engineering blocker**.

Required sequence:
1. inspect exact web-test failure from workflow #714
2. fix only observed cause
3. rerun exact-head CI
4. complete canonical booking ↔ coupon quote/redemption authority
5. add source regression preventing browser discount authority bypass
6. update stale PR description/UAT document
7. keep draft and run staff UAT

### B2 — Walking #4

After Coupon is green or in parallel when workflow execution can be restored:
1. resolve `action_required` workflow gate
2. run exact-head CI
3. only after CI green, execute Walking staff/device UAT

---

## Lane C — New internal engineering modules; no external credentials required for UAT architecture

These are implementable with UAT fixtures/configuration as long as no policy values are invented.

### C1 — Referral Management

Implement first after Coupon because both touch commercial eligibility and customer booking history.

Code-now scope:
- canonical referral programme/version objects
- referrer identity/code
- referred-customer link
- qualification record
- pending/released/reversed reward ledger
- fraud/hold review
- wallet projection
- idempotent event handling
- permissions/audit

Policy-blocked values:
- reward amount/type
- validity
- monthly/per-friend limits
- refund/cancellation reinstatement/reversal policy details

### C2 — Integration Readiness control plane (#14), internal registry only

Code-now scope:
- integration registry
- owner/environment/readiness state
- credential-presence status without raw secret exposure
- webhook/replay/idempotency evidence fields
- monitoring/reconciliation/kill-switch metadata
- launch dependency checks

External-credential blocked later:
- real sandbox/live provider verification

### C3 — Revenue Mission Control (#15)

Code-now scope:
- configurable mission amount + explicit period
- canonical booked/collected/refund/net mission events
- lead assignment policy model
- SLA policy model
- source-derived productivity facts
- dashboard/read model
- audit/idempotency

Policy-required:
- mission period/cadence beyond explicitly configured UAT test period
- final assignment priority rules
- final SLA values
- attribution rules
- incentive formula

### C4 — People / Attendance / Payroll foundation (#12)

Code-now scope:
- employee identity/master
- user link
- People/Payroll RBAC
- organization/team/manager history
- shift/attendance/leave data model
- compensation/payroll run framework
- maker/checker and audit

Policy-required before final calculation:
- employment categories
- leave entitlements
- grace/late policy
- overtime
- salary components
- statutory rates
- incentive formulas

### C5 — GST / Accounting foundation (#13)

Code-now scope:
- entity/registration configuration
- tax-policy versioning
- invoice/credit-note data model
- tax ledger
- accounting mapping versions
- reconciliation framework
- period-lock integration

Finance/CA approval required before real statutory truth:
- tax classifications/rates
- place-of-supply rules
- numbering policy
- input-tax eligibility
- TDS/withholding rules
- chart-of-accounts mapping

### C6 — Universal GPS / Lateness / Recovery foundation (#16)

Code-now scope:
- universal location sessions
- GPS trust classification
- ETA snapshots/degraded states
- punctuality policy model
- predicted-late/recovery events
- accountability case model
- Finance adjustment boundary

Policy/external blockers:
- final grace/alert/escalation values
- penalty/exemption/dispute policy
- production Maps/GPS provider/device trust

---

## Lane D — External-credential / provider-blocked verification

Tracked primarily by issue #14.

No engineering claim should mark these production-ready without real sandbox/live evidence:

- Razorpay payment/refund verification
- payout rails
- WATI/WhatsApp
- SMS
- email
- push
- Exotel
- Google Maps/Routes
- provider GPS/device source
- private object storage
- malware/content scanning
- bank feed
- accounting platform
- GST/statutory filing interface if used
- Google Ads
- Meta Ads
- GA4
- external AI provider
- production identity/MFA
- monitoring/error tracking
- backup/restore

Engineering can build adapters/control-plane boundaries before credentials exist; provider verification waits for real accounts/secrets.

---

## Lane E — Explicit management/Finance/HR/CA policy decisions

Do not invent these in code:

- coupon cancellation/refund capacity reinstatement
- referral reward amount/type/validity/limits
- provider payout/commission/incentive/deduction rules
- GPS lateness grace/escalation/penalty/exemption/dispute rules
- People leave/overtime/salary/incentive policies
- GST/TDS/statutory/accounting rules
- Revenue Mission period and attribution policy
- marketing budgets/ROAS activation policy
- margin/contribution formulas where not canonical

Use `configuration_required`, disabled state, or UAT fixtures clearly marked non-production until approved.

---

# Recommended implementation order

## Immediate parallel work

1. **Staff UAT:** PR #6
2. **Staff UAT:** PR #8
3. **Staff UAT:** PR #9
4. **Engineering blocker:** diagnose/fix PR #10 when CI log tooling is available

## Then engineering sequence

5. Referral Management
6. Integration Readiness registry/control plane
7. Revenue Mission Control / lead assignment
8. People identity + attendance/leave foundation
9. GST/accounting entity + invoice/tax-ledger foundation
10. Universal GPS/lateness/recovery governance
11. Walking CI/UAT closure once workflow execution is available
12. integrated release candidate
13. full pre-live regression
14. real-device staff rehearsal
15. required integration sandbox verification
16. controlled Bengaluru pilot

This order optimizes for dependency reduction rather than number of screens completed.

---

# What can be declared today

- **Engineering/internal-UAT code closed on merged core service paths:** some core services already satisfy this historical gate.
- **READY FOR STAFF UAT:** only exact-head green draft modules such as #6, #8 and #9, subject to their documented UAT scope.
- **NOT ready for staff UAT:** Coupon #10 until exact-head CI is green; Walking #4 until its workflow executes and passes.
- **NOT production ready:** the platform overall.

## Next concrete action

Begin staff UAT on #6/#8/#9 while engineering unblocks Coupon #10. Once Coupon is exact-head green and UAT-ready, implement Referral Management as the next new canonical commercial module.