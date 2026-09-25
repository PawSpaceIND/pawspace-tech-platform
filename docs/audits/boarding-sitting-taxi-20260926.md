# PawSpace V2 Boarding, Sitting and Taxi audit

26 September 2026. Repair branch: `fix/v2-boarding-sitting-taxi-audit-20260926`.
Functional repair commit `f0ba32406a1f8227214ce2a61afd9dbd3d95748b`; integrated code candidate `62ab15a7e98ea0f0675801fb80f4845635e26000`, including main `70bc403b`. Continuation code was validated at `bb0c00da5f4c08b13729e75c2fa0b7ea54ef4b54`, including main `2cceca14`. Published as draft PR #1090; no merge or deployment.

**Not an end-to-end release certificate.** 23 findings: 20 candidate repairs and 3 open integration/policy items. Candidate changes are not deployed closure. Separate remaining execution gates must be passed.

## Staging evidence
- Visible Chromium on the authorized Mac: `/v2/boarding`, `/v2/sitting`, `/v2/taxi`; the existing synthetic customer and saved doorstep were reused.
- Boarding and Sitting reached caregiver selection, care instructions and final review. The combined submission command was tool-blocked before service creation. It was not bypassed through another channel.
- Eight one-pet quote cases plus two dog-and-cat quote cases returned HTTP 201. These are ten quote checks, not ten paid bookings.
- One-pet Boarding totals: four hours INR 499; ten hours INR 599; one overnight INR 699; six nights INR 4,194 / 2,097 due under split.
- One-pet Sitting totals: four or ten hours INR 399; one overnight INR 799; six nights INR 4,794 / 2,397 due under split. Duration-to-Home-Visit price is a business-policy question, not a guessed tariff change.
- Six-night dog-and-cat totals: Boarding INR 8,388 / 4,194 due; Sitting INR 7,188 / 3,594 due.
- The monitored Taxi tab recorded legacy creation `PS-UAT-TAXI-MUHBOZXQ-C3B9`, INR 699, sandbox_deferred, zero due now, confirmed/scheduled, 27 September 08:00-09:00 IST. The origin of that click was not established. It is not a modern 50%-deposit ride or gateway-capture proof.
- Management of that legacy Taxi was readable: vehicle pending, tracking Not Sharing, no fresh GPS. The title nonetheless said the driver was approaching; the local candidate now derives its heading from the actual GPS/lifecycle state, without claiming deployed verification.
- Customer reads of Boarding Finance, Sitting Finance, Taxi Finance and the unrestricted scheduler returned HTTP 403.
- No live-money payment, provider arrival, physical care completion, refund, payout or tax filing was performed or certified.

## Candidate changes
BST-01 host medication/resident-pet/one-family requirements are enforced in discovery and final booking.
BST-02 integer pet counts; BST-03 normalized UTC/IST search windows; BST-04 fail-closed capacity reads.
BST-05 correct IST calendar offsets; BST-06 known-reference reload links (partial; BST-21 remains open).
BST-07 current-selection quote stamps and review after refreshed price changes; BST-08 retained same-intent booking/quote/reservation on retry.
BST-09 full address and honest request/payment review; BST-10 Sitting per-visit labels; BST-11 IST stay changes.
BST-12 ordinary V2 Taxi reuses the authenticated customer fleet flow instead of Gate-1 synthetic route classes.
BST-13 safe empty/invalid dates; BST-14 quote/selection/expiry checks; BST-15 selected pickup/PIN passed to scheduling.
BST-16 history cannot reopen earlier purchase stages once a booking exists; BST-17 service switches navigate to the matching V2 URL.

## Still open
BST-18 persist and execute trial/Meet choices as separate governed requests; no implied free service or invented fees.
BST-19 caregiver messaging/media/reviews remain disclosed as unconnected in staging.
BST-20 confirm intended Home Visit duration/rate policy before any commercial change.
## Additional candidate repairs completed in the continuation
BST-21 verifies the ownership-scoped server projection and matching service before showing a saved-booking claim. Denied/missing/wrong-service references stay failures.
BST-22 derives customer tracking headings from actual GPS/lifecycle state and removes unconditional capability checkmarks. GPS backend work in #1089 remains separate.
BST-23 reuses unchanged Boarding extension/date-change/cancellation intent keys with a synchronous double-click lock. Financial approvals remain unchanged.

## Verification evidence classes
- Baseline selected service suites: 484 passed.
- Three new host requirement/count regressions failed before correction and passed afterward.
- New and affected cases: 34 passed, including eleven audit regressions. The six full-suite failures were source-wiring/presentation-contract expectations; 69 focused cases passed after correction.
- First full candidate: 7,302 passed / 7,308 total, six failures. The earlier frozen candidate subsequently passed all 7,312 tests. Current integrated continuation `bb0c00da` then passed **7,325/7,325**, zero failures/cancellations/skips.
- TypeScript and Worker artifact build passed before integration; the current integrated continuation also passed build and TypeScript.
- Lint on changed sources: no errors, two existing image-optimization warnings.
- Seven added continuation tests and 557 affected service checks passed. Five read-only browser recovery cases passed: denied, Boarding, Sitting, Taxi and wrong-service. The three successful mobile pages fit 390px without horizontal overflow; no JavaScript errors were observed. A separate tracking-panel browser fixture check timed out and is not counted as a pass.
- Local read-only browser fixtures verified the ordinary V2 Taxi entry, owned dog/cat selection, empty-date safety, mobile review and reference-recovery links. These are not live bookings or payments.
- Historical source fingerprints were refreshed only for intentional changes and documented in `boarding-sitting-taxi-20260926-rebaseline.json`. No payment, ownership or capacity assertions were removed to make tests pass.

## Remaining execution gates
Record exact staging deployment; rerun actual Boarding/Sitting creation; verify care persistence/recovery and price re-consent; run prepaid/split and modern Taxi 50% through genuine TEST checkout; verify signed/duplicate/late gateway events; confirm acceptance/reassignment/capacity conflicts; verify fresh GPS and truthful unavailable states; execute actual care/ride completion and customer closure; exercise balance collection/refunds/extensions; trace completed records through invoices, commission, settlement and GST. Lead assignment/SLA/conversion and integration delivery remain separate checks.
No existing invoice or earlier Grooming payment is a substitute for this evidence. Photos were excluded without disabling mandatory proof gates.

## Coordination and evidence retention
This branch does not merge or alter the separate Grooming/Training PR #1088. Its shared canonical-booking and test-manifest changes must be integrated deliberately and regression-tested with this candidate before one combined release. Prior open finance/commercial findings remain in the earlier master report; they are not silently closed here.
Remote evidence: `Documents/PawSpace-audits/boarding-sitting-taxi-20260926/`: quote-matrix.json, multipet-quotes.json, flows.jsonl, customer-access-checks.json, observed-legacy-taxi-booking.json, latest-observation.json, local-ui-checks.json, screenshots and build/lint/typecheck/test logs.
Retain the legacy Taxi record for review; release test capacity only through its normal authorized workflow after evidence is no longer needed. No other agent worktree was edited.

## Final verification record
Code revision `bb0c00da5f4c08b13729e75c2fa0b7ea54ef4b54`; completed 26 September 2026, 01:30 IST. Full suite 7,325 passed, 0 failed/skipped/cancelled. Worker build and TypeScript passed. Changed-file lint: 0 errors, 2 existing image-optimization warnings. Logs: `continuation-final-suite.tap`, `continuation-final-build.log`, `continuation-integrated-typecheck.log`, `continuation-integrated-lint.log`. Hosted CI and deployed acceptance are separate checks.
