# PawSpace GST / Accounting Implementation Backlog

This backlog accompanies `docs/GST_ACCOUNTING_UAT_SPEC.md`.

**Status: implementation backlog only. PRODUCTION READY = FALSE.**

## Gate 1 — Entity, registration and tax policy configuration
- finance entity master
- tax registration master
- tax policy versioning
- tax classification master
- effective dates / approval state
- tax-config audit events
- dedicated Finance tax permissions

## Gate 2 — Customer invoice engine
- customer tax profile projection
- invoice series/version configuration
- line-level tax calculation snapshot
- concurrency-safe invoice numbering
- immutable issued invoice
- idempotent booking/payment event handling
- invoice document render reference

## Gate 3 — Refund / credit / debit note engine
- original-invoice linkage
- partial/full adjustment bounds
- credit/debit note numbering
- idempotent refund-event handling
- tax/accounting reversal journals
- immutable adjustment history

## Gate 4 — Vendor bill and input-tax review
- supplier invoice duplicate detection
- supplier registration snapshot
- input-tax eligibility review state
- vendor credit note/reversal
- expense-vs-bill duplicate controls
- period lock enforcement

## Gate 5 — Tax ledger and statutory review package
- output tax ledger
- input tax ledger
- adjustment ledger
- registration / period / component reconciliation
- source-level variance queue
- statutory review package generation
- Finance/CA signoff and version supersession

## Gate 6 — Accounting mapping + exports
- versioned chart/mapping configuration
- journal mapping by source/service/cost centre
- reproducible Tally/Zoho/generic export runs
- checksums / source IDs
- retry-safe export acknowledgements
- no live production post in UAT

## Gate 7 — Close and launch-readiness integration
- booking/revenue to invoice reconciliation
- invoices to collections/receivables
- payment/settlement/bank reconciliation
- refunds to credit notes/reversals
- provider payout liabilities
- expenses/vendor bills
- payroll journals
- tax ledger
- general ledger
- explicit variance queue
- FIN-01 evidence linkage

## Permanent regression requirements

Every gate must prove:
- exact-head CI green
- authorized positive path
- unauthorized negative path
- maker/checker separation where applicable
- idempotency/replay
- concurrent numbering/limits where applicable
- correction/reversal rather than destructive edits
- period-lock enforcement
- audit events
- missing-policy => `configuration_required`
- no hard-coded tax/statutory rates
- no production filing/accounting post from UAT

## Policy / professional signoffs deliberately deferred

- legal entity / GST registration configuration
- tax rates and SAC/HSN mapping
- place-of-supply rules
- invoice/credit-note numbering rules
- time-of-supply / invoicing timing
- input-tax eligibility
- TDS/withholding applicability and rates
- return/filing applicability and due dates
- chart of accounts
- accounting mapping
- statutory retention requirements
- opening balance / migration treatment

These decisions must be approved by Finance/CA and stored as effective-dated configuration rather than application constants.
