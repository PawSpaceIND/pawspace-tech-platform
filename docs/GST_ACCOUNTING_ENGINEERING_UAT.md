# PawSpace GST / Accounting engineering UAT contract

Status: **engineering implementation candidate**

Production status: **PRODUCTION READY = FALSE**

This implementation supplies the canonical data model, governed API and Finance UAT surface for Issue #13. It does not supply Finance/CA policy decisions and does not authorize live statutory filing, tax payment, bank instruction or production accounting posting.

## Engineering gates

1. Entity, tax registration, policy, classification and document-series configuration is effective-dated and auditable. Missing approved policy returns `configuration_required`; tax/statutory rates are configuration, not application constants.
2. Customer invoices use immutable issued records, line-level tax snapshots, source-event idempotency and atomic series allocation.
3. Credit/debit notes remain linked to the original invoice, replay-safe and bounded; corrections are additive/reversal documents rather than destructive edits.
4. Vendor input-tax review detects supplier-invoice duplicates, records registration/eligibility review and obeys locked periods.
5. Tax ledger and statutory packages reconcile output, eligible input and adjustments, preserve version/supersession and require maker/checker review plus approval reference.
6. Accounting exports require an approved versioned mapping, freeze source data, carry SHA-256 checksums and separate export acknowledgement from PawSpace canonical truth. UAT never performs a production post.
7. Finance close evidence records reconciliation/variance facts for FIN-01 review. The application does not auto-mark FIN-01 verified.

## Staff UAT prerequisites

Use the exact green candidate in PawSpace Sites UAT/preview with D1 `DB`. Provision separate Finance maker and checker identities. Finance/CA must provide controlled UAT configuration for legal entity, registration, tax components/classifications, place-of-supply logic, numbering series, input-tax policy and accounting mapping. Do not invent these values.

## Mandatory UAT cases

Exercise authorized and unauthorized access; missing configuration; policy approval; concurrent/replayed invoice issue; invoice immutability; bounded partial/full credit notes; duplicate supplier invoice; input-tax eligible/ineligible/held review; maker/checker statutory package review; period lock; reproducible accounting export/checksum; duplicate export acknowledgement; close evidence with zero and non-zero variance; and audit-source drilldown.

A failed/missing policy case must remain `configuration_required`. A non-zero close variance remains visible and must not be hidden by a signoff.

## Evidence

Preserve exact SHA/CI, deployment reference, D1 environment, actor roles, approved configuration IDs/versions, invoice/adjustment/vendor-review/tax-ledger/package/export/close-evidence IDs, replay results, period-lock result, variance details and audit-event references. Keep uncontrolled customer/vendor tax identifiers and sensitive documents out of issue comments.

## Deferred professional / production gates

Finance/CA approval remains required for legal entity/registration values, tax rates and SAC/HSN mapping, place/time-of-supply, invoice/credit-note numbering, input-tax eligibility, TDS/withholding, filing obligations/due dates, chart of accounts/mappings, statutory retention and opening-balance/migration treatment.

External GST/statutory filing and Tally/Zoho/other production posting remain disabled. Staff/Finance UAT and the broader cross-role pre-live regression remain separate from engineering CI.
