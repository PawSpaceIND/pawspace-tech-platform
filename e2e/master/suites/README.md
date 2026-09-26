Each `*.mjs` file here is one master-suite journey group, run by `e2e/master/run.mjs` after `preflight`
(workflow: **Actions → Master E2E (staging) → Run workflow**). Journeys record product defects to
`artifacts/master/findings.jsonl` and step results to `artifacts/master/results.jsonl`; they exit non-zero only
when the harness itself fails.

| Suite | What it proves on staging |
| --- | --- |
| `05-payment-canary` | A new customer books a 4 h Boarding stay and pays ₹499 in the Razorpay TEST checkout (Netbanking → Success); the booking is confirmed, the capture is read back from D1, and every Razorpay webhook of the payment is processed. |
| `06-money-and-maps` | A 5-night 50/50 Boarding deposit is paid; five Pet Taxi quotes from live Google Routes are checked against the fare rules; a Pet Taxi 50% booking fee is paid and the booking page then asks for nothing until drop-off. |
| `07-ai-probe` | PawSpace AI answers public and signed-in questions through the real provider. |
| `08-fix-verification` | Runs after 06: the V2 grooming catalogue shows what each package includes; the Boarding host sees the pets and care plan of 06's stay with contacts withheld until acceptance; the driver of 06's ride cannot confirm the pickup weeks early. |
| `10-refund-and-staff-fixes` | Runs after 06 and 08: Finance's Boarding queue and workspace list 06's cancellation (STAFF-02); an approved and recorded ₹500 refund reaches the refund case, reconciliation, payment status, collection ledger and timeline, and the customer's manage page shows it (STAFF-05); a Pet Sitting Home Visit quotes ₹399 for 60 minutes and is refused for 2 hours (SIT-04); the public relocation enquiry form submits (STAFF-03). |
| `09-webhook-inbox` | Read-only: no Razorpay webhook received since the live deploy is stuck in RECEIVED/PROCESSING (in-flight ones get 2 minutes). 06 runs the same check after its payments. |
| `_ops-publish-grooming` | One-off operation, never part of `all`: publishes the canonical grooming price list through Pricing Control. |

Files starting with `_` run only when named explicitly.
