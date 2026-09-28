# R02 — Grooming completion invoice integrity

Date: 28 September 2026. Base: `5c48fd76a4c9f08afdeda9c77b9a2a4d4e25ae79` (#1160).
Branch: `fix/r02-grooming-journey-20260928`.
Scope: the existing Grooming completion route, its invoice projection and evidence.
Status: local implementation and regression verification; not merged or deployed.

## Deployment and hosted-attempt boundary

The latest inspected staging deployment was #1158's `89d483d971b1ca1ceeaeb96bbff91898168081f2`,
run 36420967674. Its downloaded certificate passed 28/28 checks. The application,
worker/backend, dependency and public-source diff from that revision to #1160 was empty;
#1160 itself had not been separately deployed. No deployment was performed here.

A separate browser session opened V2 and requested the normal displayed sandbox OTP
for the existing synthetic customer. The OTP-submission tool action was blocked and
was not retried through another route. The session was closed before any booking,
reservation, charge or customer-data edit. This is NOT hosted journey acceptance.

## Reproduced application defects

1. With Date.now held constant, two complete synthetic Grooming journeys both returned
   HTTP 200 and completed their bookings/work orders, but only one booking invoice
   existed. Both candidates used the same timestamp-derived PS reference and the
   broad INSERT OR IGNORE silently suppressed the second invoice.
2. A legitimate local Finance invoice issue immediately before the completion batch
   caused that batch to retain the existing invoice but write tax readiness using the
   discarded candidate ID. The service-completed event also used the wrong number.

Before repair, the two new regressions failed while all six existing golden journeys
passed (6 passed / 2 failed). After repair the same eight passed, unchanged assertions.

## Repair

- Generate a full UUID invoice ID. The legacy PS completion reference retains its
  year and eight-character suffix shape but uses UUID-derived characters, not a clock
  suffix. This does not alter the separate governed Finance tax-invoice series.
- Ignore only an existing invoice for the same booking. A rare reference/ID uniqueness
  collision refuses completion with recoverable 409 `completion_invoice_conflict`;
  another booking's invoice is never reused, overwritten or silently ignored.
- Select the actual invoice ID inside the completion transaction, with both booking
  and customer matching. Preserve a concurrently or previously issued invoice.
- Extend the existing lifecycle transaction assertion to require the invoice and
  tax-readiness link. A missing write cannot commit completed booking/work-order,
  settlement-readiness or repeat-task projections.
- Reuse the persisted completion bundle for event/audit numbering and the response,
  rather than reporting the attempted invoice. No additional bundle read was added.

No tax amount, commercial term, payout amount, payment authority, service proof,
customer/partner permission, consent, subscription policy or UI rule was changed.
No old invoice was renumbered. Historical mismatches are not silently backfilled.

## New executable coverage

Four tests use the actual scheduling, canonical booking, local payment-event,
partner lifecycle, invoice and finance handlers through the existing SQLite-backed
D1 journey adapter. Identities, GPS, media receipts and payment events are synthetic.

- Equal-millisecond completions retain two invoices and correct per-booking links.
- A Finance issue at the final batch boundary remains unchanged; its persisted ID
  and number are used by tax readiness and the service-completed event.
- A deliberately competing invoice number causes 409 with no completion projection;
  retry succeeds, preserves the other invoice and does not post the journal twice.
- A deliberately ignored invoice INSERT aborts the final transaction and releases
  the lifecycle lease; after removing that local fault, the same booking completes.

Important existing boundary: completion finance posts before the final lifecycle
transaction. The collision/retry test explicitly observes that journal and proves no
duplicate posting on retry; it does NOT certify whole-finance rollback or a completed
partner payout. The ordering and recovery policy need separate end-to-end acceptance.

The initial expanded selection passed 13/13 (four new, six golden, three provider
journeys). Counts overlap later runs. Typecheck and changed-file lint passed.
Only the intentionally modified route's nine source fingerprints were refreshed,
with each old value checked against the base SHA. No unrelated hash or assertion,
static-test budget, authorization rule or deployment configuration was changed.

Evidence: `Documents/PawSpace-fixes/r02-grooming-journey-evidence-20260928/` contains
before/after logs and exit files, the expanded selection, protected-source refresh,
typecheck/lint, and the downloaded prior-staging certificate. Full exact-head CI,
review, deployment and hosted customer-to-partner-to-Finance acceptance remain gates.

## Broader verification checkpoint

The first 61-file selection reported 547 passed / 1 failed of 548. The sole failure
was an older SQL-extraction test expecting the removed broad `INSERT OR IGNORE`
statement. It now extracts the actual insert and additionally requires the narrowed
`ON CONFLICT(booking_id) DO NOTHING` clause. All original customer-account assertions
remain. No application rule was weakened to satisfy that source-based test.

The complete 61-file selection was repeated on both module-hook paths using Node
22.16.0: 548/548 passed normally and 548/548 passed with the forced asynchronous
loader; zero failed/cancelled/skipped/todo in either run. These are the same tests,
not 1,096 unique journeys. The suite includes the new invoice regressions, golden
customer/partner flows, cross-module reporting, cash/collection, invoice, refund,
subscription, lifecycle, schema, presentation and strict R01 matrix checks.

The workstation connection timed out after those tests. On reconnection, source
changes and both exit files were confirmed; the interrupted build had no completion
evidence and was not counted as a pass. Build and exact-head CI remain separately
reported in the PR checkpoint. No hosted booking or deployment followed the block.

## Current-main integration and response freshness review

The branch integrated main `7f3a3bd63e9e8b1a0e5cf9e1ac0ae8bbcf380bd6`
without discarding the merged AI, history or voice changes. The integrated candidate
`4989e5b1d89bcb02410171d48ff0dfab35cb93dc` exposed a response regression:
completion persisted its event but returned a bundle captured before that event.
A new actual-handler test failed on the unchanged candidate, despite the durable
completion being successful. The earlier integrated test sequence was interrupted
and is not reported as a full-suite pass.

The route now reads only the persisted invoice number before emitting its completion
event, then obtains the response bundle after the event and security audit. This
restores the existing response ordering and privacy projection, with one narrow
invoice lookup rather than an additional full bundle read. Pricing, permissions,
proof requirements, payment authority and all four original integrity scenarios stay
unchanged. The fifth regression checks exactly one completion event in the response,
agreement with the stored invoice number and the masked actor identity.

Five invoice/response regressions and six existing golden journeys passed together:
11/11, zero failures/cancellations/skips/todos. This checkpoint is not a whole-suite,
cloud, hosted-provider, deployment or tax-filing certificate. Final exact-head
verification and merge status are recorded separately in PR #1164.
