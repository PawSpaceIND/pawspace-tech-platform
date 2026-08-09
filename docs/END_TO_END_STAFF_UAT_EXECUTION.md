# PawSpace end-to-end staff UAT execution pack

Status: **final engineering UAT candidate**

Production status: **PRODUCTION READY = FALSE**

This document is the execution order and evidence contract for one exact cumulative UAT candidate. It does not authorize production integrations, public provider admission, live money, production WhatsApp/telephony, autonomous AI decisions, provider financial penalties, or public launch.

## Entry gate

Before execution begins, record and preserve:

- exact release-candidate commit SHA and exact-head green CI run;
- UAT/preview deployment reference for that exact SHA;
- D1 `DB` binding and environment mode;
- test identities for customer, provider, Ops/onboarding, Finance, CRM/Sales/manager and AI/handoff staff;
- active provider onboarding policy, approved 20-question quiz, approved legal/SLA content and enabled locale;
- approved UAT-only punctuality/location policy for each GPS-enabled service under test;
- approved Finance/GST UAT entity, registration, tax-policy/classification, numbering-series and accounting-mapping versions;
- controlled customer/booking/payment/refund fixtures;
- explicit confirmation that production KYC/e-sign/WhatsApp/telephony/external AI/live bank/live payment/live statutory filing/production accounting post remain disabled unless separately approved for a sandbox or controlled verification test.

If exact-SHA deployment or D1 cannot be verified, mark the run `BLOCKED` rather than inferring success from CI.

## Canonical execution order

1. **Customer identity and booking** — authenticate the customer, create/use the pet profile, quote and create a canonical UAT booking/payment state. Preserve customer ID, pet ID, booking ID and payment reference.
2. **Provider onboarding configuration** — through `/control/provider-onboarding`, confirm active locale/policy/legal content and the approved 20-question qualification version. Preserve version IDs.
3. **Provider self-service** — through `/partner/onboarding`, create the provider application, upload secure document references, submit, complete the frozen qualification after verification, accept the staff-created UAT SLA and complete required profile/media fields. Provider ownership must derive from `/api/identity-session`.
4. **Ops verification and interview** — through `/team/provider-onboarding`, execute UAT verification, 15-minute interview and an explicit human decision. AI may summarize but must not approve/reject.
5. **UAT provider activation** — evaluate deterministic prerequisites and activate UAT capacity only. Required resulting truth: `uat_ready`, `live=0`, `marketplaceLive=false`, `orderEligible=false`.
6. **Assignment and provider work** — assign the canonical booking to the eligible provider and use `/partner` canonical work orders. Provider must see only owned work. Exercise accept/decline/recovery as applicable.
7. **GPS / ETA / lateness recovery** — for an applicable non-Taxi service, start the booking/provider-scoped location session, submit accepted and stale/low-accuracy evidence, verify server receive time, create a sandbox/degraded ETA snapshot, exercise one idempotent predicted-late path and confirm customer/Ops recovery is separated from accountability. Missing GPS or map failure must never become automatic lateness/no-show truth.
8. **Replacement and accountability governance** — exercise capacity-safe replacement or explicit Ops escalation. Confirm GPS/ETA/performance signals cannot directly create money deductions. Where an accountability candidate is tested, require approved policy/evidence plus human review; rejected/exempted/disputed paths create no financial deduction. Any UAT financial adjustment remains non-live and Finance-governed.
9. **Service lifecycle and proof** — progress journey/arrival/start/proof/completion through canonical service APIs. Preserve lifecycle event and secure proof references; do not treat synthetic media as production proof.
10. **Operations exception/recovery** — inject at least one controlled decline/timeout/unavailable/late scenario. Confirm same booking lineage, capacity-safe replacement or visible Ops escalation and idempotent replay behavior.
11. **Finance, GST and accounting** — verify booked/collected/refunded/net truth; generate UAT invoice/accounting projection from approved effective configuration; exercise one correction/credit/debit-note path as applicable; verify tax-ledger/statutory package/accounting export/FIN-01 evidence boundaries. Missing approved Finance/tax configuration must fail as `configuration_required`. No live statutory filing, tax payment, bank instruction or production accounting post is required or permitted in ordinary UAT.
12. **Partner settlement / reconciliation** — verify commission/settlement readiness, approved-adjustment linkage and duplicate protection. No live payout/refund transmission is required for ordinary UAT.
13. **CRM and Revenue Mission** — verify canonical customer/lead/opportunity linkage, SLA/assignment governance, mission booked/collected/refund/net separation, productivity facts and leadership reporting. Pipeline/forecast must never count as achieved revenue.
14. **Unified case/escalation** — create or observe a customer-impacting exception/case, assignment, SLA/escalation and linked Finance/booking context. Preserve case/event IDs and confirm replay does not duplicate the case/action.
15. **AI engagement** — run web/app chat plus UAT WhatsApp/voice simulation through the shared orchestrator. Confirm governed tools, approval-gated high-impact actions, no production external delivery and fail-closed disconnected providers.
16. **Human handoff** — transfer the same canonical conversation to staff, confirm staff ownership pauses AI responses, then explicitly resume AI where permitted. Preserve thread/handoff IDs.
17. **Analytics/reporting** — verify reporting derives from canonical records, explicit CSAT remains distinct from inferred sentiment and unsupported response/resolution/causal-conversion metrics remain unavailable rather than fabricated.
18. **Hosted real-D1 60-booking swarm** — execute the Revenue Mission hosted Layer-2 60-booking swarm on the exact deployed UAT candidate and preserve assertion/reconciliation evidence. This is mandatory evidence; do not replace it with local/synthetic claims.

## Mandatory negative checks

- cross-customer and cross-provider ownership attempts are denied;
- provider cannot self-verify, self-approve or self-activate;
- AI cannot make final provider approval/rejection, execute legal acceptance or autonomously perform high-impact money/provider actions;
- duplicate booking/payment/refund/webhook/action replay does not double-create or double-post state;
- provider UAT activation never makes marketplace/order eligibility true;
- GPS capture is booking/provider scoped and invalid/stale/low-accuracy evidence cannot silently become trusted ETA or automatic guilt;
- GPS/ETA/provider-performance events cannot directly deduct provider money;
- Finance/tax/accounting actions fail closed when approved configuration is absent;
- statutory review/export acknowledgement is evidence only and cannot silently become a live filing or canonical external-accounting confirmation;
- legacy `/partner-app` synthetic status/earnings/activation is never used as UAT evidence;
- pipeline, forecast, demo/static KPIs and inferred sentiment are never promoted to canonical achieved truth;
- no page/API in this candidate claims `PRODUCTION READY = TRUE`.

## Evidence pack

For every PASS retain enough evidence for independent review: exact SHA, CI run, deployment reference, actor/role, request or screen reference, canonical record IDs, policy/config versions, audit/event IDs, booking/payment/refund/work-order/case/thread/handoff/report IDs, location-session/location-event/ETA/punctuality/recovery/accountability IDs where tested, invoice/adjustment/tax-package/export/close-evidence IDs where tested, device/browser details where relevant and defect IDs for failures.

Do not store raw identity-document bytes, sensitive home/facility media URLs, raw GPS streams, credentials or uncontrolled PII in issue comments or screenshots.

## Stop conditions

Stop and mark the run failed if live money moves unexpectedly, production communication is sent without explicit approval, authorization/ownership isolation fails, duplicate/replayed events alter canonical truth twice, provider activation becomes live/order-eligible, GPS evidence directly triggers an unreviewed financial consequence, AI performs an unauthorized high-impact action, Finance/statutory code posts to a live external system without explicit controlled-live approval, or the UAT surface claims production readiness.

## Closure rule

This cumulative candidate is **STAFF UAT CLOSED** only after every applicable step above is executed by the relevant human role, mandatory negative checks pass, the hosted real-D1 60-booking swarm is evidenced, defects are resolved/re-certified as needed and the evidence pack is complete.

Exact-head green CI alone means **engineering-ready**, not UAT-closed and not production-ready.
