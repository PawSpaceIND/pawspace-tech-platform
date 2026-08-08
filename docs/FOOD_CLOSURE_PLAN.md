# PawSpace Food engineering closure

## Status

**Engineering target:** Food Gates 1–5 closed for internal UAT on one canonical order path.

This is not a production-launch declaration. Catalogue prices, inventory, lots, delivery and money remain explicitly UAT-only or configuration-gated until production systems and policies are approved.

## Gate 1 — Catalogue + canonical order

- Server-owned explicit UAT catalogue and UAT inventory seed.
- 15-minute server quote; sandbox-deferred payment, ₹0 due at order creation.
- Coupons disabled; delivery fee is ₹0 only because production delivery-fee policy is not configured.
- One canonical Food order, line, inventory reservation and payment intent.
- Production SKU master/live inventory is not claimed.

## Gate 2 — Fulfilment

- Fulfilment acceptance → exact-SKU UAT lot pick → pack/consume reservation → sandbox dispatch → UAT delivery handover.
- UAT lots are explicitly not production lot traceability.
- Delivery adapter and OTP are not connected.
- Delivery creates payment-due; it never fabricates capture.
- Stock issue opens Operations recovery; SKU substitution and price changes are blocked.

## Gate 3 — Finance

- Customer cancellation is request-only.
- Packed/dispatched order requires Operations fulfilment review before Finance cancellation.
- Refund amount is explicit and cannot exceed sandbox-paid order value.
- Still-reserved inventory is released on approved cancellation.
- Unique sandbox payment/refund references.
- Supplier settlement waits for delivered + sandbox-paid order.
- COGS, supplier settlement policy and tax/GST remain configuration/rule pending.
- Reconciliation exposes due/paid/refund/net/COGS/supplier/tax truth.

## Gate 4 — Private proof + food quality

- Short-lived hashed media grants and opaque storage IDs.
- Exact order/SKU/UAT-lot media binding without changing shared media schema.
- JPEG/PNG/WebP, size, SHA-256, scan, private access and retention gates.
- Package and delivery proof retain explicit non-production lot truth.
- Quality/food-safety incidents preserve order and do not automatically refund or alter supplier settlement.
- Customer acknowledgement has no money authority.
- Production object storage/scanner remains disconnected.

## Gate 5 — Operations + stock recovery

- One canonical Food Operations exception queue.
- Exceptions include stock recovery, fulfilment overdue, quality incidents, cancellation/refund/payment, media and supplier/tax blockers.
- Stock recovery can resume only the exact ordered SKU and zone with enough UAT stock.
- Same order ID, quantity, unit price and payment history are preserved.
- Silent substitution and repricing are prohibited.
- Quality incident resolution stays in proof governance; payment/refund/COGS/supplier/tax authority stays in Finance.

## Cross-role UAT contract

One canonical Food order is shared by:

1. Customer catalogue/order and order management.
2. Operations fulfilment and stock recovery.
3. Operations proof/quality workspace.
4. Finance payment, cancellation/refund, supplier-settlement readiness and reconciliation.

## Explicitly not production ready

Remaining launch dependencies include:

- Approved production SKU master, product content and commercial prices.
- Live warehouse/store inventory and reservation integration.
- Production batch/lot/expiry traceability and food-quality compliance rules.
- Approved delivery-fee, serviceability and fulfilment-SLA policy.
- Production delivery/courier partner and tracking.
- Production delivery handover/OTP policy where required.
- Production object storage and malware/content scanner.
- Live payment/refund execution and approved payment timing policy.
- Approved COGS, supplier commercials/settlement and GST/tax/accounting rules.
- Final customer identity and delivery-address ownership mapping.
- Monitoring, alerting, backups, production domains and support SOP.
- Real-device UAT, employee pilot and controlled Bengaluru-zone pilot.

## Merge gate

Merge only after the exact current branch tree passes build, full regression, lint, Sites artifact validation and backend typecheck/tests. Stacked dependencies must already be present on `main` before the Food PR is merged.
