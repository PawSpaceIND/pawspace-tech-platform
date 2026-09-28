# UAT fixture phone collision — source recurrence guard

Date: 28 September 2026. Related operational blocker: #1166.
Base: `7f3a3bd63e9e8b1a0e5cf9e1ac0ae8bbcf380bd6`.

## Reproduced source gap
Both legacy WhatsApp certification provisioners compared raw digit strings. A local Indian number and its +91 representation therefore escaped that comparison, while the app's canonical recipient resolver correctly treats them as the same recipient. This reproduces a possible duplicate-creation path; it does not prove the historical event that created the current duplicate.
The v2 provisioner also excluded the existing fixture from its collision scan and overwrote its phone and consent on conflict, permitting a retired fixture to be reactivated.

## Change
- Both provisioners load the same pure guard and the application's canonical phone/key normalization.
- Inventory includes primary and secondary phones for ALL customers, including the fixture, with an independently returned count. Missing, failed or partial inventory refuses creation.
- The dedicated fixture must not already exist. Active, retired, or repurposed records are not automatically reused, reattached, or reset.
- Existing customer, preference, pet and booking records use `ON CONFLICT DO NOTHING`, not overwrite-on-replay.
- No recipient, raw inventory, credentials, or private account records are logged by the guard.

## Verification
- Node 22.16.0: 50/50 new tests passed; targeted guard + existing voice repair/policy regression selection: 112/112 passed, no skips.
- Node 24.19.0: 50/50 new tests passed.
- Both edited YAML files parsed successfully; `git diff --check` passed.
- No remote provisioning workflow, maintenance operation, dial, knowledge publication, or payment change was executed by this workstream.

## Remaining acceptance
This is preflight recurrence protection, not a database-wide unique-phone constraint or an atomic guarantee against all concurrent application writes. The existing dispatch-time ownership check stays unchanged. The independently authorized staging administrator must still retire only the founder-approved obsolete reference, verify unchanged history and exact ownership, and then perform the approved single handset demo. This PR alone cannot close #1166 or certify a successful call.

## PR #1169 CI recovery — 28 September 2026

Both failing jobs on `dd9fb94` (`Web tests` and `Staging isolation + full certification`) reached the same assertion in `tests/test-suite-executes-code.test.mjs`: 161 files were counted against the unchanged budget of 160. The original 50 guard tests execute a `scripts/` module; the classifier does not follow that import into the product normalizer.

Added 27 explicit product-boundary regressions to the existing guard suite. They invoke the actual `resolveCanonicalRecipientOwnership` implementation against disposable SQLite-backed D1 data: eight phone formats, duplicate primary/secondary owners, unique secondary ownership, mismatched identity/foreign-country/missing-phone requests, and a booking/customer mismatch. Refusals assert that the stored identities remain unchanged.

- Node 22.16.0 normal hooks: 141/141 targeted guard, ratchet, voice-repair and policy tests passed.
- Node 22.16.0 forced fallback hooks: 141/141 passed.
- Node 24.19.0 guard and ratchet selection: 79/79 passed.
- Focused ESLint and `git diff --check` passed.
- The static-file budget and its classifier are unchanged. No tests are skipped or exempted.
- Integrated main `f9128593c40cd339cb7e2fe150af1b6b1743f23a` without conflicts.

The attempted provisioning/eligibility source revision was blocked by the tool safety check. A subsequent diff verified it was not applied. That edit was not retried through another route. The reserved-pet ownership review thread therefore remains open and is a merge hold; this CI recovery must not be presented as resolving it.

This recovery changes tests and evidence only (in addition to integrating main). It performs no remote maintenance, contact/customer/consent/payment change, fixture provisioning, knowledge activation or handset dial. Full-suite/build outcomes and fresh CI status are reported separately once available; the failed old-head run is not relabelled green.

Node 22.16.0 typecheck, application build and Worker artifact validation also passed. The full tracked Web selection and the two separate certification suites have been started against this integrated source; they are not counted as passed until their results are available.

## Second CI failure: mobile hit-target sampling

On `5633bf257e0d15552e53fc951e668366d996ec90`, job `109037094132`
(run `36454447113`) failed the mobile customer journey's `consent:essential`
centre-pointer assertion. This is different from the earlier static-test ratchet.
The log does not identify the obstructing element, so a persistent app defect is
not ruled out solely by this assertion or by a retry. One exact-job retry was requested.

The customer browser test now waits for the navigation whose presence changes the
consent dock's CSS offset, reads geometry and centre hit-testing atomically, and
polls the same >=44px, pointer-enabled, unobstructed conditions for at most 10s.
Trial clicks and all navigation/login/checkout assertions remain; no forced click,
whole-test retry, assertion skip, product CSS or payment behaviour was introduced.

A browser-only synthetic HTML regression proves that a lasting overlay, width
below 44px or height below 44px still fail, while a removed temporary overlay
passes. Three repetitions on each of Desktop Chrome and Pixel 7: 6/6 passed.
Updated-source typecheck, focused ESLint and diff checks passed. The preceding
`5633bf2` local tracked Node selection also finished: 9106/9106 passed, no skips;
that is separate from the new browser change and is not full-browser certification.

The attempted CI-artifact download and custom local app browser probe were blocked
and not repeated through another route. Synthetic HTML tests do not substitute for
the full app's pending CI. The unrelated reserved-pet ownership review remains open.
No merge, remote data repair, provisioning, shared deployment, knowledge activation,
or handset call is part of this test-only correction.
