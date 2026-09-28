# PawSpace V2 — structured fix register

Started: 28 September 2026. Baseline: founder readiness audit on `f2cc5d4abc01`.
Current Batch 2 base: `5c48fd76a4c9f08afdeda9c77b9a2a4d4e25ae79` (merged #1160).
A baseline item is not automatically a current defect; recheck before implementing.

Closure states: open -> reproduced/scoped -> implemented -> merged -> deployed -> verified.
Do not label a whole service closed because a PR merged or a page opened.
Every release row needs exact source/deployment identity, expected outcome, observed
result, test method, evidence, owner and business approval where applicable.

| Workstream | Next required outcome | Current state / ownership |
| --- | --- | --- |
| 1. Test verdict | R01: accurate platform report, settlement/analytics fixture diagnosis, intentional red-gate proof | Merged as #1160 / `5c48fd76`; exact tested tree and pre-merge checks verified. Separate staging deployment not performed; this batch adds runtime changes and needs its own gates. |
| 2. Booking to accounts | One same-ID Grooming chain through sandbox payment, CRM, partner, invoice, tax, earning and reconciliation; then other services | Batch R02 reproduced and repaired two completion invoice/link defects locally. Four new real-handler regressions cover collisions, Finance races and recovery. Hosted OTP submission was tool-blocked; no hosted booking created. Full same-ID acceptance remains open. |
| 3. Workforce / CRM | Employee period and exit; partner availability-to-earnings; lead ownership and recovery | Reuse existing modules; authenticated lifecycle and Finance/Operations sign-off remain separate. |
| 4. UI / devices | Revalidate R02-R05; supported physical devices and unsynced-work recovery | Existing UI-audit workstream owns this; no overlapping UI changes here. |
| 5. AI / voice | Grounded answers, permitted actions and complete carrier-connected voice proof | Existing voice and AI workstreams; no call, provider configuration or transcript changes here. |
| 6. Release operations | Load, role/security, alert, isolated restore/rollback and controlled-pilot evidence | Open acceptance; no production or live-money activation in this batch. |

## Batch discipline

Use isolated branches and small reviewable PRs. Coordinate shared staging before any
deployment; never replace another agent's candidate or weaken checks to make it green.
Keep live money and outbound communications disabled unless separately authorized.
Existing location and repeat-groomer work is not part of R01.

## Batch evidence

See [R01 audit](R01_BUSINESS_VERDICT_INTEGRITY_20260928.md). It distinguishes the two
fixture defects from application defects, preserves commission exclusion and states
which validation is complete versus still pending. This is not a new 9/10 rating.

See [Batch R02 invoice integrity](R02_GROOMING_COMPLETION_INVOICE_INTEGRITY_20260928.md) for the new application defects, local repairs and verification boundaries. Batch R02 is separate from initial UI observation R02. Historical invoice backfill and the existing pre-finalization finance-write ordering are not silently certified by this repair.
