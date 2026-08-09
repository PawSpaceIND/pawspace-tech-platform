# PawSpace Training closure plan

Status date: 2026-08-08

## Closure principle

Training is treated as one canonical programme made of canonical sessions across Customer, Trainer, Team Operations and Finance. Engineering closure does not activate production payments, media storage, messaging or tax/payout policy.

## Gate 1 — commercial truth and canonical programme

**Status: CLOSED — application/UAT contract.**

- Server-owned Training catalogue and expiring quotes.
- Canonical booking consumes one server quote and materializes one Training programme.
- Programme session count, package amount, upfront amount and requirements are server-governed.
- Trainer roster is projected from governed provider capacity rather than browser fixtures.
- Customer booking and trainer choice remain tied to the canonical booking/scheduling identity.

## Gate 2 — session lifecycle and trainer ownership

**Status: CLOSED — application/UAT contract.**

- Each programme session is a canonical `training_sessions` record tied to the programme, booking, trainer and scheduling reservation.
- Trainer actions require provider ownership.
- Session start, evidence, completion, no-show, reschedule and replacement are explicit governed transitions.
- Session recovery preserves the programme and booking rather than creating a competing record.
- Customer and Trainer projections read the same session ledger.

## Gate 3 — cancellation, reschedule, Finance and reconciliation

**Status: CLOSED — application/sandbox contract; production policy still required.**

- Customer cancellation/reschedule requests use governed APIs and customer booking authority.
- Completed-session consumption and earnings are preserved through later cancellation.
- Refund values and provider settlement are never invented in the browser.
- Finance invoices, completed-session earnings and provider payout readiness are canonical.
- Training reconciliation verifies programme/session/reservation counts, quote consumption, booking/payment/invoice amounts and completed-session earnings.
- Tax and live payout execution remain configuration/policy gated.

## Gate 4 — session evidence and media trust state

**Status: CLOSED — application trust-state contract; external storage/scanning pending.**

- Training evidence is bound to the exact session, programme, booking and provider.
- Only governed image MIME types, bounded sizes and valid SHA-256 checksums are accepted.
- Duplicate evidence is idempotently detected.
- Media is prepared with opaque IDs and pending storage/scan state.
- Provider ownership is required to prepare/read Trainer evidence.
- Proof is not considered ready until storage and malware/image scanning are connected and return a clean ready state.

## Gate 5 — Operations and cross-role closure

**Status: CLOSED — engineering/UAT contract, subject to green CI evidence. PRODUCTION READY = FALSE.**

- Team Operations reads canonical programmes, sessions, scheduling reservations and recovery cases.
- Trainer capacity comes from the shared provider-capacity source.
- Finance reconciliation and provider earnings remain specialist canonical modules rather than being duplicated in Operations.
- Customer, Trainer, Operations and Finance reference the same booking/programme/session IDs.
- Gateway permissions explicitly protect Training commercial, programme, session, media, cancellation, Ops, Finance, provider earnings and reconciliation routes.

## Production blockers intentionally left open

- Production object storage and signed private evidence delivery.
- Malware/image scanning callback execution.
- Live WhatsApp/SMS/push/telephony delivery.
- Production payment/refund/payout credentials and execution.
- Final Training cancellation/no-show/refund policy.
- Final trainer payout/commission/incentive/penalty formula.
- GST/tax/invoice/accounting configuration.
- Final customer/provider identity provisioning and real-device UAT.
- Monitoring, backups/restore proof, domains and support SOP.

## Launch rule

Do not connect production credentials or live customer/provider feeds merely because the Training engineering path is closed. First complete synthetic regression, approved business policies, security/privacy review, external sandbox execution and controlled real-device/pilot UAT.