# Master E2E on staging — 26 Sep 2026

Evidence from `.github/workflows/master-e2e-staging.yml` runs against the deployed staging worker (build
`0fab41a`), with real Razorpay TEST checkout payments, Google Maps/Routes and the AI provider.

| Run | What it shows |
| --- | --- |
| `run-7` | First end-to-end Razorpay TEST payment: Boarding 4 h ₹499 booked, paid (Netbanking → Success) and confirmed; the three webhooks for it stay `PROCESSING` (fixed in this change). |
| `run-8` | 5-night 50/50 Boarding deposit ₹1,747.50 and a Pet Taxi 50% fee ₹284.13 paid; after each, the booking page offered the balance as a fresh "Due now" (fixed in this change). Five taxi quotes from `google_routes_uat` match the fare rules exactly. |
| `run-9` | PawSpace AI through the real provider: an open question gets a model answer; a question naming a service gets the canned directory line. |
| `run-10` | The canonical grooming price list is published on staging and the V2 grooming catalogue lists 10 packages. |

Each run folder has `results.jsonl` (one line per journey), `findings.jsonl` (defects), the suite's JSON
summary and screenshots. Secrets never reach these files: sign-in is API-based and every text file is redacted.
