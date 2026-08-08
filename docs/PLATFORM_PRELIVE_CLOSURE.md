# PawSpace platform pre-live closure

Status date: 2026-08-08

## Status

**ENGINEERING / INTERNAL-UAT CLOSURE TARGET — PRODUCTION READY = FALSE.**

This document covers the shared operating platform after the core service-engine hardening. It does not authorize production credentials, customer/vendor data migration, live money, live outreach, live media spend or autonomous AI execution.

## Closure sequence

### 1. Walking

Dog Walking Gates 1–5 are implemented in PR #4 on `agent/walking-gates1-5`. Merge remains blocked until the repository workflow is allowed to execute and returns green CI evidence. The current workflow state is an Actions-level `action_required` before jobs start, not an accepted code-validation result.

### 2. Training

**Application/UAT contract closed, subject to branch CI.**

Training now has an explicit closure contract and permanent cross-gate regression covering canonical commercial quote/programme/session identity, provider ownership, recovery, Finance reconciliation and private evidence trust state. See `docs/TRAINING_CLOSURE_PLAN.md`.

### 3. Customer 360 / CRM

**Canonical application layer implemented, subject to branch CI.**

- One Customer 360 read model composes CRM contact data with canonical customer, pets, bookings and CX tickets.
- Contact consent is a governed record instead of a browser-only flag.
- Duplicate candidates are surfaced for review using normalized phone/email matching.
- Duplicate review never performs a destructive merge automatically.
- Data-quality score and issues are explicit.
- Team Sales uses Customer 360 as its main customer worklist; the older CRM surface may remain for comparison/UAT but is not the new canonical Team front door.

### 4. Maximum Revenue / CRM automation

**Governed UAT decision-support layer implemented, subject to branch CI.**

- Revenue actions use canonical recency, frequency, booked value, service gaps, CX risk, consent and data-quality signals.
- Missing marketing consent, unresolved refund/payment issues, open complaint/safety cases, duplicate review and low data quality suppress an action.
- Revenue estimates are labelled `uat_rules_v1` and `estimateOnly`.
- Contribution margin is not fabricated; margin remains `configuration_required` until an approved canonical cost/margin model exists.
- Revenue actions require claim/completion and preserve booking/collection attribution.
- CRM automation is disabled unless an explicit purpose/channel policy is approved.
- Quiet hours, frequency caps, retries and maximum attempts are configuration-driven rather than hard-coded business rules.
- Automation writes are idempotent; retry exhaustion or missing retry policy sends work to a dead-letter queue.

### 5. Unified Conversation / Customer Experience

**Canonical thread layer implemented, subject to branch CI and external adapter UAT.**

- Existing communication outbox/adapters remain the delivery engine.
- Threads link customer, booking, lead and ticket identity.
- Participants, inbound/outbound messages, delivery state, assignment, SLA and audit are canonical.
- Provider participants and sensitive payload fields are hidden outside staff scope.
- Inbound provider events are replay-safe.
- Team Customer Experience now has a real conversation workspace rather than re-exporting CRM.
- Live WhatsApp/SMS/email/push/chat/voice still requires provider credentials, webhook UAT and reconciliation.

### 6. Partner Finance

**Settlement governance implemented; payout policy remains open.**

- Service earning evidence can materialize into provider settlement statements.
- Manual incentive/deduction/reversal/correction adjustments require an explicit reason and audit event.
- Settlement approval is blocked while payout policy is `configuration_required`.
- Payout instructions are idempotent and sandbox-only.
- No RazorpayX or other production payout instruction is executed.
- Team Finance has a Partner settlement/readiness workspace.

Service-specific payout/commission/incentive/penalty formulas still require approved business configuration before any statement can become production payable.

### 7. Marketing

**Governed campaign/application layer implemented; live media buying remains disconnected.**

- Legacy seeded active campaigns, arbitrary budgets, ROAS rules and default operating assumptions are no longer the canonical Marketing API behavior.
- Campaigns start as drafts with explicit budget and explicit holdout percent.
- A human approval and a governed audience snapshot are required before activation.
- Audience snapshots suppress missing marketing consent, open CX cases, unresolved duplicate review and low-quality customer records.
- Holdout membership is stable/deterministic for a snapshot.
- Attribution facts can link source, customer, lead, booking, collection, spend and contribution margin without inventing unavailable values.
- Google Ads, Meta and GA4 production connectors remain `not_connected` in this closure.
- Application-level `active` status never means live external marketing media spend.

### 8. Company Analytics

**Canonical metric layer implemented, subject to branch CI and source completion.**

- Booking, completion, cancellation, GMV, collected amount, unique/repeat customers, CX tickets and provider profile metrics derive from canonical facts.
- Service-level drilldown comes from canonical bookings/payments.
- Data-quality counters are first-class metrics.
- Static Admin arrays are not accepted as canonical analytics truth.
- Refund aggregation, contribution margin, marketing spend, tax and production payout metrics stay visibly unavailable/configuration-required until their canonical sources are complete.

### 9. AI intelligence

**Governance/readiness layer implemented; external AI provider remains disconnected.**

- AI context snapshots are short-lived and `minimum_necessary`.
- Suggestions require confidence and human review.
- Prompt/suggestion/review activity is auditable.
- Provider/model identity is explicit; default provider is `not_connected`.
- Autonomous refunds, price changes, payments, payouts, outbound contact, customer merges, provider assignment and campaign activation are hard-blocked.
- The AI safety contract is idempotent and tests those forbidden-action boundaries.

A production AI model provider may only be connected after privacy/security review and a broader evaluation suite for hallucination, PII leakage, bad recommendations and unsafe automation.

### 10. Full pre-live regression

**Permanent source/invariant regression added; runtime CI and human rehearsal still required.**

The branch adds platform-wide regression enforcing the above contracts plus existing service suites. Final pre-live approval additionally requires:

- full web build/test/lint and backend typecheck/tests;
- permission-negative tests for all privileged actions;
- retry, idempotency and concurrency tests;
- webhook signature/replay and adapter outage/degraded-mode tests;
- refund and payout reversal tests with approved policies;
- migration/import dry run using non-production exports;
- backup/restore rehearsal;
- security/privacy review;
- mobile/device/browser real-device UAT;
- employee pilot and controlled Bengaluru-zone pilot.

## Production blockers intentionally open

Engineering closure must not be used to bypass these dependencies:

- production customer/provider identity provisioning and final ownership mapping;
- production storage, private signed delivery and malware/image scanning;
- live communications credentials and provider webhook reconciliation;
- live payments, live refunds and live payouts;
- approved service cancellation/refund/no-show policies;
- approved partner compensation, incentive, deduction and payout formulas;
- GST/tax/invoice/accounting configuration and exports;
- approved contribution-cost/margin model;
- live Google/Meta/GA4 marketing media spend and attribution imports;
- external AI model provider plus privacy/security/evaluation sign-off;
- production monitoring, alerting, backups/restore proof, domains and support SOP;
- real-device, employee and controlled-pilot evidence.

## Merge / launch rule

A branch may be reviewed when its code and permanent regression are present. It is not merge-certified until the current PR head passes the repository CI required by the project. A merged engineering/UAT closure is still not a production launch approval. Production activation requires explicit business-policy approval, external sandbox evidence, security/privacy review and controlled pilot authorization.