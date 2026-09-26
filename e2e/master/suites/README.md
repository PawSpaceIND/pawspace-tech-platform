Each `*.mjs` file here is one master-suite journey group, run by `e2e/master/run.mjs` after `preflight`
(workflow: **Actions → Master E2E (staging) → Run workflow**). Journeys record product defects to
`artifacts/master/findings.jsonl` and step results to `artifacts/master/results.jsonl`; they exit non-zero only
when the harness itself fails.

| Suite | What it proves on staging |
| --- | --- |
| `05-payment-canary` | A new customer books a 4 h Boarding stay and pays ₹499 in the Razorpay TEST checkout (Netbanking → Success); the booking is confirmed and the capture is read back from D1. |
| `06-money-and-maps` | A 5-night 50/50 Boarding deposit is paid; five Pet Taxi quotes from live Google Routes are checked against the fare rules; a Pet Taxi 50% booking fee is paid. |
| `07-ai-probe` | PawSpace AI answers public and signed-in questions through the real provider. |
| `_ops-publish-grooming` | One-off operation, never part of `all`: publishes the canonical grooming price list through Pricing Control. |

Files starting with `_` run only when named explicitly.
