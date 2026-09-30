# PawSpace voice sales closure — 30 September 2026

## Scope and decisions

Keep ElevenLabs for the first Grooming pilot; evaluate the native engine alongside it.
Reuse canonical CRM, scheduling, booking, payment and provider-assignment rules.
Use existing approved commercial policies. The user directed unresolved commercial cases to staff;
do not invent refund, subscription, surcharge or operating-hour commitments.
Earlier attended-call authorization is superseded by the user’s explicit stop: no phone calls until the audio fault is fixed. Do not automatically resume dialing after synthetic tests pass.
Full number is intentionally excluded from this repository.

## Included work

- Integrate PR1194 personalized concierge/WhatsApp checkout queue and PR1193 native context continuity.
- Preserve failed or pending post-call CRM writes as retryable webhook processing.
- Associate outbound transcript with the deterministic call thread, not a customer's latest unrelated thread.
- Count verified inbound ElevenLabs customer turns before recording the CRM completion outcome.
- Record outbound customer speech in the canonical CRM disposition system, idempotently.
- Never infer purchase, payment or sales intent from provider summaries.
- Distinguish language configuration from premium audio certification; reject missing/invalid timing metrics.
- Add an operational overview to the existing V2 voice console, reusing staff themes and permissions.
- Show canonical booking/payment/message/provider records, inbound sessions and pending reconciliation.
- Expose draft/activate/pause controls through existing governed sales-target APIs.
- Retain existing individual-call policy preview and dial/handoff/opt-out/retry/cancel controls.
- Answer general pet health and hygiene questions from approved knowledge, with a veterinarian referral
  on medical turns and immediate emergency-vet advice for danger signs. Medical turns cannot propose
  checkout actions or cross-sell. Maya does not diagnose, prescribe, or represent herself as a vet.
- Use governed approved offers for eligible Grooming voice proposals; the WhatsApp checkout quote
  remains authoritative and a separate customer confirmation is required.
- Materialize the ElevenLabs post-call reconciliation table in the deployment migration before the
  first callback, so missing reconciliation evidence appears as unknown rather than an absent source.

## Verification and remaining launch gates

Local typecheck, production artifact build and focused suites are exercised separately from live proof.
Browser scenarios cover desktop/mobile, three palettes, light/dark, evidence truth and existing controls.
Live configuration on 30 September confirmed nine language profiles and the expressive conversational
model; dedicated localized voices were present only for English. Configuration is not audio acceptance.

Before launch record exact build, agent version, call ID and attended feedback; demonstrate:

1. Existing and new-customer Grooming intake with saved pet/address or governed profile completion.
2. Accurate live quote, explicit confirmation, one canonical booking and payment order.
3. Checkout link delivery (not merely queuing), sandbox payment verification and consistent app records.
4. Eligible provider assignment and separate provider acceptance evidence.
5. Human transfer, opt-out, unanswered/busy/voicemail, failed payment, unavailable capacity and duplicate callbacks.
6. Measured response latency, natural conversation, interruption recovery and language continuity.

No dashboard counter, passing configuration check or synthetic transcript certifies these live outcomes.
No production campaign is activated as part of test execution. Native runtime cutover requires its own
attended comparison and rollback evidence. Unresolved cases remain with staff.

The user subsequently approved the current voice for the initial pilot. Localized voice discovery
returned 401; this is an explicit pilot deferral, not a claim of localized voice certification.
Fresh-launch preflight verifies the full authorized recipient via SHA-256, isolated staging revision,
canonical ownership, the deployed read-only sales dashboard and the existing policy preview. It has no dial or policy-override operation.
The pet-care source pack includes the AVMA pet-care pages and Merck Veterinary Manual pet-owner
overview as curated references. Maya has no live open-web retrieval. The approved knowledge pack passed the existing authenticated staff activation lifecycle in
isolated staging; production activation is still pending. Vet consultation
must be checked against the live service directory and scheduling system; a referral alone is not a
confirmed connection to a veterinarian. The present symptom detector is English and limited, so
multilingual and broader medical triage remain additional launch work.

## Observed staging and attended-test evidence

- [Staging deployment 36673858254](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36673858254)
  certified application revision `3d972f675f989f4d250a4468bc4fc22e8163915f` with zero isolation failures:
  sandbox payments, production blocked, 30/30 seeded service-zone pairs, 6/6 authenticated personas,
  and 6/6 hosted smoke routes. A later main deployment replaced this revision. The current PR
  has since merged main and repaired the voice console for incomplete operations responses.
- [Staging deployment 36681033000](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36681033000)
  certified revision `48e5e039aa6501007683873f9a492ea5047a9ab1`. The final coupon-channel
  correction, post-call migration and broader medical-question detection are in newer revisions;
  exact-head staging certification remains required.
- [Browser run 36674336899](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36674336899)
  passed 28 scenarios across Professional/Fun, all three palettes, light/dark and desktop/mobile.
- [Normal policy inspection 36674341413](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36674341413)
  matched the authorized recipient and canonical owner but reported `frequency_cap`. It did not dial.
- [No-call launch preflight 36682442926](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36682442926)
  found five of six dashboard sources available; post-call reconciliation was absent before its
  first callback. It again reported `frequency_cap` and did not dial. The additive migration above
  addresses the missing source, subject to exact-revision staging verification.
- The user authorized an attended test at any time. The existing settings-managed
  `uat_specialist_sales_test` endpoint separately enforces UAT and sales approval, one allowlisted
  recipient, canonical ownership, consent and opt-out checks. Its existing test-only frequency
  isolation was used without changing production rules or environment approvals. The workflow
  additionally verifies the full recipient hash and exact isolated build, and refuses reruns.
- [Attended attempt 36674750574](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36674750574)
  received HTTP 201 / `dialing` from ElevenLabs/Exotel at 05:45 UTC (11:15 IST). Exact provider
  correlation was verified. The terminal carrier result was `recipient_leg_not_answered` with
  zero conversation turns. The workflow therefore failed its handset acceptance check correctly.
  No audio quality, successful conversation, booking, payment or provider acceptance is certified.
  The participant was asked what happened on their handset; no automatic redial was performed.

PR: [1199](https://github.com/PawSpaceIND/pawspace-tech-platform/pull/1199).
The production launch remains open until the attended and completed-sales gates above pass.

## Latest pet-care staging verification

[Deployment 36694448953](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36694448953)
certified revision `e08d3eafc84ae3791ba6d71f4a8f228a53bb2f86`.
[Knowledge activation 36694866129](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36694866129)
activated 43 changed Maya entries and retained 31 matching entries. Readback proved all four pet-care
sources uniquely active. Exact deployed revision and staging isolation passed before and after.
The existing bootstrap API attributes approval to the authenticated staff actor by default; the
activation script does not invent a checker identity or change the lifecycle permission rules.
Activation/isolation tests passed 81/81 and sales/pet-care tests passed 49/49. These checks prove
staging knowledge availability, not an answered voice conversation, payment or provider acceptance.
No calls, rollout changes or production activation occurred during this operation.


## Phone stop and audio repair — current evidence

The participant reported a silent native call after saying hello, followed by another disconnect.
A separate native handset workflow dispatched the repeat call; these results are failed audio proof.
Both the carrier self-test and staging voice-activation workflows are disabled. A later queued native
handset job (36707856407) was cancelled before execution.

[Shutdown run 36707608749](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36707608749)
verified the deployed staging voice mode disabled and UAT, native UAT, self-test, autorun and outbound
sales gates false, preserving unrelated binding names. This proves the shutdown at its readback time;
it does not certify future staging revisions.

Revision `a5291d6e` corrects native PCM terminal frames to the documented carrier minimum and rejects
failed/empty TTS responses before playback. Fifty focused tests and typecheck passed. The historical
logs show a stream error shortly after preparing the greeting but do not establish the exact exception;
the frame defect is concrete, not a proven sole cause of those silent calls.

Revision `12a1b3eff4270145a2c414fd7ebab5220bb58011` adds a persistent user phone-pause gate,
preserves the pause in staging configuration, refuses the voice-activation overlay while paused,
and requires all phone gates disabled before non-dialing demos. Its 195 focused checks and typecheck
passed; these include executed dialing refusal and activation-overlay refusal. Updated manifests track
only these reviewed changes. Unrelated business rules remain authoritative.

[Deployment 36709553463](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36709553463)
is queued for that exact application revision with phone pause enabled and SMS smoke disabled.
[Pause refresh 36709549373](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36709549373)
completed successfully at 11:54 UTC. Readback verified the persistent phone-pause binding true,
voice mode disabled and all five UAT/native/self-test/autorun/outbound-sales gates false, preserving
unrelated binding names. No call was placed. Both dialing workflows remain disabled. The repaired
application deployment remains queued; this shutdown success does not certify deployed audio repair.

Three actual audio demo conversations remain unverified. The first attempt failed its Grooming-answer
acceptance check; the next refused a replaced staging revision before starting. The runner captures
real ASR text, substantive replies, audible response bytes and terminal provider evidence, and verifies
that informational conversations did not create bookings. It uses the approved ElevenLabs voice with
the PawSpace brain, not the native carrier path. It reports input-to-playback elapsed time, not model
latency. No conversation or successful demo is fabricated from the scenario scripts.


## Latest source regression and pending live jobs

All 881 tests in `tests/ai-*.test.mjs`, `tests/voice-*.test.mjs` and `tests/maya-*.test.mjs`
passed at revision `40e298f588ecc9a5cce86f91ef3de12fee02f962`, with zero failures or skipped tests.
They ran in local simulator/sandbox mode and cover the current AI/voice source, not live carrier audio.
The local full `npm test` command hit the three-minute command limit during the build before tests
started; that attempt is not a pass.

Full-repository CI run 36710431959 is queued for that source revision. Non-dialing demo run
36710208909 is pending the shared staging lock and targets repaired application revision
`12a1b3eff4270145a2c414fd7ebab5220bb58011`. Follow those existing runs; do not restart them because
an observation timeout elapsed. The demo runner refuses a replaced revision or any enabled phone
gate. Successful audio conversations, checkout delivery, sandbox payment and provider acceptance
remain unverified. Synthetic success is not authorization to resume handset dialing.
