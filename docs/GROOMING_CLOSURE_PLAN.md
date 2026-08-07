# PawSpace Grooming Integration Closure

## Goal
Close one Grooming transaction end-to-end using a single canonical booking record:

Customer -> Pet -> Package -> Slot -> Booking -> Payment -> Assignment -> Provider -> Service Proof -> Completion -> Invoice -> Finance -> Repeat/Subscription

## Source recovery status
The latest deployed prototype source has been recovered and checksum-verified.

- Source archive: `pawspace-tech-platform-current-source.zip`
- Deployed Site version: `67`
- Source commit provenance: `21cdff1509e7939b31dad760d24a2d6317504d01`
- SHA-256: `913876bed301e3ed03da656071219f1ab0b28c0b69b7a7056802177197fafcd1`
- Export date: 7 Aug 2026
- Customer, Partner, Team and Control experiences included
- Frontend, hosted API routes, standalone backend, D1/Drizzle migrations, RBAC/security helpers, tests, assets, mobile source and deployment configuration included
- Secrets excluded; `.env.example` files included
- Export README included

The deployed Site was not modified by the source export or this closure branch.

## Four-front-door architecture — locked
Do not create new standalone command centres. Preserve four unified experiences backed by one authentication system, one canonical database/event model and shared APIs:

1. `pawspace.in` — Customer experience
2. `partners.pawspace.in` — Partner/provider experience
3. `team.pawspace.in` — Employee Team OS
4. `control.pawspace.in` — Founder/super-admin governance

Existing CRM, Booking Command Center, CX, Operations, Finance, HR, Marketing, integrations, security and reporting modules remain routes/modules inside the correct Team or Control shell. Legacy URLs may remain temporarily for UAT redirects.

## Internal UAT transaction closure — 7 Aug 2026

**Status: CLOSED FOR INTERNAL UAT. NOT PRODUCTION-CLOSED.**

The Grooming transaction path now uses one canonical booking/work-order/payment/event record across the customer, Partner, Team Operations and Team Finance experiences.

### Closed internal UAT path
- Main customer Grooming confirmation reserves the UAT schedule and creates an idempotent canonical booking before showing success.
- Customer, pet, schedule group, provider work order and payment state are persisted server-side for the UAT path.
- Subscription bookings create a reserved usage entry at booking creation.
- Customer reschedule keeps the same booking and schedule group, revalidates assigned-provider capacity, updates the canonical schedule/work order and records a lifecycle event.
- Customer cancellation releases scheduling capacity, cancels the work order, reverses an unconsumed subscription reservation and creates a refund case when a captured payment must be returned.
- Partner Grooming Bookings now reads canonical provider work orders instead of the previous hard-coded Grooming job list.
- Partner job detail projects canonical customer, masked contact, pets, payment, proof, invoice and lifecycle timeline.
- Provider lifecycle supports acceptance, on-the-way, arrival, service start, proof and completion.
- Completion is blocked until before proof, after proof and a completion checklist exist.
- Completion creates an issued UAT invoice, consumes the reserved subscription session when applicable and creates a repeat-booking task.
- Team Operations Booking Command Center reads canonical booking/work-order/payment/event data and remains the consolidated Ops front door.
- Team Finance projects canonical Grooming payment, invoice, collected/receivable and subscription usage state.
- Partner Grooming job projection is protected by the existing `bookings.view` RBAC permission; customer cancel/reschedule additionally checks booking ownership by customer ID.
- Permanent closure CI runs web build/regressions/lint/artifact validation plus backend typecheck/tests.
- Expanded Grooming closure regression covers Customer -> Partner -> lifecycle/proof -> Finance, cancel/reschedule/refund, subscription reserve/consume/reverse and the UAT/live-integration boundary.
- Final closure CI passed web tests, lint, Sites artifact validation, backend typecheck and backend tests.

### Deliberately still UAT / not production-complete
- Provider proof references in UAT can still be synthetic `uat://` references; secure production media upload/storage is not connected.
- Razorpay/RazorpayX, OTP, WhatsApp/SMS, Exotel, Maps/GPS, production media, payouts and accounting exports remain disconnected.
- Production customer authentication/identity binding is not yet the final customer-auth implementation.
- Partner provider-identity-to-provider-ID ownership enforcement still needs production identity mapping; RBAC alone is not the final provider-ownership gate.
- Partner Home, Earnings, Calendar and some surrounding dashboard statistics remain prototype/fixture content even though Grooming Bookings is canonical.
- GST/tax calculation is not production tax logic; UAT invoices currently record booking gross/net without the final tax engine.
- The per-booking subscription ledger now reserves, consumes and reverses usage, but full subscription-master freeze/extension/expiry rules still need production integration.
- Real-device UAT, employee pilot, one-zone Bengaluru pilot, domain cutover, monitoring, backups and support SOP remain launch gates.
- External integrations must be added one at a time in sandbox and verified before production credentials are enabled.

## Closure sequence status
1. ✅ Import recovered Site v67 source without redesigning it.
2. 🟡 Grooming catalogue/pricing rules exist; production governance/version freeze still requires business sign-off.
3. ✅ Canonical booking aggregate established for Grooming UAT.
4. ✅ Main customer booking confirmation connected with scheduling and idempotency.
5. ✅ Customer, pet, schedule/provider, work-order and payment state persisted for the UAT path.
6. ✅ Partner Grooming Bookings, Team Operations and Team Finance project the canonical transaction.
7. ✅ UAT provider lifecycle connected through completion; production GPS/provider-identity controls remain launch work.
8. ✅ Completion proof gate implemented; production secure media remains.
9. ✅ UAT payment reconciliation, cancellation refund case and invoice state implemented; gateway/GST/accounting remain production integrations.
10. ✅ Per-booking subscription reserve, consume and cancellation reversal implemented; production subscription-master expiry/freeze/extension remains.
11. 🟡 Existing RBAC is applied to Partner projection and customer ownership is enforced for booking changes; production provider ownership/identity enforcement remains.
12. ⏳ External integrations remain deliberately disconnected pending UAT approval.
13. 🟡 Automated internal closure regression passes; real-device UAT, employee pilot and one-zone Bengaluru pilot remain.

## Next phase — production readiness
Do not add major new product modules. Convert the closed internal UAT path into a controlled production candidate in this order:

1. Finalize Grooming catalogue, pricing, validity, cancellation/reschedule/refund and multi-pet rules with business sign-off.
2. Implement final customer identity and provider identity/ownership mapping.
3. Replace synthetic proof references with secure media upload/storage and access controls.
4. Integrate Razorpay payment/refund webhooks and reconciliation in sandbox.
5. Integrate OTP/WhatsApp/SMS, then Exotel, then Maps/GPS.
6. Add production GST/invoice/accounting rules and payout flow.
7. Complete subscription-master freeze/extension/expiry integration.
8. Run real-device cross-role UAT and exception testing.
9. Employee pilot -> invited beta -> one-zone Bengaluru pilot.
10. Only after sign-off: production domain cutover, monitoring, backups and launch.

## Rule
Do not connect live customer data or live payment/communication integrations until the shared API-backed transaction passes synthetic regression, idempotency, role/ownership and reconciliation tests and the corresponding integration has passed sandbox UAT.
