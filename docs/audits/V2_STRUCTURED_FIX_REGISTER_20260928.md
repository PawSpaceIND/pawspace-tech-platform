# PawSpace V2 — structured fix register

Started: 28 September 2026. Baseline: founder readiness audit on `f2cc5d4abc01`.
Current Batch 1 base: `db2c97003837663c7370e6ada2d9d1bf574e443e`.
A baseline item is not automatically a current defect; recheck before implementing.

Closure states: open -> reproduced/scoped -> implemented -> merged -> deployed -> verified.
Do not label a whole service closed because a PR merged or a page opened.
Every release row needs exact source/deployment identity, expected outcome, observed
result, test method, evidence, owner and business approval where applicable.

| Workstream | Next required outcome | Current state / ownership |
| --- | --- | --- |
| 1. Test verdict | R01: accurate platform report, settlement/analytics fixture diagnosis, intentional red-gate proof | Implemented locally on this branch; full CI/review and merge pending. See R01 audit. |
| 2. Booking to accounts | One same-ID Grooming chain through sandbox payment, CRM, partner, invoice, tax, earning and reconciliation; then other services | Not executed by this batch; retain as hosted acceptance, not a confirmed new defect. |
| 3. Workforce / CRM | Employee period and exit; partner availability-to-earnings; lead ownership and recovery | Reuse existing modules; authenticated lifecycle and Finance/Operations sign-off remain separate. |
| 4. UI / devices | Revalidate R02-R05; supported physical devices and unsynced-work recovery | Existing UI-audit workstream owns this; no overlapping UI changes here. |
| 5. AI / voice | Grounded answers, permitted actions and complete carrier-connected voice proof | Existing voice and AI workstreams; no call, provider configuration or transcript changes here. |
| 6. Release operations | Load, role/security, alert, isolated restore/rollback and controlled-pilot evidence | Open acceptance; no production or live-money activation in this batch. |

## Batch discipline

Use isolated branches and small reviewable PRs. Coordinate shared staging before any
deployment; never replace another agent's candidate or weaken checks to make it green.
Keep live money and outbound communications disabled unless separately authorized.
Existing location and repeat-groomer work is not part of R01.

## Current Batch 1 evidence

See [R01 audit](R01_BUSINESS_VERDICT_INTEGRITY_20260928.md). It distinguishes the two
fixture defects from application defects, preserves commission exclusion and states
which validation is complete versus still pending. This is not a new 9/10 rating.
