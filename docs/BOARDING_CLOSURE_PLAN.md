# PawSpace Boarding closure plan

Status date: 2026-08-07

## Closure principle

Boarding is hardened as one canonical transaction across Customer, Host, Team Operations and Finance before any live lead, vendor, messaging, storage or payment integration is enabled. Engineering closure does not equal production launch approval.

## Gate 1 — commercial truth and canonical booking

**Status: CLOSED — application/UAT contract.**

- Server-owned Boarding catalogue and expiring quotes.
- Verified host eligibility, species, vaccination and exact-zone checks.
- Exactly one continuous stay reservation per Boarding booking.
- Full prepaid UAT only; no invented split-payment or coupon policy.
- Canonical Boarding stay is created against the canonical booking and host.

## Gate 2 — stay lifecycle, capacity and recovery trigger

**Status: CLOSED — application/UAT contract.**

- Host acceptance, decline, unavailable and no-show states are canonical.
- Capacity locks enforce exact stay overlap, pet capacity and one-family rules.
- Care Card is required before check-in.
- Check-in, care updates and checkout are recorded on the canonical stay.
- Extension requests preserve the paid stay window until a fresh commercial quote is approved.
- Host failures preserve the booking and open an Operations recovery case.

## Gate 3 — cancellation, date changes, refunds and settlement readiness

**Status: CLOSED — application/sandbox contract; business policy still required.**

- Cancellation remains `policy_review_required` until an approved Boarding policy exists.
- Refund values are explicit staff-approved amounts; no percentage is invented.
- Refund ledger is sandbox-only and replay resistant.
- Date changes require fresh server quote and exact host capacity.
- Lower-priced changes are blocked until refund/credit policy is approved.
- Host settlement ledger exposes base payout, add-ons, travel, incentives, penalties and cash adjustments without inventing amounts.
- Host payout remains `rule_pending`; tax remains `configuration_required`.

## Gate 4 — service proof, medication and incidents

**Status: CLOSED — application trust-state contract; external media delivery pending.**

- Private media metadata, short-lived upload grants, MIME/size/checksum validation.
- Exact booking/provider/purpose ownership.
- Quarantine, scan, ready, retention and revoke states.
- Medication evidence requires a ready Care Card and clean exact-purpose proof.
- Attention, urgent and emergency incidents have canonical records, Ops state and customer acknowledgement.
- Incidents never automatically issue refunds or alter provider payout.
- Generic care-event path cannot bypass governed medication/photo/incident proof.

## Gate 5 — Operations exception control and cross-role closure

**Status: CLOSED — engineering/UAT contract, subject to green CI evidence. PRODUCTION READY = FALSE.**

- One Boarding Operations queue projects canonical stay, booking, payment, recovery, incidents, finance, settlement, proof/media and reconciliation state.
- Exceptions are deterministic: host recovery, emergency/urgent/care incident, cancellation policy review, date-change quote, pending refund, blocked media, missing Care Card, overdue check-in/out and settlement not ready.
- Recovery candidates must pass exact stay eligibility: active/live profile, same city/zone, Boarding service/zone, home/KYC/background verification, all pet species, verified vaccinations, unavailability, capacity and one-family constraints.
- Replacement assignment preserves the same booking and paid stay window while updating the canonical stay, booking, work order and scheduling records and issuing a new acceptance offer.
- Replacement host must accept before Operations can close recovery.
- Operations notes are idempotent and auditable.
- Specialized authority is not duplicated: incident resolution remains in Boarding proof governance; cancellation/refund/date-change/settlement remains in Boarding Finance governance.
- Customer, Host, Team Operations and Finance continue to reference the same canonical booking/stay IDs.

## Production blockers intentionally left open

These are not engineering loopholes and must not be guessed or activated without approved configuration and external UAT:

- Object storage and signed private media delivery.
- Malware/image scanning adapter and callback execution.
- Live WhatsApp/push delivery and delivery reconciliation.
- Live payment/refund execution and production payment credentials.
- Boarding cancellation/refund commercial policy.
- Long-stay/split-payment policy, if the business chooses to support it.
- GST/tax treatment and invoice/accounting policy.
- Host payout formula, travel allowance, incentives, penalties and approval workflow values.
- Production monitoring, backups/restore proof, support runbook, production domains and real-device/browser UAT.

## Launch rule

Do not connect production credentials, live customer/vendor feeds, live communications, live payments/refunds or host payouts merely because Gates 1–5 are engineering-closed. First complete synthetic regression, external sandbox execution, approved business policies, security/privacy review and controlled real-device UAT. Then authorize a monitored pilot explicitly.
