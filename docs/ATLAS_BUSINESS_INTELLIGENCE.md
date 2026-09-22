# Atlas Business Intelligence — UAT only

Atlas V2 is a grounded read/recommendation layer over PawSpace canonical systems. It is not a parallel operating system and it is not production-authorized.

## Data flow

`canonical bookings / mission events / cases / invoices / training earnings / runtime readiness` → `buildAtlasBusinessSnapshot()` → founder/staff brief → optional model rewrite → proposal journal → existing human approval + Atlas gateway.

Every snapshot metric carries `value`, `source`, and `asOf`. Missing canonical tables or unreadable sources return `null` with a reason; Atlas must never convert unknown into zero. Pipeline and forecast are named separately and never count as achieved revenue. Tally analytics memory is optional secondary context labelled `tally_memory`, never canonical live revenue.

## Tighten-only rule

The model may make the interpretation more conservative, never more optimistic than the canonical snapshot. It must not invent collected revenue, claim a higher percentage-to-target, raise targets, claim a campaign/provider/payment action occurred, or turn pipeline into achieved revenue. Overstated narratives are rejected and the product falls back to grounded output.

## Atlas may not do

Atlas may not assign providers, capture/refund/payout money, activate campaigns without the existing founder approval path, waive consent/DND/quiet-hour rules, enable live outbound, widen the customer-AI rollout, or mark production readiness true. Recommendations are journaled with the snapshot hash, basis ID, and risk class and remain `approval_required`.

## UAT versus production

This feature is **UAT ONLY**. Integration readiness flags expose only booleans/status, never credentials. Missing AI provider configuration returns the grounded snapshot with `Narrative unavailable; numbers only`. Production activation requires separate governance and is out of scope for this PR.
