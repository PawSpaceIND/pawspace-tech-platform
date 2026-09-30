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
was superseded and cancelled before completing; it does not certify that application revision.
[Pause refresh 36709549373](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36709549373)
completed successfully at 11:54 UTC. Readback verified the persistent phone-pause binding true,
voice mode disabled and all five UAT/native/self-test/autorun/outbound-sales gates false, preserving
unrelated binding names. No call was placed. Both dialing workflows remain disabled. This
shutdown success does not certify deployed audio repair. Later deployment evidence is recorded below.

Three actual audio demo conversations remain unverified. The first attempt failed its Grooming-answer
acceptance check; the next refused a replaced staging revision before starting. The runner captures
real ASR text, substantive replies, audible response bytes and terminal provider evidence, and verifies
that informational conversations did not create bookings. It uses the approved ElevenLabs voice with
the PawSpace brain, not the native carrier path. It reports input-to-playback elapsed time, not model
latency. No conversation or successful demo is fabricated from the scenario scripts.


## Earlier source regression

All 881 tests in `tests/ai-*.test.mjs`, `tests/voice-*.test.mjs` and `tests/maya-*.test.mjs`
passed at revision `40e298f588ecc9a5cce86f91ef3de12fee02f962`, with zero failures or skipped tests.
They ran in local simulator/sandbox mode and cover the current AI/voice source, not live carrier audio.
The local full `npm test` command hit the three-minute command limit during the build before tests
started; that attempt is not a pass.

Full-repository CI run 36710431959 and demo run 36710208909 were superseded and cancelled.
They are historical attempts, not live jobs or successful proof.

## Current baseline, failed audio demo and verification

The participant identified the better handset experience as approximately midnight on 30 September.
Historical preflight run 36611595356 records a matching carrier call from 23:47:27 to 23:51:15 IST
on 29 September: completed, 228 seconds, with a provider conversation of 25 turns over 216 seconds.
The transcript includes Grooming package prices, package details and requests for date, address,
PIN and prepaid checkout confirmation. The provider reported no conversation error. No recording
was retained, and this is not evidence of a completed sale. The attended workflow stopped polling
before the carrier finished; its timeout does not prove this call was silent.

The recorded voice configuration used English, `eleven_v3_conversational`, stability 0.45,
similarity 0.75, speed 1, `scribe_realtime` ASR and the `pawspace-grooming-sales` custom LLM.
This is a historical baseline, not a readback of the current live configuration or authorization
to roll back business governance.

Staging deployment 36711874925 certified application revision
`7c6c10f3629a8b2ef046cb223273ffa2d7bc9ffe` with 28/28 checks. The phone pause remained enabled.
This proves that revision's staging certification, not current-head deployment or audio readiness.

Actual non-dialing audio demo 36713972743 recognized “What grooming services do you offer for my
dog Bruno?” but returned only “Sure, give me a second.” It timed out without a substantive reply.
There were 43,520 response bytes, including non-silent audio; these do not prove an answered question.
Read-only diagnosis 36717622217 found two user turns and an interrupted acknowledgement. The
provider marked the session done after client disconnection; no exact root cause has been established.
The three real audio demonstrations remain unverified, and no follow-up phone call is authorized.

The extended local full regression ran 9,726 tests: 9,725 passed and one failed because the reviewed
diagnostic workflow fingerprint was stale. Updating only that fingerprint passed all six preservation
tests. The original full run remains a failed run; it is not a clean current-head full-suite pass.

Source revision `e3f2c657aaf57a9731360617fdf2a4346636f3c7` integrates approved main PR1204:
an explicitly selected ElevenLabs runtime refuses missing credentials rather than silently selecting
another provider. Production configuration preserves the explicit provider pin and validates the
required credentials. No deployment or phone activation was performed. All 955 focused checks and
typecheck passed on this integrated source. Full-repository CI run 36720073296 and exact failed-session
diagnostic run 36718542839 were both authoritatively queued at the latest readback, with no runner
assigned to the diagnostic. Follow these existing handles; an observation timeout is not a failed job.

Checkout delivery, sandbox payment, eligible assignment and provider acceptance, current-head
staging certification and reliable full audio replies still require direct proof. Keep the phone pause,
staff ownership, consent, canonical pricing and explicit booking/payment confirmation boundaries.
Synthetic success cannot automatically resume handset dialing.

### Completed failed-session diagnostic

Read-only run 36718542839 finished on 30 September at 13:29 UTC. Its provenance check failed
because the provider recorded the exact Grooming question twice, at zero and four seconds, rather
than once. The isolated CRM recorded three inbound custom-LLM requests about four seconds apart
and three `service_info` turns from OpenAI, with latencies of 5,667, 4,636 and 3,630 milliseconds.
All three carried `draft_review_required`; no handoff reason was recorded. This label is the
orchestrator's default for informational drafts and does not itself prove that speech was withheld.
The original query did not collect output lengths, so it cannot establish whether those answers
were empty or whether their completed speech responses reached the provider.

A local executed gateway regression now covers the exact question and `pawspace-grooming-sales`
model. It proves that a nonempty informational answer completes the Responses speech stream even
with that draft-review label. All 32 gateway tests passed. The provider remains mocked in this test;
it does not certify live playback. The diagnostic now also reads output lengths and completion
timestamps to distinguish generated answers from interrupted provider playback without exposing
private CRM reply content. No rollout, staff ownership or policy rule was changed.

### Synthetic microphone correction

The demo runner previously stopped transmitting microphone audio two seconds after the scripted
question. The [official ElevenLabs audio interface](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/conversational_ai/conversation.py)
keeps input callbacks active throughout the conversation. The runner now sends paced PCM silence
while awaiting the answer, preserving an open microphone instead of leaving a transport gap.
Only synthetic input changes; no output audio, transcript or answer is invented. Shutdown guards,
scenario checks, interruption rejection and terminal provider verification remain intact.
All 13 existing audio-proof tests passed and the runner syntax check passed. This corrects a concrete
test-transport mismatch, but is not proof that it caused the interrupted session or fixed carrier calls.
