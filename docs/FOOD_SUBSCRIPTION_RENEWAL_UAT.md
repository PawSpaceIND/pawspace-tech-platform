# Food subscription renewal — UAT contract

Status: ENGINEERING IMPLEMENTATION FOR UAT. PRODUCTION READY = FALSE.

## Requested customer journey

A Food subscription is linked to an existing canonical Food order. Its renewal interval is explicit on the subscription; the platform does not invent a hidden cadence. When `next_renewal_at` is due, the renewal engine creates exactly one cycle, snapshots the approved Food unit price, verifies UAT inventory availability, creates an idempotent payment-link record and queues a transactional payment-link message through the canonical communications outbox.

There is **no silent recurring charge**. The current payment-link provider is `internal_uat`, `externalPaymentExecution = false`, and live money remains disabled. A production scheduler and production payment-link provider are launch dependencies.

## Paid renewal behavior

A canonical Finance payment confirmation changes the renewal to `paid_invoiced`, stores one unique payment reference, issues one UAT renewal invoice, advances `next_renewal_at` by the subscription's configured interval, and queues two idempotent transactional communications:

1. `food_subscription_renewal_paid` — payment/renewal confirmation.
2. `food_subscription_renewal_invoice` — invoice message, preferring email when a canonical customer email is present.

Retries must not create a second invoice or duplicate messages.

## Commercial and safety boundaries

- Price changes block the automatic link and require explicit review; no silent repricing.
- Insufficient UAT inventory blocks payment-link creation; payment is not collected first.
- Paused/cancelled subscriptions do not generate due renewals.
- GST/tax is `configuration_required`. The generated document is an UAT renewal invoice and must not be represented as a production tax invoice.
- Payment confirmation does not invent a delivery/fulfilment schedule. Creating the next delivery order remains a governed separate step until Food delivery cadence, inventory reservation timing and payment/fulfilment policy are approved.
- Communications are queued through PawSpace's communication policy/outbox. External WhatsApp/SMS/email execution still depends on configured adapters.

## Automation boundary

`process_due` is the scheduler-ready operation for due subscriptions. The repository does not currently prove a production cron/scheduler is connected for this Food job, so the implementation reports `schedulerConnected = false`. Production automation requires wiring this operation to the approved scheduler with observability and retry ownership.

## UAT cases

- Create a subscription from a canonical Food order with a 7–90 day explicit renewal interval.
- Due processing creates one payment link and one renewal-link communication only.
- Replay due processing is idempotent.
- Price change blocks automatic renewal and records `price_review_required`.
- Insufficient inventory blocks payment-link creation and does not collect payment.
- Record one canonical payment reference; verify one invoice, paid confirmation, invoice communication and next-renewal advancement.
- Replay payment confirmation; verify no duplicate invoice/messages.
- Pause/cancel and verify due processing does not create renewal cycles.
- Verify live payment, production scheduler, production tax invoice and external message delivery are not claimed.
