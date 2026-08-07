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
- Partner Grooming job projection is protected by `bookings.view` plus exact provider ownership; customer booking creation/cancel/reschedule is protected by customer ownership for non-managing identities.
- Permanent closure CI runs web build/regressions/lint/artifact validation plus backend typecheck/tests.
- Expanded Grooming closure regression covers Customer -> Partner -> lifecycle/proof -> Finance, cancel/reschedule/refund, subscription reserve/consume/reverse, identity ownership and the UAT/live-integration boundary.
- Final closure CI passed web tests, lint, Sites artifact validation, backend typecheck and backend tests.

### Deliberately still UAT / not production-complete
- Partner UAT can still use exact `uat://proof/<booking>/<before|after>` proof references. Real registered media now has a secure trust-state gate, but external object storage and scanner integrations are not connected yet.
- Razorpay/RazorpayX, OTP, WhatsApp/SMS, Exotel, Maps/GPS, production object storage/scanning, payouts and accounting exports remain disconnected.
- The application-layer identity binding and ownership model is implemented, but the production customer/provider OTP/session authentication adapter that supplies verified identity subjects is not yet connected.
- Legacy email ownership-link tables remain temporarily as migration fallback while canonical identity bindings are introduced.
- Partner Home, Earnings, Calendar and some surrounding dashboard statistics remain prototype/fixture content even though Grooming Bookings is canonical.
- GST/tax calculation is not production tax logic; UAT invoices currently record booking gross/net without the final tax engine.
- The per-booking subscription ledger now reserves, consumes and reverses usage; subscription plan commercial values are configurable and frozen per purchase, while deeper production freeze/extension/expiry operations still require integration.
- Real-device UAT, employee pilot, one-zone Bengaluru pilot, domain cutover, monitoring, backups and support SOP remain launch gates.
- External integrations must be added one at a time in sandbox and verified before production credentials are enabled.

## Protected historical customer demo data — 7 Aug 2026

**Status: PRIVATE DEMO COHORT PREPARED. PROTECTED IMPORT PATH CI-GREEN. DEPLOYED UAT DATABASE LOAD STILL REQUIRES THE CONTROL-PANEL IMPORT ACTION.**

Historical customer files were reviewed and converted into a protected Customer 360 demo cohort without committing raw customer PII into GitHub.

- Full enriched Customer 360 working import: 17,321 customer rows, with historical service/revenue/segment data and July 2026 Grooming activity merged where a customer could be matched.
- Recommended demo cohort: 4,304 customer rows — all 1,304 historical Grooming subscription customers plus 3,000 non-subscriber Grooming subscription targets.
- Demo cohort includes 3,214 repeat customers, 1,090 one-time customers and 4,043 contactable records.
- 400 demo-cohort customers have current activity enriched from the July Grooming master.
- Customer Data now tracks current customer type, approximate order count, current last service/dormancy, historical revenue, Grooming order count, historical subscription orders, subscription target score, latest Grooming package, pet breed, payment status, groomer/team and address/service-area data where available.
- Historical subscription orders prove that a customer previously bought a Grooming subscription, but do not prove the current remaining-session balance or exact expiry. Those records are explicitly marked `legacy_balance_pending_migration` rather than inventing a balance or due date.
- New platform subscriptions continue to use the canonical subscription ledger for exact reserve/consume/reverse and expiry state.
- Current activity/dormancy is recalculated from the current last-service date instead of trusting the stale imported `Days Since Last Service Today` column.
- Customer names/phones remain subject to role masking and routed-contact controls; provider-facing surfaces do not receive raw historical customer phone data.
- The two prepared CSVs are stored privately in the PawSpace file library, not in the source repository.

### Demo-data deployment boundary
The source branch can validate, transform and display the protected cohort, but the GitHub/files connectors do not have a direct write channel into the deployed D1 UAT database. To activate this cohort in the deployed Control demo, an authorized user must load the prepared demo CSV through `Control -> Customer data & contact -> Import protected customer data`.

## Production-readiness Gate 4 — commercial policy governance

**Status: ENGINEERING CLOSED IN OBSERVE MODE. BUSINESS SIGN-OFF PENDING. ENFORCEMENT OFF.**

The remaining Grooming commercial rules are now governed as versioned city/zone configuration instead of being scattered or permanently hard-coded.

- Grooming subscription price, session/credit count, validity value/unit, eligible pet types, service package mapping, max pets, credits per pet, family-wallet behavior, pause/grace days, renewal window, benefits/terms, active state and effective dates are configurable by city and optional zone.
- Subscription purchases retain a frozen configuration snapshot so later business changes do not rewrite existing customer wallets.
- Grooming cancellation cutoff, refund percentage before/after cutoff, reschedule cutoff, late-reschedule permission, maximum reschedules, reschedule fee type/value, no-show refund percentage, multi-pet maximum, multi-pet pricing mode and locked booking statuses are configurable by city/zone with effective dates, versions and audit history.
- Every new Grooming booking freezes the applicable commercial-policy version inside the canonical booking pricing snapshot.
- Cancellation and reschedule evaluate the frozen booking policy, not whatever policy happens to be current later.
- Commercial policy has explicit `observe` and `enforce` modes. `observe` is the default and preserves current UAT behavior while exposing the policy decision for validation. `enforce` must not be enabled until business values are signed off.
- Current Bengaluru seed values are behavior-preserving defaults only; they are not represented as final PawSpace commercial policy.
- Permanent regression verifies city/zone governance, per-booking policy freeze, observe-first behavior, refund calculation path and reschedule policy output.
- Clean permanent CI passed at commit `d5706b193dc93b81b870b5a56fdd78ecf422657f`: web tests, lint, Sites artifact validation, backend typecheck and backend tests.

### Business sign-off still required before enforcement
- Final Bengaluru cancellation cutoff.
- Refund percentages/fees inside and outside the cutoff.
- Final reschedule cutoff, maximum reschedule count and any reschedule charge.
- No-show refund/credit policy.
- Final multi-pet commercial rule and pricing behavior.
- Final subscription plan values per launch city/zone.
- Explicit approval to switch the approved city/zone policy from `observe` to `enforce`.

## Production-readiness Gate 5 — identity binding and ownership

**Status: APPLICATION OWNERSHIP MODEL CLOSED. PRODUCTION OTP/SESSION ADAPTER PENDING.**

- A canonical `identity_bindings` registry maps a verified principal to a PawSpace customer or provider subject, with identity source, principal type/key, subject ID, city, verification state, expiry, status and metadata.
- Bindings support verified/pending state, revocation and a dedicated audit history. Identity administration is protected by `users.manage`.
- Current workspace identities use normalized email principals. The same binding contract reserves `customer_otp` and `partner_otp` identity sources so the production auth adapter can supply opaque verified identity subjects without redesigning booking ownership.
- Existing `customer_identity_links` and `provider_identity_links` remain only as migration fallback while UAT records are transitioned.
- `requireCustomerOwnership` and `requireProviderOwnership` consult canonical verified active bindings first and retain staff/manage bypasses for legitimate operational booking-on-behalf work.
- A restricted `customer` role exists for controlled self-service UAT and only carries pricing/self-booking permission; ownership checks determine which customer record it can act on.
- Canonical booking creation resolves the authenticated actor and requires ownership of the submitted customer ID for non-managing identities.
- Customer cancel/reschedule uses the same customer-ownership guard.
- Partner Grooming job reads require both `bookings.view` and exact provider ownership; provider lifecycle and assignment accept/decline use exact provider ownership.
- Clean permanent CI passed at commit `702c5a51f7285273ecf5e9c75d7211a38bb16abb`: web tests, lint, Sites artifact validation, backend typecheck and backend tests.

### Remaining identity dependency
- Connect the production customer/provider OTP/session authentication layer to issue or resolve the verified identity subject used by the canonical binding registry.
- Migrate active legacy email bindings into the canonical registry and remove fallback only after UAT evidence confirms no orphaned customer/provider identities.
- Test revoked, disabled, mismatched, expired and cross-provider/cross-customer access on real authenticated sessions before pilot launch.

## Production-readiness Gate 6 — secure service media trust state

**Status: APPLICATION TRUST-STATE GATE CLOSED. OBJECT STORAGE + SCANNER INTEGRATION PENDING.**

- New real service-media records are non-synthetic and start as `pending_upload` with scan status `pending`; registration alone cannot make an asset trusted proof.
- Upload confirmation moves the asset to quarantine and still leaves scanning pending.
- Only an authorized clean scan result can move the asset to `ready`.
- A `media://asset/...` proof is accepted by the Grooming lifecycle only when booking, provider and proof-purpose ownership all match and the asset is clean, ready, active-retention and non-synthetic.
- Rejected, unscanned, not-uploaded, revoked, wrong-booking, wrong-provider and wrong-purpose assets cannot satisfy the completion proof gate.
- Media state changes have dedicated service-media events plus security audit records.
- Partner UAT continues to use exact synthetic `uat://proof/...` references until the external storage/scanner adapter is connected; those synthetic references remain clearly separated from registered real-media assets.
- External object storage, signed upload/download URLs, malware/content scanning callbacks and production retention/deletion jobs remain integration work.
- Clean permanent CI passed at commit `870350bb5f68f88b5c82744241857e4151b67d23`.

## Closure sequence status
1. ✅ Import recovered Site v67 source without redesigning it.
2. 🟡 Catalogue, subscription and booking-change policy governance/versioning are implemented and CI-green; final Bengaluru business values/sign-off and switch from `observe` to `enforce` remain.
3. ✅ Canonical booking aggregate established for Grooming UAT.
4. ✅ Main customer booking confirmation connected with scheduling and idempotency.
5. ✅ Customer, pet, schedule/provider, work-order and payment state persisted for the UAT path.
6. ✅ Partner Grooming Bookings, Team Operations and Team Finance project the canonical transaction.
7. ✅ UAT provider lifecycle connected through completion; governed capacity/acceptance/recovery are implemented, while production GPS remains launch work.
8. ✅ Completion proof gate plus secure real-media trust-state/ownership checks are implemented; object storage/scanner integration remains.
9. ✅ UAT payment reconciliation, policy-aware cancellation refund case and invoice state implemented; gateway/GST/accounting remain production integrations.
10. ✅ Per-booking subscription reserve, consume and cancellation reversal implemented; subscription commercial configuration is versioned/frozen per purchase; deeper production subscription freeze/extension/expiry operations remain.
11. ✅ Canonical customer/provider identity binding and application ownership enforcement are implemented and CI-green; production OTP/session adapter and legacy-binding migration remain launch integration work.
12. ⏳ External integrations remain deliberately disconnected pending UAT approval.
13. 🟡 Automated internal closure regression passes; real-device UAT, employee pilot and one-zone Bengaluru pilot remain.

## Next phase — production readiness
Do not add major new product modules. Convert the closed internal UAT path into a controlled production candidate in this order:

1. 🟡 Grooming catalogue/subscription/change-policy governance infrastructure is complete in `observe` mode; finalize and sign off Bengaluru commercial values, then enable `enforce` only after approval.
2. ✅ Customer/provider identity binding and application ownership enforcement are implemented; production OTP/session adapter remains under integration step 5.
3. 🟡 Secure service-media trust state is implemented; connect object storage, signed upload flow and scanning before replacing Partner synthetic UAT proof.
4. Integrate Razorpay payment/refund webhooks and reconciliation in sandbox.
5. Integrate OTP/session authentication plus WhatsApp/SMS, then Exotel, then Maps/GPS.
6. Add production GST/invoice/accounting rules and payout flow.
7. Complete subscription-master freeze/extension/expiry integration, including reconciliation of legacy subscription balances before showing exact legacy sessions remaining/expiry.
8. Run real-device cross-role UAT and exception testing.
9. Employee pilot -> invited beta -> one-zone Bengaluru pilot.
10. Only after sign-off: production domain cutover, monitoring, backups and launch.

## Rule
Protected historical customer data may be used in authorized isolated UAT with masking/audit controls. Do not connect live operational customer feeds, live payment/communication integrations or production credentials until the shared API-backed transaction passes synthetic regression, idempotency, role/ownership and reconciliation tests and the corresponding integration has passed sandbox UAT.
