# PawSpace Grooming Integration Closure

## Goal
Close one real Grooming transaction end-to-end using a single canonical booking record:

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

The source export README records 27/27 web tests and 28/28 backend tests passing at export time, plus lint/type-check success. The deployed Site was not modified by the export.

## Four-front-door architecture — locked
Do not create new standalone command centres. Preserve four unified experiences backed by one authentication system, one canonical database/event model and shared APIs:

1. `pawspace.in` — Customer experience
2. `partners.pawspace.in` — Partner/provider experience
3. `team.pawspace.in` — Employee Team OS
4. `control.pawspace.in` — Founder/super-admin governance

Existing CRM, Booking Command Center, CX, Operations, Finance, HR, Marketing, integrations, security and reporting modules remain routes/modules inside the correct Team or Control shell. Legacy URLs may remain temporarily for UAT redirects.

## UAT closure slice — 7 Aug 2026
The first canonical Grooming UAT slice is now implemented on `grooming-integration-closure`.

### Completed in this slice
- Recovered Site v67 source is fully imported into GitHub.
- Persistent CI is active for web tests/build/lint/artifact validation and backend build/typecheck/tests.
- Main customer Grooming confirmation now reserves the UAT schedule and creates an idempotent canonical booking before showing success.
- Existing mobile Grooming flow continues to use the same scheduling + canonical booking APIs.
- Canonical provider lifecycle API supports acceptance, on-the-way, arrival, service start, proof, completion and payment reconciliation.
- Completion is blocked until before proof, after proof and a completion checklist exist.
- Completion creates an issued UAT invoice, records subscription consumption when applicable and creates a repeat-booking task.
- Shared Partner UAT controls now advance the canonical server record rather than only browser state; the browser ledger remains as a visible UAT projection.
- Shared Accounts UAT control now reconciles the canonical booking payment.
- `team.pawspace.in/finance` now has a Grooming ledger projection for booking, payment, invoice, collected/receivable and subscription usage.
- Temporary one-time import/patch workflows were removed after use.
- Latest verified base before the customer patch passed web CI, backend CI, lint and artifact validation; the customer patch itself separately passed all 27 web tests, lint and artifact validation before commit.

### Deliberately still UAT / not production-complete
- Provider proof references used by the test-sync completion action are synthetic `uat://` references; secure media upload/storage is not connected yet.
- Razorpay/RazorpayX, OTP, WhatsApp/SMS, Exotel, Maps/GPS, production media storage, payouts and accounting exports remain disconnected.
- The Partner home still contains fixture/dashboard content around the canonical synchronized record; it needs full canonical job-list projection.
- Some CRM/Ops/customer actions such as reschedule/cancel remain browser-local or use operational case APIs instead of a single canonical state transition.
- Production customer/provider authentication, provider ownership checks and lifecycle RBAC enforcement remain launch gates.
- Subscription reservation/reversal/expiry needs to be tied to the existing subscription master; this slice records canonical consumption on completion but does not replace the full subscription engine.
- GST/tax calculation is not yet production tax logic; UAT invoices currently record the booking gross/net amount without live tax computation.

## Closure sequence status
1. ✅ Import recovered current source without redesigning it.
2. ⏳ Freeze Grooming catalogue, pricing, validity, add-ons and multi-pet rules as governed versioned data.
3. ✅ Establish canonical booking aggregate for the Grooming UAT path.
4. ✅ Connect main customer booking confirmation to canonical scheduling + booking with idempotency.
5. ✅ Persist customer, pet, booking, slot/provider decision and payment state for the UAT booking path.
6. 🟡 Team Finance and shared Partner/Accounts projection connected; remaining CRM/Ops/Partner fixture views still need conversion.
7. 🟡 Provider lifecycle connected through completion; production availability/ownership/GPS/rerouting still remains.
8. ✅ Completion proof gate implemented for UAT; production secure media storage remains.
9. 🟡 Payment reconciliation + invoice state implemented for UAT; gateway/refund/GST/accounting integrations remain.
10. 🟡 Subscription consumption + repeat task implemented; reservation/reversal/expiry/master-ledger integration remains.
11. ⏳ Complete RBAC/ownership checks, audit enforcement and sensitive-data boundaries on all new lifecycle actions.
12. ⏳ Add external integrations one at a time in sandbox, then production credentials after UAT approval.
13. ⏳ Pass cross-role canonical regression, real-device UAT, employee pilot and one-zone Bengaluru pilot.

## Immediate next milestone
Remove the remaining browser-local/fixture handoffs from the Grooming path in this order:

1. Partner job list/detail -> canonical work order and lifecycle bundle.
2. Customer reschedule/cancel -> canonical scheduling/booking transition and credit/payment reversal rules.
3. Ops/CRM screens -> canonical booking/event projection.
4. Subscription master -> reserve/consume/reverse/expire against one ledger.
5. Secure lifecycle permissions + provider ownership checks.
6. Cross-role automated test proving one booking from customer confirmation through invoice/finance/repeat task.

## Rule
Do not connect live customer data or live payment/communication integrations until the shared API-backed transaction passes synthetic regression, idempotency, role/ownership and reconciliation tests.
