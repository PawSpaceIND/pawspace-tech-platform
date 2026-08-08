# PawSpace GST, Accounting & Statutory Finance UAT Specification

## Status

**Implementation/UAT specification only. PRODUCTION READY = FALSE.**

This specification defines the system boundaries required to make PawSpace Finance testable before live statutory/accounting integrations are enabled.

All tax rates, registration applicability, place-of-supply rules, invoice-series rules, withholding/TDS rules, filing applicability, statutory due dates and reporting classifications must be configuration owned and approved by PawSpace Finance / CA before production use. The application must not invent or silently default statutory policy.

## Current repo truth

The existing Finance control already provides useful UAT foundations:

- employee expenses and vendor bills
- vendor GSTIN / PAN / TDS-section fields
- GST and TDS amount fields on Finance records
- balanced double-entry journal posting
- maker/approver separation
- period close and period lock
- Finance audit events
- import-ready bank feed boundary
- integration-ready GST filing boundary
- accounting-export readiness for Tally / Zoho Books

What is not yet canonical production truth:

- customer tax invoice master
- invoice numbering/version governance
- line-level tax classification and tax calculation snapshots
- credit/debit note lifecycle
- canonical output-tax ledger
- input-tax / vendor-tax eligibility and reconciliation
- booking/payment/refund/invoice reconciliation
- GST return preparation/reconciliation package
- accounting-export ledger mapping/versioning
- statutory sign-off workflow
- live filing or live accounting connector acknowledgement

## Design principles

1. **One commercial source, one accounting projection.** Bookings, payments, refunds, subscriptions and Finance adjustments create accounting/tax projections; Finance must not create a second contradictory booking/payment truth.
2. **Immutable issued documents.** Once an invoice/credit/debit note is issued, corrections use versioned statutory documents or adjustment records rather than destructive edits.
3. **Policy snapshots.** Every tax calculation stores the configuration version used to calculate it.
4. **No silent statutory defaults.** Missing registration/rate/classification/place-of-supply configuration returns `configuration_required`.
5. **Maker-checker for statutory-impacting changes.** Drafts may be prepared by authorized staff; approval/issue/period close require appropriate Finance authority.
6. **Idempotent document generation.** Replaying the same booking/payment/refund event must not generate duplicate invoices or tax entries.
7. **Period lock is authoritative.** Closed/locked accounting periods cannot be mutated without an explicit controlled reopen workflow and audit trail.
8. **UAT exports only.** No live statutory filing, payment to authorities, or production accounting posting is enabled by this specification.

## Canonical data model

### 1. Legal entity and registration configuration

`finance_entities`
- entity ID
- legal name
- registered address
- PAN reference
- active status
- effective dates

`tax_registrations`
- entity ID
- registration type
- registration number
- state / jurisdiction code
- effective dates
- status
- verification reference

`tax_policy_versions`
- version ID
- effective-from / effective-until
- approval status
- approved by / approved at
- policy metadata

No rate or statutory threshold is hard-coded in application logic.

### 2. Service/product tax classification

`tax_classifications`
- classification ID
- service/product code
- description
- SAC/HSN or equivalent classification reference
- tax-policy version
- applicable location/context conditions
- configured rate components
- reverse-charge / special-treatment flags only when explicitly configured
- effective dates
- approval state

Every commercial package must resolve to exactly one active approved tax classification for the invoice date/context, or issuance is blocked.

### 3. Customer tax profile

`customer_tax_profiles`
- canonical customer ID
- customer type
- registered-business flag
- registration reference if supplied/verified
- billing name/address
- place-of-supply inputs
- verification status
- effective dates

Customer ownership remains in canonical Customer 360; Finance stores only the tax/billing projection required for invoicing.

### 4. Invoice master

`finance_invoices`
- invoice ID
- invoice number
- invoice-series/version ID
- canonical booking/order/subscription reference
- customer ID
- entity/registration ID
- invoice date
- supply/service date
- billing/place-of-supply snapshot
- currency
- taxable total
- tax total
- gross total
- discount total
- payment linkage
- status: draft / approved / issued / cancelled-by-note
- policy snapshot ID
- issued by / issued at
- document hash / render reference

`finance_invoice_lines`
- invoice ID
- source line/package/add-on reference
- description
- quantity
- unit amount
- discount allocation
- taxable value
- tax classification snapshot
- tax components
- tax amount
- line total

Invoice number allocation must be concurrency-safe and replay-safe.

### 5. Credit / debit notes and refunds

`finance_adjustment_documents`
- adjustment ID/number
- type: credit_note / debit_note
- original invoice ID
- canonical refund/change reference
- reason code + narrative
- taxable adjustment
- tax adjustment
- gross adjustment
- approval state
- issue state
- policy snapshot
- audit references

A refund does not silently rewrite the original invoice. Financial and statutory reversal is represented explicitly.

### 6. Tax ledger

`finance_tax_ledger`
- ledger event ID
- period code
- tax registration
- source document type/ID
- source line ID
- direction: output / input / adjustment
- tax component
- taxable value
- tax amount
- eligibility/status
- reconciliation status
- posted journal group
- created/approved timestamps

Every issued document must reconcile exactly to its tax-ledger entries and accounting journal.

### 7. Vendor / input-tax projection

Existing vendor bills should be extended with:
- supplier invoice uniqueness controls
- supplier registration snapshot
- tax classification / tax component breakdown
- input-tax eligibility status
- eligibility reason / reviewer
- mismatch/hold state
- credit-note linkage
- accounting period

Eligibility must be explicitly configured/reviewed; the software must not assume every GST amount is claimable input credit.

### 8. Accounting mapping

`accounting_mapping_versions`
- source type
- source subtype/service
- debit account
- credit account
- tax accounts
- receivable/payable accounts
- cost centre / vertical rules
- effective dates
- approval status

`accounting_export_runs`
- run ID
- period
- mapping version
- target: Tally / Zoho Books / generic CSV or configured connector
- record count / totals
- checksum
- status
- generated by
- export reference
- acknowledgement reference when a connector is eventually enabled

Exports must be reproducible from immutable source/journal records.

## Core workflows

### A. Booking/payment -> invoice

1. Canonical booking/order determines commercial source.
2. Server resolves legal entity + registration + tax profile + tax classification + policy version.
3. Server calculates tax and creates a draft invoice snapshot.
4. Authorized Finance/automation policy approves issuance.
5. Invoice number is allocated once.
6. Invoice is issued and immutable.
7. Tax ledger + balanced journal are posted idempotently.
8. Payment allocation links without changing invoice tax truth.

### B. Refund/cancellation -> credit note

1. Refund/cancellation is approved by its canonical Finance workflow.
2. System identifies affected issued invoice lines.
3. System calculates allowed adjustment using the original policy snapshot plus configured statutory treatment.
4. Draft credit note is created.
5. Approval/issuance posts tax-ledger and accounting reversals.
6. Original invoice remains unchanged.
7. Refund, credit note, payment and booking remain cross-linked.

### C. Vendor bill -> input-tax review

1. Vendor bill captured/imported.
2. Supplier invoice duplicate check.
3. Supplier/tax registration snapshot.
4. Tax amounts/classification captured.
5. Eligibility status is reviewed/config-driven.
6. Approved bill posts expense/payable/tax journal.
7. Held/mismatched records do not become claimable tax truth.

### D. Period close

Before a period may be locked, Finance must reconcile:
- canonical booked/earned revenue for the chosen accounting basis
- collections
- payment gateway settlements
- refunds
- issued invoices
- credit/debit notes
- output-tax ledger
- vendor bills / eligible input tax
- expenses
- provider payouts/settlements
- payroll journals when Payroll is enabled
- bank transactions
- general ledger trial totals
- open exceptions

The system must show explicit variance by source rather than allowing a blanket `balanced` flag.

## UAT Gate 1 — Tax configuration

- [ ] Multiple legal entities/registrations can be configured without code changes.
- [ ] Effective-dated tax policy versions work.
- [ ] Unapproved policy cannot be used for an issued document.
- [ ] Missing tax classification blocks issuance with `configuration_required`.
- [ ] No tax rate/threshold is silently inferred.
- [ ] Unauthorized user cannot change statutory configuration.
- [ ] Every change is audited.

## UAT Gate 2 — Customer invoicing

- [ ] One canonical booking/payment event creates at most one intended invoice per configured invoicing rule.
- [ ] Same idempotency key/replayed event does not duplicate invoice.
- [ ] Invoice number allocation is unique under concurrent requests.
- [ ] Invoice references canonical customer + booking/order.
- [ ] Line totals, taxable totals, tax totals and gross totals arithmetically reconcile.
- [ ] Policy/config snapshot is stored.
- [ ] Issued invoice cannot be destructively edited.
- [ ] Unauthorized roles cannot issue/cancel statutory documents.

## UAT Gate 3 — Refunds / credit notes

- [ ] Approved refund links to original invoice.
- [ ] Credit note amount cannot exceed eligible original invoiced amount after prior adjustments.
- [ ] Replayed refund does not duplicate credit note or ledger reversal.
- [ ] Partial refund produces bounded partial adjustment.
- [ ] Original invoice remains immutable.
- [ ] Credit note tax ledger + accounting journal reconcile.
- [ ] Missing statutory adjustment policy blocks issuance rather than guessing.

## UAT Gate 4 — Vendor bills / input tax

- [ ] Duplicate supplier invoice is detected/held.
- [ ] Supplier registration snapshot is preserved.
- [ ] Tax amount is not automatically marked eligible input credit.
- [ ] Approval posts balanced journal once.
- [ ] Period lock blocks retroactive posting.
- [ ] Vendor credit note/reversal preserves history.
- [ ] Expense reimbursement and vendor bill cannot accidentally duplicate the same cost.

## UAT Gate 5 — Tax ledger / reconciliation

- [ ] Every issued invoice tax total equals related output-tax ledger events.
- [ ] Every issued credit/debit note equals its tax adjustment entries.
- [ ] Input-tax ledger traces to approved vendor bills.
- [ ] Ledger totals reconcile by registration, period and tax component.
- [ ] Variances are surfaced by source record.
- [ ] No manual deletion of posted tax events.
- [ ] Correction uses auditable adjustment/reversal.

## UAT Gate 6 — Accounting journals / exports

- [ ] Every posted source transaction generates balanced debit/credit journals.
- [ ] Mapping version is stored with each export/run.
- [ ] Same period + source snapshot produces reproducible export totals.
- [ ] Tally/Zoho/generic export contains stable source IDs for reconciliation.
- [ ] Failed export can be retried without duplicating source postings.
- [ ] Export acknowledgement is separate from accounting truth.
- [ ] No live production accounting post occurs in UAT.

## UAT Gate 7 — Statutory preparation package

The UAT system may prepare review/export packages but must not file live returns.

- [ ] Period package contains invoice/credit/debit-note register.
- [ ] Output-tax summary reconciles to tax ledger.
- [ ] Input-tax review register reconciles to vendor bills.
- [ ] Exceptions/mismatches are explicitly listed.
- [ ] Package records tax-policy/config versions used.
- [ ] Finance/CA sign-off is recorded.
- [ ] Package becomes immutable after sign-off except through versioned supersession.
- [ ] Live filing remains disabled until a separately approved production connector/gateway is configured and tested.

## UAT Gate 8 — Finance close / FIN-01

To satisfy PawSpace launch-readiness Finance reconciliation, an approved test period must demonstrate:

- [ ] bookings/revenue source -> invoices
- [ ] invoices -> collections/receivables
- [ ] collections -> payment/bank/settlement records
- [ ] refunds -> credit notes + cash/payment reversal
- [ ] provider settlements/payout liabilities
- [ ] expenses/vendor bills
- [ ] payroll journals when enabled
- [ ] GST/tax ledger
- [ ] general ledger
- [ ] zero unexplained variance, or every remaining variance owned by a documented exception
- [ ] Finance sign-off evidence attached to launch-readiness gate

## Roles / permissions to add

Recommended dedicated permissions rather than overloading `finance.manage`:
- `finance.invoice.view`
- `finance.invoice.manage`
- `finance.tax.view`
- `finance.tax.configure`
- `finance.tax.approve`
- `finance.accounting.export`
- `finance.period.manage`

Auditor remains read-only. Maker/checker separation must be enforceable independently of job title.

## Integration boundaries

Future production connectors should be adapters around canonical records, never the source of truth:

- payment gateway / settlement files
- bank feeds
- Tally / Zoho Books or other accounting system
- GST/statutory filing interface if chosen
- document rendering/storage
- payroll journals
- provider payout/settlement engine

For every connector record:
- sandbox/live mode
- credentials state
- last success/failure
- source/run ID
- webhook/signature verification where applicable
- retry count
- dead-letter/replay state
- acknowledgement/reference
- owner
- kill switch

## Production blockers intentionally left open

- CA-approved entity/registration setup
- CA-approved tax classifications/rates/rules
- approved invoice/credit-note numbering and issuance policy
- approved input-tax eligibility workflow
- approved TDS/withholding configuration
- approved accounting chart/mapping
- production accounting connector credentials
- production bank/payment reconciliation feeds
- production statutory filing process/credentials if automated
- document retention/privacy controls
- migration/opening balances
- controlled-period parallel run and Finance/CA sign-off

Passing this UAT specification means **ready for controlled Finance testing**, not production tax compliance certification.