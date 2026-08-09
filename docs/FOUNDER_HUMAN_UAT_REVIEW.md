# PawSpace founder human UAT review

Status: **ENGINEERING CANDIDATE / HUMAN UAT REQUIRED**  
Production ready: **FALSE**

This checklist is for the exact deployed candidate only. A green GitHub CI run does not prove deployment, D1 persistence, browser/device behavior, or human UAT.

## Entry gate

Record before testing:

- exact Git SHA
- green CI run reference for that exact SHA
- PawSpace Sites UAT/preview URL
- proof that the deployed build is that exact SHA
- proof that D1 binding `DB` is available to the deployed candidate
- tester identity, browser/device, date/time

If exact deployed SHA or D1 cannot be verified, mark the run **BLOCKED** rather than PASS.

## Founder walkthrough — customer experience

### Address assistance

- Grooming: type `Greenage`; a Bengaluru Greenage/Hosur Road suggestion must appear.
- Select the suggestion; the address field must be populated without manual full-address entry.
- Repeat on other customer address/location text inputs that expose the shared address-assist layer.
- Browser street-address autocomplete may assist.
- Do not claim Google Maps/Places production connectivity; production Maps remains a separate integration gate.

### Package clarity

- Grooming: select Essential Bath, Bath & Basic, Complete Makeover and Just Trim; confirm selected-package detail exposes included and not-included items.
- Training: inspect each programme; confirm Best for and outcomes are visible and trainer details are shown before booking.
- Boarding/Sitting/Walking and other verticals: verify the customer can understand duration/unit, governed price, care/provider details and the material service scope offered by the current canonical catalogue. Log a product-content gap if a package has meaningful exclusions that are not yet represented by governed catalogue data; do not invent exclusions in UAT.

### Customer-facing test-data hygiene

- Normal customer pages must not show the synchronized Test Transaction Engine panel.
- Test Lab/Regression Lab may display explicit UAT/synthetic evidence.
- No page may imply live payment, live messaging, live GPS, production Maps, or production provider availability where those integrations are disabled.

### Mobile app service access

Verify all eight current service families are visible from `/mobile-app`:

1. Grooming
2. Training
3. Boarding
4. Pet Sitting
5. Pet Taxi
6. Dog Walking
7. Fresh Food
8. Relocation

Grooming, Training, Boarding and Sitting use embedded customer journeys. Walking, Fresh Food and Relocation may open their complete customer routes. Pet Taxi remains controlled-review/out-of-active-launch-scope and must not be represented as production-live.

## Founder walkthrough — staff/control routes

Every route below must render from the exact deployed candidate:

- `/business`
- `/prelaunch`
- `/team/revenue-mission`
- `/team/cases`
- `/team/alerts`
- `/team/analytics`
- `/team/finance/partners`
- `/team/ai`
- `/team/ai/configuration`
- `/team/ai/handoff`
- `/team/ai/analytics`

Also verify `/control` is readable at normal browser zoom: sidebar can scroll to the bottom, labels/buttons are legible, and content does not overlap the lower navigation.

## Cross-role human UAT

After the visual walkthrough passes, execute the canonical end-to-end pack in `docs/END_TO_END_STAFF_UAT_EXECUTION.md`:

Customer booking → provider configuration/onboarding → Ops interview/human decision → UAT-only provider activation → assignment/work → proof/completion → exception/recovery → Finance/GST/accounting → CRM/Revenue → case/escalation → AI assist → human handoff → analytics → hosted real-D1 60-booking swarm.

Mandatory negative coverage includes authorization, replay/idempotency, stale/invalid GPS, external-provider failure, insufficient evidence, capacity collision, schedule change, refund/adjustment/reversal boundaries, and no-live-money/no-live-deduction checks.

## Evidence required for PASS

For each material scenario retain:

- exact deployed SHA and URL
- tester + timestamp
- route/scenario
- expected vs actual
- booking/customer/provider/case IDs where applicable
- screenshot or referenced evidence
- D1/canonical-state verification where applicable
- recovery/retry result for negative cases
- explicit PASS / FAIL / BLOCKED

## Closure rule

Human UAT is closed only when all required scenarios on the exact deployed candidate have staff evidence and no unresolved P0/P1 UAT defect remains.

Human UAT closure does **not** equal production readiness. Production integrations, security/privacy approval, monitoring/backups/restore, migration/opening state, real-device coverage, Bengaluru pilot and explicit launch approval remain separate gates.

**PRODUCTION READY = FALSE. No merge or public launch is authorized by this checklist.**
