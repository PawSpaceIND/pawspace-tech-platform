# Claude Independent PRE-LAUNCH Validation Brief

## Mission

Act as an independent adversarial release tester for PawSpace. Do **not** trust prior ChatGPT conclusions, CI summaries, screenshots, comments or stated PASS results. Attempt to falsify them from source, tests and UAT evidence.

Repository: `PawSpaceIND/pawspace-tech-platform`
PR: current Revenue Mission reconciliation draft PR
Branch: `agent/revenue-mission-reconciliation`

Always pin your report to the exact commit SHA you actually tested. If the branch head changes during your review, stop and re-run against the new exact head before issuing a closure result.

## Required environment

- Node.js `>=22.13.0`
- repository access to the exact PR head
- no production credentials
- for hosted Layer-2 testing: authenticated PawSpace UAT/preview access with a role allowed to `launch.view` / `launch.manage`, D1 binding `DB`, and the explicitly published PR checkpoint
- never trigger live payments, live marketing/messages/calls, or uncontrolled provider side effects

## Layer 1 — independent code/build certification

From a clean checkout of the exact PR head, run:

```bash
npm ci
npm test
npm run lint
npm run validate:artifact
cd backend
npm ci
npm run typecheck
npm test
```

Do not change expected behaviour merely to make tests green.

Specifically inspect `tests/prelaunch-booking-swarm.test.mjs`. It must exercise at least 80 deterministic attempts: 60 supported-service lifecycle scenarios across Grooming, Dog Training, Boarding and Pet Sitting, plus 20 deferred-service/gating attempts. Verify replay/idempotency, cancellations/refunds, SLA delay, consent suppression, integration degradation, Finance↔Revenue net truth and no live-provider side effects.

## Security and authority checks

Independently inspect `lib/api-gateway.ts` and each corresponding route. Verify explicit shared-gateway and route-level permissions agree for:

- `/api/revenue-mission-control`
- `/api/lead-assignment-governance`
- `/api/lead-sla-governance`
- `/api/revenue-opportunity-governance`
- `/api/sales-productivity-governance`
- `/api/revenue-mission-command-center`
- `/api/revenue-leadership-reporting`
- `/api/prelaunch-booking-swarm`

Attempt to find privilege downgrades, body-action bypasses, cross-origin write bypasses, unauthenticated mutations, customer-ownership gaps, or a fallback permission that is weaker than the route's intended authority.

Search the PR for any path that can return or render `productionReady:true` for Revenue/pre-launch UAT. Any such unsupported claim is a blocker.

## Canonical booking invariants

Inspect `app/api/canonical-bookings/route.ts` and supporting service routes. Try to disprove each invariant:

1. Supported canonical booking services are exactly the closure-supported set: Grooming, Dog Training, Boarding, Pet Sitting.
2. Booking idempotency key is unique.
3. Schedule group is unique.
4. One canonical booking cannot silently create multiple work orders or multiple booking-payment rows.
5. Training and Boarding require their server-governed commercial quote/configuration.
6. Provider identity must agree with the scheduling decision/reservations.
7. Unsupported Walking must fail rather than appear as a completed canonical booking.
8. Replayed requests must not double-credit Finance or Revenue.

Report the exact source location for every invariant you accept or reject.

## Revenue and Finance reconciliation

Independently verify that booked, collected, refunded and net-collected truth stay distinct. Confirm pipeline/forecast/opportunity estimates cannot credit achieved revenue.

Inspect the Revenue Mission backfill/event ledger, booking payments, reconciliation records, refund cases and Mission Command Center. Challenge:

- duplicate booking/payment/refund replay;
- partial and full refunds;
- cancelled/unpaid bookings;
- failed report delivery;
- opportunity conversion/customer mismatch;
- synthetic/legacy CRM leaderboard records;
- report metric-definition and mission-version immutability.

A mismatch between Finance refund truth and Revenue Mission refund truth is a blocker.

## Layer 2 — hosted real-D1 swarm

Only after the exact tested commit is published to the PawSpace UAT/preview Site, open `/prelaunch/layer2-swarm` as an authorized UAT user.

Run **Layer 2 — 60 real bookings**. The protected runner must:

- create 15 UAT D1 bookings each for Grooming, Dog Training, Boarding and Pet Sitting;
- replay all booking requests and prove `duplicatePrevented=true`;
- use `uat_sandbox` money only;
- create/reconcile canonical customer, booking, provider work-order and payment identity;
- inject controlled delayed-service events;
- inject controlled completed refunds;
- backfill isolated Revenue Missions and reconcile booked/collected/refunded truth;
- reject hostile cross-origin writes;
- reject an unsupported Walking canonical booking;
- perform no live payment/message/call side effects.

Do not accept a Layer-2 PASS if any blocker assertion is false. Preserve the run ID and the complete final assertion summary as evidence.

A CRM projection warning is not automatically a blocker: determine whether direct customer bookings are designed to create CRM lead rows. If the product contract requires it and the projection is absent, elevate it to a defect with evidence.

## Hosted surface checks

On the exact published UAT checkpoint verify these routes load without 404 and display the intended UAT build:

- `/business`
- `/prelaunch`
- `/mobile-app`
- `/partner-app`
- `/crm`
- `/control`
- `/team`
- `/team/revenue-mission`
- `/team/finance`
- `/team/people`

Check Control Center at desktop and narrow widths. Confirm the left navigation/footer remains inside a usable scroll container and does not bleed into page content.

Confirm the Partner App remains one app/interface with role switching; do not require separate Groomer/Trainer/Host/Sitter/Walker products for closure.

## Failure injection / tester mindset

Actively look for failures rather than sampling happy paths. At minimum challenge:

- duplicate/replayed requests;
- same customer with repeat bookings;
- multi-pet booking;
- refund after collection;
- cancelled/unpaid booking;
- provider cancellation;
- SLA delay/breach;
- consent/opt-out suppression;
- integration unavailable/degraded;
- report delivery failure;
- unauthorized role;
- hostile Origin on write requests;
- unsupported/deferred service;
- stale or mismatched data between customer, CRM, Ops, Finance and Revenue views.

For every defect give reproduction steps, exact request/record IDs where available, expected result, actual result, severity and source/test evidence.

## Closure rubric

Return exactly one of these engineering/UAT conclusions:

- `INDEPENDENT CODE/CI PASS` — clean build/test/security/source review passed, but hosted Layer 2 or staff UAT is still pending.
- `READY FOR STAFF UAT` — independent code/CI passed **and** hosted Layer 2 blocker assertions passed on the exact published commit.
- `FAIL — BLOCKERS FOUND` — include the blocker list and do not soften it.

Do **not** return `UAT CLOSED` unless actual manual staff UAT evidence is supplied and reviewed. Do **not** return `PRODUCTION READY` based on this PR alone; integrated regression, external integration verification, device/pilot evidence and company launch approvals remain separate gates.

## Required report

Your final report must include:

- exact commit SHA tested;
- commands executed and pass/fail counts;
- Layer-1 swarm result;
- Layer-2 run ID and assertion result, if executed;
- security/RBAC findings;
- Finance↔Revenue reconciliation result;
- surface/route result;
- all defects with severity;
- one closure conclusion from the rubric above.
