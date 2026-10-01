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

## Verified non-dialing audio conversations

Run 36722940748 refused a replaced staging revision before starting audio. Replacement deployment
36720556802 certified `a7348c36ffc29c3c3ac4b6d2b0e39e2c11631b33` with 28/28 checks. Its voice and
ElevenLabs reply sources match certified 7c6c10f3; the intervening relevant changes concern staging
fixture attestation. Run 36724088995 used the corrected microphone runner at 777e1d01 against that
exact replacement revision and passed three real ASR → PawSpace brain → TTS conversations:

- Grooming: package details and canonical prices, followed by a discovery question.
- Pet health: veterinarian referral before grooming itchy skin, without a sales action.
- Coupons and booking: no approved coupon available in the test context; explained confirmation
  and checkout steps without booking anything.

All three final provider transcripts matched exactly one recognized user question, with observed
bidirectional non-silent audio. The original booking set remained unchanged. Artifact 11101409734
contains the actual transcripts and response WAVs. Local WAV inspection verified mono 16 kHz audio
lasting 31.76, 19.12 and 33.20 seconds. Input-to-finished-playback times were 43,137, 29,047 and
46,538 milliseconds; these include the scripted question and full spoken response and do not measure
model latency or first substantive audio. No handset call was placed. This proves non-dialing audio
reliability for these scenarios, not carrier quality, interruption recovery, premium latency or a sale.

Preflight 36725992881 confirmed the exact replacement revision and isolated staging database,
then refused disabled voice mode, consistent with the user's phone pause. It did not read the
dashboard/policy evidence after that early refusal. The revised local preflight now retains those
read-only observations while disabled and still refuses call readiness. All six preflight tests passed;
the revision is included in the attended-check batch. No call control or business rule changed.
Renewed permission was granted for exactly one attended ElevenLabs Grooming call to the already
authorized tester after remaining checks, with no automatic redial or general calling activation.


Full CI 36722911804 finished with 9,758/9,759 tests passing. The sole failure was the
preservation manifest's outdated hash for the newly added gateway regression, not an application
behavior failure. The reviewed hash was corrected; all 12 local preservation and preflight tests
passed. The original full run remains failed and its final build step did not run.

The attended workflow now opens a temporary isolated ElevenLabs UAT window only for the first
attempt, exact authorized tester and Grooming use case, with native calling and autorun disabled.
It reads the existing policy before dialing and always restores/verifies the persistent phone pause
on completion or failure. No application gate, consent, pricing or booking logic is changed.
The controlled endpoint requires the existing self-test approval flag; this flag is temporary for this
single manually dispatched job while automatic calling workflows remain disabled.

All 16 local attended-window, launch-preflight and preservation checks passed. Both automatic
voice activation workflows were independently verified `disabled_manually` before dispatch.


Attended job 36728533044 refused before opening the window or dialing because the environment's
optional production DB ID was absent. Its cleanup independently verified all phone gates paused.
The window guard now reads authoritative Cloudflare database metadata and requires both the exact
staging UUID and canonical `pawspace-staging` name before any Worker mutation, in addition to the
verified staging binding. A supplied production DB ID must still differ. This retains positive
isolation proof without relying on an unset optional environment variable. All 17 focused checks
passed, including production database metadata refusal. The single-call approval remains unused.


Job 36729012860 again refused before mutation/dial and verified pause cleanup. A fresh authenticated
read (36729556588) proves effective provider `elevenlabs_exotel`, paused/disabled mode and all six
sales operations sources available. Its policy refusal is `voice_enabled`, expected during pause.
The provider pin is encrypted; plaintext settings cannot establish its effective value. The window
now requires authenticated runtime readiness to prove the existing ElevenLabs provider and disabled
gate before mutation, preserving the encrypted binding unchanged. All 17 focused checks passed,
including this executed encrypted-runtime case and non-ElevenLabs refusal.


Attended job 36729798400 opened and read back the isolated window successfully, then the ordinary
policy preview refused `frequency_cap` for prior test dials; no call was requested and cleanup
verified the pause. The existing controlled specialist UAT endpoint already isolates attended tests
from historical frequency while checking consent, opt-out, approvals, exact allowlist and provider.
The attended workflow now relies on that endpoint's authoritative policy before dialing instead of
requiring the ordinary-sales preview to pass. No application policy, cap or consent record changes.
The separate ordinary-sales preflight remains strict. All prior attempts placed zero handset calls.


Attended request 36730202645 returned HTTP 500 and pause cleanup passed. Read-only diagnostic
36730889781 found no call-ledger row and no ElevenLabs conversation in the exact 14:36–14:38 UTC
interval. Worker telemetry was unavailable, so the exception is not conclusively attributed.
The temporary window now also waits for authenticated live readiness to prove effective UAT,
sales approval, single allowlist and self-test approval before the call request. Cloudflare settings
readback alone can precede runtime propagation. Failure to observe effective approval refuses dialing.


## Attended audio succeeded; premium-sales demo failed

The single approved handset request 36731282284 was accepted by PawSpace (HTTP 201) and
ElevenLabs at 14:45:25 UTC / 20:15 IST, with canonical recipient ending 7878, recorded consent
granted, opt-out clear and quiet hours outside. It placed one call. The verifier stopped at
14:47:49 UTC while the carrier was in progress; its `carrier_not_completed` failure is not a
silent-call finding. Cleanup at 14:47:53 verified the persistent phone pause and every dialing
approval/autorun flag false. Both automatic activation workflows remain disabled.

Read-only final provider inspection 36732001764 found one matching phone conversation, 143 seconds,
seven user turns and eight agent turns, provider status `failed`. The failure reason still requires
inspection. The participant reported: “Maya spoke and we had a conversation”, then explicitly
rejected the premium quality: ordinary delivery, no natural human-like voice, no booking
confirmation, recommendation, cross-selling or knowledge of other services. This is an audible
attended conversation, **not a passed premium demo or sales closure**. No further calls are approved.

The code exposes two executable voice specialists (Grooming and Training). The Grooming prompt
explicitly scopes itself to Grooming; this does not meet the requested PawSpace-wide concierge.
Governed booking offer/confirmation code exists but was not demonstrated in the attended call.
Exact dialogue and current safe voice settings are being retained through a separate read-only
review branch so the current PR's full CI is not restarted for diagnostic changes.

Read-only premium review 36732628329 retained the exact conversation and live configuration.
The provider ended the call with `custom_llm generation failed` and
`custom_llm_error: LLM Cascade Error: TimeoutError`. The transcript starts with a Boarding enquiry,
which Maya incorrectly redirected toward Grooming. It also contains repeated provider soft-timeout
filler and an unexpected switch from English to Hindi. The live voice already uses
`eleven_v3_conversational`, expressive mode, stability 0.45 and speed 1; selecting that engine did
not establish acceptable perceived voice quality. The live turn configuration inserts
"Sure, give me a second." after three seconds. Prompt edits alone do not change that setting.

The caller's final confirmation was exactly "Yeah, please." The existing bounded confirmation
parser accepted "yes" but not "yeah". Read-only booking-state inspection 36733719022 found five
offer versions (four superseded, one pending), none confirmed, and zero new bookings during the
call interval. The provider timeout is established; the precise cause of repeated offer creation
is not established. No historical confirmation has been replayed and no booking created afterward.

The local candidate now accepts bounded "yeah"/"yep" confirmations while refusing qualified or
changed-term replies. The executed orchestrator regression uses the exact attended phrase, creates
one canonical booking with payment pending, and proves no second model plan is requested. All 49
sales tests passed. Prompt changes preserve the requested service, permit grounded information
about other enabled services without extending their booking permissions, stabilize conversation
language, and allow a relevant optional cross-service recommendation with existing safety limits.
Those prompt changes require real multi-turn behavioural verification; they are not live fixes yet.

Local typecheck passed. The additional inbound/grounding/approved-offer/persona suites passed 27/27.
The combined sales/profile/preservation run initially passed 60/61: the remaining failure was the
second source-preservation contract's old reviewed hash. After updating that hash, all six
preservation checks passed. Full CI 36731270344 on the prior pushed revision passed lint/typecheck
and 9,765 of 9,766 tests, but failed the static-test-file budget (161 versus 160); its build step
was skipped. Neither that failed run nor focused checks certify the new candidate for deployment.

Premium closure remains open: natural voice delivery and response latency, timeout recovery,
multi-service answers, consultative recommendations, optional cross-selling, live booking
confirmation and final CRM disposition need end-to-end proof. The phone pause remains in force;
the one attended-call authorization has been consumed.

The candidate's deterministic quote read-back now uses natural plurals and rupee wording instead
of `pet(s)`/`INR`, and describes approved coupon savings without reading its code. The canonical
quote, discount, payment terms, expiry and booking actions are unchanged. All 49 sales tests passed
again after this presentation change. The real specialist gateway regression now uses the attended
"Yeah, please." phrase through `runElevenLabsGroundedTurn`; the gateway/follow-up/action-chain/
human-profile/failure-recovery suites passed 40/40. These tests use synthetic customers and mocked
provider responses, not a real sales model, and do not certify natural recommendations or delivery.

The failing full-suite ratchet was corrected by extending the existing audio source-contract test
to execute both real Workers AI adapters: default model selection, audio bytes, transcript and TTS
result, plus absent/malformed binding refusal. No test budget was raised. That test and the static
test ratchet passed 5/5; the candidate typecheck passed. Full candidate certification is still due.

## Failed-conversation reporting and model dialogue evaluation

Model-only latency job 36735786495 passed: the two short synthetic enquiries produced first streamed
text at 753/828 ms and first sentences at 809/909 ms; blocking totals were 1,925/1,687 ms. These
measure the upstream model with a short prompt, not full-runtime latency, booking execution or TTS.

Inspection found that the post-call transcription path always requested successful completion,
including explicit provider status `failed`. The local correction preserves the transcript and
accepted-call correlation, records outbound provider error, marks inbound failure, and uses the
existing human-intervention CRM disposition after customer speech. It does not infer a sale from
the transcript, execute bookings, retry a call or relax identity checks. Nine post-call recovery tests
and 22 tests with the real ledger passed, including the exact attended affirmative in a failed
transcript, terminal error, staff task, reservation release, duplicate prevention and no redial.

Broader preservation checks found seven additional contracts carrying the earlier voice-prompt
hash, beyond the two updated in the prior candidate. Only the reviewed prompt/post-call hashes
were updated; unrelated source and UI contracts remain enforced. The eight relevant presentation
suites passed 174/174 after correction. Typecheck and focused lint passed. Workflow/preservation
checks passed 14/14 after adding the explicit no-call model evaluation job.

`evaluate-sales-dialogue` evaluates six turns through the real upstream model using current channel,
specialist and human-call prompts with synthetic catalogue/knowledge fixtures. It covers Boarding,
needs-led Grooming, walking, approved discount information, declining extras and a medical question.
Only the upstream model credential is provided; the script has no application, customer, database
or telephony access. Raw synthetic replies are retained. Pattern checks are limited smoke checks,
not semantic certification or proof of a live booking/CRM journey; premium certification is always
false. Its local mocked harness proved request scope/history handling only. Real-model results
must be inspected separately before any claim about conversation quality.

Real-model run 36736854461 on afab0454 completed and all six smoke checks passed. Manual review
is stricter: Boarding was answered, Complete Makeover was recommended with a concrete reason,
Walking was explained when asked, the customer declining extras was respected, and itching was
referred to a vet without medicine/doses. The first reply nevertheless asked the number of nights
after the customer had supplied two. The discount reply read `GROOM200`; the evaluation assembled
the channel/specialist/human prompts but omitted the runtime's separate voice-coupon directive,
so this is not proof that the complete runtime prompt violates its coupon rule. The evaluator must
share that directive and reject spoken codes. The Walking turn took 4,606 ms (blocking whole-response
time, not first audio latency). Cross-service information on request is not proof of proactive
cross-selling. These are remaining acceptance gaps despite the workflow passing its smoke checks.
The raw six-turn report is retained in the `maya-synthetic-sales-dialogue` artifact; it makes no
premium, runtime-booking, CRM, TTS or handset certification claim.


## Explicit quote preparation and current runtime proof

Full CI 36736852447 on afab0454 passed lint/typecheck and 9,767 of 9,769 tests, but failed two coupon-format assertions. The natural spoken quote formatter had also changed web chat presentation. The correction keeps the original chat/WhatsApp INR and coupon-code display; natural rupee/plural wording and omission of spoken internal codes apply only to voice. The voice test verifies the exact stored approved coupon and unchanged checkout authority.

Stricter real-model dialogue run 36737694339 passed its six smoke checks. Manual review confirmed preserved two-night context, a reasoned Complete Makeover recommendation, proactive Walking after a stated exercise need, approved savings without reading the code, respecting declined extras, and veterinarian referral. Whole-response durations were 7,998/2,270/1,647/4,049/1,328/5,276 ms; these are not first-audio measurements and variability remains an acceptance gap.

The new isolated runtime evaluator supplies only a model credential. It uses the actual PawSpace gateway, orchestrator, quote, scheduling and booking modules against an in-memory synthetic database; only reviewed Grooming package defaults are activated in that fixture. Payment order requests are mocked and all other network destinations are refused. No production pricing/catalogue guard was weakened, no live database was accessed and no phone was dialed.

Real-model runs 36740533203 and 36741533005 correctly failed: an explicit request to prepare a quote produced no offer. The first classified the request as service information; the second, after corrected intent, interrupted it with an unsolicited coupon question. The reviewed correction recognises the bounded explicit preparation command, asks for missing facts only, and instructs the model to propose the registered three-step chain without requesting permission again or inserting optional offers. Preparation still creates only an unconfirmed quote; execution still requires a separate exact affirmative. Information-only, policy, ownership and emergency gates remain enforced.

Real-model run 36741880203 on 65aa57d3 passed the actual runtime sequence: Complete Makeover recommendation with a concrete reason (2,723 ms), canonical 2,399-rupee offer (1,977 ms), then the exact attended “Yeah, please.” confirmation (228 ms). Confirmation made no additional model request. Exactly one synthetic canonical payment-pending booking and one mocked payment order were created; repeated confirmation was prevented. This does not prove live checkout delivery, payment capture, provider acceptance, CRM closure, TTS naturalness or handset latency. Premium certification remains false.

The latest focused sales/chat/gateway regressions passed 64/64, presentation preservation passed 174/174, and typecheck passed. Scoped lint had no errors and one existing unused-variable warning in the gateway test. These fixes are proposed in PR 1199 and are not deployed. Calling remains paused; no further handset authorization exists.


## Runtime concierge and response-window recovery

Full CI 36742146306 on 1cd48b7f passed lint, typecheck, all 9,770 tests and the isolated artifact build. This certifies the earlier booking candidate, not the subsequent recovery changes.

Actual-runtime concierge run 36743213525 exposed a 30-second upstream stall on an ordinary decline-of-extras turn, followed by staff handoff. The recovery wrapper did not retry timeouts and allowed one generation to consume its entire budget. The correction bounds buffered voice generation to ten seconds total, respects a tighter configured ceiling, leaves time for one recovery attempt and never retries after streamed speech or action execution. Two executed regressions use actual abort signals: a stalled first draft recovers once, and two stalls exhaust one shared deadline without a third request. Provider adapter tests passed 28/28; sales/gateway/profile/failure tests passed 107/107; presentation preservation passed 174/174; typecheck passed.

Read-only agent inspection 36744158897 verified the actual staging custom-LLM response window was four seconds, against the application's earlier 30-second deadline. Its voice was already eleven_v3_conversational; voice metadata access still returned 401. No voice IDs were invented or changed. ElevenLabs documentation permits a 2–15-second cascade timeout and states that custom LLM failures retry that same custom endpoint, rather than another hosted model. Increasing the response window addresses a timeout mismatch; it does not certify conversational latency or naturalness.

Runtime concierge run 36744164524 answered the other services but failed because the approved-offer instruction required saying a code while the voice instruction forbade it. The shared instruction now explicitly separates text channels from voice presentation, preserving the same eligible offers and price checks. Run 36745190415 then passed six actual-runtime smoke checks: Boarding with the supplied two-night duration, Complete Makeover with a reason, relevant Walking, declining extras, conditional approved savings without saying its code, and medical information with a vet referral and no sales. The six blocking durations were 2,213/1,640/2,196/1,567/6,966/1,611 ms. Seven model requests served six turns, so recovery was exercised, but this is not first-audio latency. The approved knowledge was activated only in the in-memory fixture. No real customer, CRM record, booking, payment or phone was touched.

Staging configuration run 36745195092 verified both specialist agents persisted a 15-second response window. It retains their existing voice IDs, current conversational engine and existing routing. The tuner now refuses a non-staging custom brain, verifies the applied window, and replaces the repeated static “give me a second” wording. Nine language configurations still do not imply nine dedicated voices or premium certification. Phone calling remains paused and both automatic dialing approvals remain disabled.

The two repeat booking runs 36742207631 and 36742213776 also passed: across all three reviewed booking journeys, confirmation took 142–228 ms with no new model generation, one pending-payment booking, one mocked order and duplicate prevention. The newer recovery candidate still requires fresh full CI and exact-head isolated staging speech proof. No production merge or campaign activation has occurred.

### Main integration and spoken-offer validation

Integrated main snapshot `a6036d82a871bb91ecaa4d7a213d89ed051cccac` into the voice candidate, retaining its central provider-reply/catalogue validation and deterministic emergency guidance. Preserved explicit immediate-vet wording on medical handoffs. The stronger catalogue check exposed a voice-only display issue: an approved savings amount without a spoken coupon identifier could be mistaken for an invented service price. Voice now permits an exact eligible discount tied to its canonical package in the same sentence; chat still requires code grounding, discounted totals still require governed quote readback, and coupon redemption rules are unchanged. Negative tests reject invented amounts, unrelated-service savings, ungrounded discounted totals and fake codes.

Current integrated-source checks: 167 focused executed tests passed, typecheck passed, changed engine files passed lint. Earlier broader main-integration checks passed 291 tests before this final offer patch. The previously green 9,770-test full CI belongs to the older candidate, not this integrated source; fresh full CI remains required.

Staging deployment run `36745734405` deployed candidate `1ba5bb801b4097a60e1a5ef986975633be9b9e95` but failed certification (26/28): the synthetic customer OTP/session check encountered `fetch failed`, so customer authentication and six-persona aggregate certification did not pass. The deployment is not certified for a renewed audio demo. No phone calls, redials or campaign activation were performed. Phone tests remain paused. Premium naturalness, latest-source speech proof and actual payment/provider acceptance remain open.

### Fresh real-model results and deterministic speech display

On integrated head `96a078f3`, actual-runtime booking evaluation `36748134400` passed. Concierge evaluation `36748140545` failed because the model still spoke `GROOM200` despite its voice prompt. This failure is retained; it demonstrates why prompt compliance alone cannot certify premium speech. Added voice-only display rendering of eligible approved identifiers after verifying the original draft's prices and offer claims. Unknown codes and invalid prices are never hidden; explicit requests for the code retain it. Amounts, conditional checkout language, proposal actions and text/streaming behavior remain intact. Focused validation after this change: 133 tests passed, including the provider execution/recovery suite; typecheck passed. Fresh real-model concierge and full CI remain required for this source.

### Grounded offer enquiries

Concierge evaluation `36749615431` failed correctly at the price guard when the model spoke a discounted estimate without a named approved code. Rather than weakening catalogue checks, explicit voice enquiries about a named package's closing offer now receive an informational answer built directly from that customer's eligible server-owned offer facts. It states the exact saving and regular single-pet catalogue price, requires checkout validation, and proposes no action. Quote, application, acceptance, reservation and booking instructions bypass this informational answer and continue through the existing governed flow. A paused closing campaign is not replaced by a cross-sell campaign. General model-generated offer discussion still undergoes original price/code checks and verified speech rendering.

Validation: 106 focused tests, typecheck and changed-file lint passed; 11 offer tests additionally passed after adding action-request exclusions. Actual concierge, latest-head full CI, speech quality and staging certification are still open. Deployment `36749697406` is verifying the preceding speech-rendering candidate `edcc923a`; it does not certify this later informational-offer fix.

### Current runtime/staging proof and release security patch

Candidate `6b7638101ea601e3060ec3c9d75899c878dfb3c5` passed actual-runtime concierge `36750104172` and booking `36750109022`. Concierge made zero bookings/payment orders; the server-fact offer answer took 15 ms, while other whole-runtime turns took 1.7–2.4 seconds before TTS. Booking produced a pending quote, then exactly one payment-pending booking and mocked order after separate confirmation, with duplicate prevention. These are actual-model synthetic database proofs, not delivered checkout/payment capture/provider acceptance or speech certification.

Staging `36750295224` certified the same candidate with zero failures: all six personas authenticated, six smoke routes answered, and all 30 seeded service-zone roster pairs present. Earlier preceding-candidate staging `36749697406` also certified. The earlier transient customer-authentication fetch failure did not recur; these passes do not establish its precise historical cause.

Security job `110006742269` in `36750110878` rejected installed Next.js 16.3.4 for newly published critical advisory GHSA-vcvr-r3jv-pc5j. Upgraded only Next.js and its matching env/SWC packages to 16.3.8; React and other dependency versions remain unchanged. The high/critical npm audit, typecheck, verified application build and focused presentation preservation tests passed. Moderate transitive advisories remain, without a forced/breaking Capacitor upgrade. Fresh final-head CI/staging/audio verification remains required after the security patch. Phone calling stays paused.

### Latest native lifecycle integration

Main advanced to `f49dbabd` (PR1208) with native audio lifecycle fixes. Integrated its typed PCM/WAV validation, closed-socket protection, matching playback marks, bounded private telemetry and ledger failure reconciliation. Retained this task's 3,200-byte minimum terminal-frame padding and `provider_failure` outcome for failed AI calls. The prior phase-only diagnostic assertions now verify the equivalent bounded stage/code/elapsed schema; carrier-padding assertions still require unchanged source audio and silent padding. No native calling approval or rollout changed.

Verification: 63 native/audio executed tests passed; 281 sales, guardrail and presentation-preservation tests passed; typecheck passed. Native lint reported zero errors and one pre-existing unused-variable warning. Current combined candidate must still pass fresh full CI, staging certification and actual speech review. The goal remains active, phone calls remain paused, and production/campaign release is not approved by these checks.

### Combined staging certification and first multi-turn speech observation

Staging deployment `36751478020` certified combined build `2cbc34b060ff8446a7ba0d960f4c2c30c10584d6` with zero failures, six authenticated personas, six smoke routes and all 30 roster pairs. Its full regression run `36751393528` was still running at this observation; staging certification is not a full-suite or premium-audio pass.

Diagnostic-only branch `diag/maya-premium-audio-proof-20260930` adds three guarded multi-turn informational ASR/brain/TTS sessions. It independently proves phone shutdown, exact staging revision and canonical tester ownership, checks booking/payment sets after each turn, and captures provider-final transcript evidence. It contains no dialing operation or affirmative booking instruction. It explicitly reports premium/carrier/sale certification false. These exercises do not certify confirmed bookings or payment delivery.

First run `36752470336` failed on the no-extras follow-up. Real speech recognized the requests and recommended Complete Makeover correctly, but the third response repeated package/pricing details and a checking acknowledgement instead of acknowledging the narrow preference. The transcript also used INR abbreviations. Initial first-audio measurements were about 2.7–3.1 seconds and may include acknowledgements; they are not certified substantive-speech latency. The failure remains in the evidence.

Added a narrow voice-only preference acknowledgement for explicit no-extras/one-service informational turns; price questions, quote amendments, cancellations and booking instructions remain with the existing flow. Verified English amounts are rendered as rupees without changing values, conditions or IDs. Chat, streaming and regional-script wording remain intact. Localized/explicit language-switch offer enquiries stay with the language-aware model. Validation after this change: 283 sales/guardrail/presentation-preservation tests and 13 focused offer/presentation tests passed, plus typecheck and lint. Fresh source deployment and audio retest are required; calls remain paused.


### Exact-source staging, recorded speech and corrected verification fixtures

Candidate `35ff709c` passed staging deployment/certification `36755397621`: zero failures, six authenticated personas, six smoke routes and 30 roster pairs. Full regression `36754856845` remains running at this observation. PR1199 hook-path job `110023379224` failed because its specialist gateway fixture expected a customer reply at `staff_only` rollout. The actual rollout guard correctly returned a controlled pause without invoking the model. Corrected only the fixture to `customers` and added a reverse check proving `staff_only` blocks subsequent generation; all prior draft-review/output assertions remain. The gateway suite passed 32 tests and the broader gateway/action-chain/offer regression passed 52. Runtime rollout rules are unchanged.

Actual audio run `36757780538` captured all nine informational turns, with non-silent recordings. Grooming package fit/reasoning, both no-extras acknowledgements and walking recommendation were observed. The offer answer correctly reported no currently eligible offer rather than inventing one. General itching and rabbit hygiene answers included vet guidance without coupons. The final scenario check failed because `/GROOM/i` matched ordinary `grooming` text; the diagnostic checker now requires an actual `GROOM` numeric identifier and still rejects coupon, discount and booking language. The failed run remains failed; rerun `36758656185` is pending. Raw observed speech is preserved in the evidence directory, not substituted or rewritten.

Speech remains below premium acceptance: observed reply-event latency for several turns was 5–11 seconds, first-audio timing may include checking acknowledgements, and boarding intake was too verbose. These nine informational turns do not certify phone delivery, confirmed booking, delivered checkout, verified payment, provider acceptance or human transfer.

Read-only launch check `36758354838` found all six sales dashboard sources available and zero unavailable sources. It failed as expected at the existing user phone pause: mode disabled, enabled false, policy allowed false. No phone calls or campaign activation occurred. This operational availability is not sales-outcome certification.


### Completed informational audio proof and measured staged brain delay

Diagnostic-only rerun `36758656185` passed all three actual ASR/brain/TTS conversations and nine informational turns on certified application `35ff709c`. Provider final transcripts matched and non-silent audio was observed, with booking/payment ID sets unchanged. This is not a ten-turn natural phone call, confirmed sale, delivered checkout, payment capture or provider acceptance certification. Actual reply-event delays remained roughly 6–12 seconds on several turns; boarding intake and nonurgent itching replies were too verbose.

Staged brain timing probe `36759554907` passed: first validated text was 3,003 ms (grooming), 3,081 ms (boarding), and 647 ms (no-extras). Grounding/reservation marks completed within about 0.2 seconds; the remaining time includes generation and response handling. These three measurements exclude ASR/TTS/handset and do not certify percentile targets. Initial diagnostic `36759222675` was correctly refused because the script supplied a simulator AI call ID as an outbound voice-order ID; corrected diagnostic uses the canonical customer/thread context, as the working audio harness does. Failed evidence is retained.

Voice-only answer guidance now prioritizes a concise answer, essential intake categories and one missing-detail question, with explicit exceptions preserving binding price/eligibility conditions, requested facts, quote readback, separate confirmation and veterinary/emergency guidance. No truncation or changes to mutation, pricing, permission or delivery behavior were introduced. The real-model concierge verifier additionally enforces scenario limits of 70 boarding words and 80 nonurgent medical words; this does not certify global naturalness. The medical coupon check now distinguishes numeric campaign codes from ordinary grooming advice while retaining sales/medication exclusions.

Validation before pushing this pacing candidate: 54 specialist/offer/service-directory executed tests and 215 guardrail/presentation-preservation tests passed; typecheck and changed provider lint passed. The previously pushed fixture-only `114a9216` also required its reviewed gateway-test fingerprint refresh in the mainline preservation contract; that one-key refresh is included here. Fresh model/audio/full-suite results are required after the pacing change. Phone calls remain paused and the goal is active.


### October 1 verification repairs and completed model evaluations

Exact candidate `d22759d5` passed protected real-model evaluations `36760370202` (concierge) and `36760374408` (booking). The former covered service recommendations, boarding/walking, declining extras, an eligible synthetic offer, and general itching advice. The latter required quote readback and separate confirmation, then created one canonical payment-pending booking with a mock payment order. These synthetic-database evaluations do not prove live WhatsApp delivery, payment verification, provider acceptance, premium audio or handset behavior.

The local full suite exposed three test expectations needing correction: the old voice-persona wording, a UTC month fixture compared with governed India-time TDS periods, and a same-period GST amount fixture crossing the intentional UTC-ledger/India-time-return boundary. Only those test fixtures changed; tax and finance implementation remained intact. The premium quality helper now also requires a measured positive call duration within the existing 600-second ceiling; this helper is not evidence of live-call certification.

A separate confirmed test-reader defect stalled the full suite: overlapping escape alternatives caused catastrophic regular-expression backtracking on an unfinished source literal. A bounded reproduction timed out at 1.5 seconds. Disjoint alternatives preserve SQL inspection and now complete the repository-wide column check in about 0.54 seconds, retaining the requirement to find more than 500 tables and zero dangling references. Added regressions retain SELECT/INSERT/UPDATE missing-column detection and require a quote/escape storm to complete without suppressing violations. The identified runaway local process was stopped after this diagnosis; that partial full run is not a pass. Consolidated regression passed all 52 tests with zero skipped or cancelled. Fresh full-suite verification remains required.

No new phone calls, campaign activation, production deployment or merge occurred. Staging workflow was manually disabled during the earlier dispatch attempt; it now reads active, but the pending question about an intentional freeze has not been answered, so deployment remains on hold.


### Package-specific spoken price verification

A read-only reproduction showed the reply price guard accepted “Grooming Just Trim costs 1349 rupees” when Just Trim was 1599 and Essential Bath 1349; it also accepted swapped prices when both package names occurred. Amounts are now tied to adjacent explicit catalogue package names within the relevant sentence/amount span. Approved discounted prices remain valid only for the matching package identity and named approved code. Generic service starting prices remain supported. No catalogue price, coupon eligibility, checkout calculation or business mutation changed. Added regressions cover wrong-package prices, swapped prices, correct comparisons, amount-before-name phrasing and separate starting-price sentences. The approved-offer fixture now includes the canonical package_code needed to establish that identity.

All 52 grounding/offer/orchestrator tests passed after the completed change; 175 presentation/unchanged-module checks passed after refreshing only the nine reviewed provider fingerprints. Typecheck passed. An initial focused run failed because the new package binding also rejected a legitimate approved discounted amount; matching approved offers by canonical package identity fixes that case while preserving code requirements. Failed evidence remains retained. The concurrent full run started before this provider change and cannot certify the final source; fresh exact-head CI is required. Calls and deployment remain paused as above.


### Observed serialized model proposal and test-ratchet closure

Real-model concierge run `36764915014` passed on `1a3b021a`. Booking run `36764916913` failed: the model serialized the three-action proposal inside the reply string, with an empty inner reply, so no quote was prepared and JSON reached the customer-facing output. No booking or payment request occurred. This is retained as a real failed model evaluation, not attributed to the price guard.

The grounded parser now normalizes exactly one reply wrapper using the existing registered-tool and six-action limits. Competing outer/inner plans, deeper wrappers and unregistered tools are refused. An empty valid action reply receives neutral checking text before the canonical quote replaces it; malformed structured output produces a controlled provider failure, never raw JSON speech. The executed specialist gateway regression reproduces that exact nested/empty structure, verifies a canonical quote without JSON leakage, zero pre-confirmation bookings, then one customer-confirmed booking and duplicate protection. Canonical tool permissions, quote authority and separate confirmation are unchanged.

The chat-visual workflow `36764901071` failed before browser execution because a new standalone test-helper regression counted against the static-test ratchet. Moved the same regressions into the existing schema meta-test; did not increase the 158-file budget or remove coverage. Schema/meta checks now pass. Local full run begun at `4ec6886b` completed with 9,979 passes and that single static-file-budget failure; it overlapped later source edits and does not certify the final candidate. Current focused validation: 72 action-chain, grounding, offer, gateway and schema/meta tests passed; 175 preservation checks passed; typecheck passed. Fresh final-source model evaluations and full CI remain required. No deployment or phone call occurred.


### Final brain verification and current staging fixture integration

Application `4d1ff2b4` passed exact-source local npm test: artifact build plus 9,981 tests, zero failures/skips/cancellations, Node 24.19.0. Protected actual-model runs `36765721229` (concierge) and `36765723909` (booking) both passed on that exact source. The booking report records two model calls, one mocked payment request, one payment-pending canonical booking, duplicate prevention and unverified payment. Concierge records six informational turns, four model calls and zero bookings/payments. These remain in-memory fixtures, premiumCertified=false, with no TTS, live CRM, delivered checkout, payment capture or provider acceptance. GitHub Node 22 full verification remains separately pending.

Authoritative deployment history revealed a newer successful staging certification `36760836298`, revision `821db4da`, from PR1210's fixture-isolation branch. It has zero certification failures, six personas/routes and thirty roster pairs. This replaces the assumption that staging still serves the previously recorded `35ff709c` audio candidate; old recordings are historical proof for their exact source only. The Maya candidate has not been deployed.

Reviewed and integrated PR1210 source `f0e29da3` into this candidate: a read-only Founder-authenticated staging fixture snapshot, platform version/build-SHA attestation, ambiguity/recipient-exclusion guards, retained phone shutdown, and the offline Sitting sandbox payment/completion browser scenario. Production and other scopes refuse the narrow handler; it performs SELECT-only reads, no seeding, login, send, booking or payment. Integration retained the latest Maya provider/orchestrator/adapter/specialist/custom-LLM files unchanged. Merge preview and integration had no conflicts. All 288 fixture/config/gateway/launch-boundary/presentation checks passed, typecheck/build passed, changed-file lint had zero errors and one existing worker unused-variable warning. Fresh full verification is required for the merged source; no deployment or call occurred.

The fixture snapshot is not assignment, booking authority or production signoff. The strict scope proves only the fixed Grooming test choice and explicitly leaves automatic assignment/recovery coverage false. Legacy default provider identities lacking independently proved synthetic contact/login records remain an open prerequisite for whole-roster automatic-assignment UAT; do not invent contacts, omit selectable rows or treat a narrow pass as covering them. Staging freeze clarification remains pending; phone-call authorization remains exhausted.


### Hosted fixture inspection and browser harness repairs

Authenticated read-only diagnostic run `36768792932` inspected exact staged application `821db4da` and the same Worker version for both fixture scopes. Runtime and platform evidence confirmed phone shutdown, sandbox payment/payout isolation and recipient exclusions. The strict fixed Grooming snapshot passed (HTTP 200); the whole Bengaluru roster refused attestation (HTTP 409), with `bengaluruCapacityRosterProven=false` as its sole failed check. This proves an open whole-roster prerequisite, not the identity or cause of a particular missing row. No call, booking, capture or database write occurred. Fixed-provider evidence cannot certify automatic assignment or recovery.

Reviewed and integrated source `29525b0a` bounding diagnostic input/output and artifact paths; its 29 voice-audio proof tests passed. Reviewed source `84926ea4` follows the actual Finance MFA enrollment/verification UI and Operations landing, preserving permission checks and sandbox-only capture.

Browser CI on `ca98e421` failed at a stale Finance `/me` expectation; on `84926ea4`, 12 desktop cases passed and Sitting failed because the login response body was read after navigation discarded it. Capture the response body immediately, retain its finance-role assertion, scope the recovery status assertion to its message, and follow the current service-address region and human-readable “in progress” label. These are test-harness repairs only; no application handler, permission, MFA, payment, pricing or provider logic changed. Retained local failures include an account-request connection reset and the stale address/status assertions; none is counted as a pass.

The corrected focused desktop Sitting journey passed in 42.9 seconds (59.3 seconds including startup). Persistent evidence records one completed booking across customer/provider/Operations, captured sandbox payment, accrued payout, resolved tax and balanced ledger. The journey also checks unpaid acceptance refusal, real Finance MFA, duplicate capture protection, recovery/replacement, denied GPS permissions, accepted-doorstep geofence, zero automatic refund and unchanged paid care window during unresolved requests. This is an isolated local database and staff sandbox simulator, not live payment, hosted provider acceptance or Maya audio certification. The focused Pixel 7 mobile journey also passed in 36.6 seconds (50.9 seconds including startup), with the same persisted completion and balanced-finance checks. Typecheck and changed-file lint passed. Calls and deployment remain paused under the existing boundaries.


### Cross-navigation Finance evidence correction

GitHub browser run `36771235289` on `87ad4a9c` retained 12 passing desktop cases but reproduced Chromium discarding the Finance login response body even when it was consumed in the response callback. The corrected harness retains the real UI POST status assertion and reads the persisted signed-in email/Finance role through a fresh authenticated GET before asserting the actual MFA UI and pre-MFA finance refusal. It does not bypass MFA, mock identity, retry mutations or change application behavior. Focused desktop completion passed again in 26.1 seconds (37.5 seconds including startup); typecheck and changed-file lint passed. This latest test-only change needs exact-head GitHub verification; previous local desktop/mobile passes do not erase the failed CI evidence.

Read-only configuration run `36771722068` confirms the staging agent still uses the isolated custom brain, `eleven_v3_conversational`, expressive mode, speed 1, stability 0.45, cascade timeout 15 seconds, turn timeout 10 seconds and a 3-second checking acknowledgement. It placed no call and changed no configuration. Voice metadata remained unreadable (401); the approved existing English pilot voice remains selected, without new localized voice or premium speech claims.


### Additional reviewed diagnostics and Boarding completion coverage

Remote commits `ac06ea00` and `34d1014c` were reviewed and fast-forwarded. They change only diagnostic scripts/tests and the local customer browser scenario; Maya runtime and business-rule files are unchanged. Diagnostic parsing now produces generic errors without reflecting malformed JSON/socket URL secrets, and keeps conversation correlation in memory instead of diagnostic exports. All 32 audio/privacy proof tests passed locally.

The added local Boarding scenario reached sandbox capture but timed out at a stale “Save canonical care plan” locator; the rendered customer control is “Save care plan.” Corrected only that locator, preserving the actual save response and all later assertions. Focused desktop completion passed in 30.6 seconds (44.0 seconds with startup); Pixel 7 completion passed in 27.3 seconds (39.5 seconds with startup). Both retain unpaid-host refusal, unrelated-host refusal, captured-event replay protection, independent media approval (uploader self-approval refused), care activity, host completion, customer/Operations/Finance persistence and balanced sandbox ledger. Finance uses the documented local seeded dispatch/MFA fixture; this does not certify hosted Finance enrollment, live money, Maya speech, message delivery or automatic hosted provider assignment. Changed-file lint passed. Failed artifacts are retained.

Full CI `36772059086` on `790847e4` was cancelled when the remote branch advanced; it is not a full pass. Its exact-source persona browser run passed 13 desktop plus 13 mobile cases, and hardened browser run passed 90 cases with the existing project-independent auth check skipped only on mobile. Fresh CI remains required for the current source and locator correction. Source-pinned runtime/audio evidence retains its earlier limits. Staging-freeze and approved-provider-fixture clarifications remain unanswered; calls remain paused.

### Exact-source CI and fallback-loader response-body repair

Source `3e01e7067fa6a7433733b17198960d832c031eea` passed Pre-UAT run `36775899937`: Node 22.16.0, 10,066 tests, zero fail/skip/cancel, followed by the staging-isolated build. The persona gate passed 26 desktop/mobile cases, hardened browser 90 with one documented mobile precondition skip, visual audit 147, Grooming browser 286, and all compatibility/offline gates. Real Razorpay sandbox order creation passed; capture was not attempted and refund was skipped. These are controlled tests, not hosted Maya speech/sales acceptance.

Release CI `36775899722` passed Web tests (10,056 plus ten separately isolated tests) and the first hook path (5,634). Its fallback loader reported one failure in the scheduling cancellation regression: a second `Response.clone()` on a previously cloned response threw `Body has already been consumed`. Read each reserve/booking response once and retain the parsed body for assertion diagnostics. All status and cancelled-request recovery assertions remain; no runtime code or canonical policy changed. Focused Node 22.16.0 normal and forced-loader paths each passed all 11 tests; changed-file lint passed. Fresh current-source CI remains required.

The active staging workflow and existing user deployment approval permit the isolated refresh once exact-source CI passes. Environment settings were separately read and verified: phone pause true, voice disabled, outbound false. No explicit freeze instruction was received. Approved provider mappings remain unresolved, and the previous attended-call authorization is exhausted. Diagnostic branch `b816af89` retains the reviewed bounded parser/private-report safeguards; 32 focused tests passed. No deployment or call occurred during these repairs.

### Mobile Boarding hydration readiness

Persona run `36779487075` on `2907c13e` passed all 13 desktop cases and 12 mobile cases; the remaining mobile Boarding case timed out selecting the host request. Trace inspection proved the tab click ended at monotonic 81,510 ms, before the host stay read began at 81,542 ms. The API subsequently returned the correct owned open offer. The failed host screenshot still showed Today selected and the privacy panel visible. The test had acted on server-rendered controls before client readiness; no booking or ownership rule failure was observed.

Wait for the client-rendered pending-request badge, dismiss the now-rendered privacy panel, select Requests and verify its heading before selecting the booking. The same timeout and canonical assertions remain. Focused mobile and desktop sandbox completion both passed (32.1 and 32.3 seconds), including unpaid/foreign-host refusals, capture replay, independent proof review and balanced finance. Changed-file lint passed. All changes since the passing 10,066-test `3e01e706` source remain tests or this ledger; application code is unchanged.

Existing deployment approval permits isolated staging verification in parallel with final CI for these test-only repairs. Staging must retain exact-source attestation, dedicated D1, sandbox payments and phone shutdown. Final CI, hosted sales proof and fresh attended-call approval remain required before sign-off; no production release or phone activation is authorized by these test passes.


## Hosted quote wording regression (1 October)

Exact source `78816df4` passed all27 workflows, including full10,066 tests, both Node22 hook paths5,634 each,26persona,90hardened (one retained mobile precondition skip),147visual,286Grooming and all200mobile compatibility cases on the unchanged-source rerun. Actual audio36782552664 passed three informational ASR/brain/TTS sessions and nine turns; useful reply-event median5.91s remains a premium gap. These checks do not certify a complete hosted sale.

The guarded hosted quote probe36786494207 did not produce a pending offer. Readback36786783988 verified unchanged booking/payment/address/reservation records and no confirmation; read-only inspection36787080536 found queued `policy_risk` handoff with `blocked_high_impact`. The exact wording was reproduced locally: “an unconfirmed quote” did not match quote preparation, and the negative instruction “do not reserve or create a booking or payment order” caused the unknown-intent fallback to treat the word payment as a positive financial request. The separate diagnostic caller now explicitly selects one uniquely named owned pet from existing records; it does not change application pet selection, ownership or business permissions.

The language fix recognizes unconfirmed/draft quote preparation and removes only explicit negative payment clauses from its fallback risk-text check. Human/refund/emergency classification still precedes it; remaining positive or mixed payment commands stay risky. Quote preparation remains different from execution: no reservation, canonical booking or payment order until separate confirmation. The executable gateway regression now uses the reproduced wording, asserts zero order requests before confirmation and exactly one after, retaining canonical pricing and duplicate protection. Actual-model booking evaluation also exercises this wording. Node22 normal and fallback gateway/handoff/tool-governance regressions each passed34; typecheck passed and scoped lint had zero errors with one pre-existing unused test-fixture variable warning. The new runtime source still requires full CI, isolated staging certification and hosted quote proof. The queued synthetic handoff has not been cleared; phone calls remain paused.

### Quote-parser source contract alignment

The `eff7b1f7` quote interpretation repair changes the orchestrator source fingerprint intentionally under the expanded Maya intelligence scope. Nine presentation contracts now pin that reviewed orchestrator fingerprint; no protected entry is removed, no unrelated source is rebaselined, and all UI event/binding and business execution assertions remain. The old hash failures are retained in the evidence ledger. New CI must pass before staging deployment.


## Hosted proposal and offer follow-up (1 October)

Source `1e62e969` passed all 26 CI workflows and isolated staging deployment `36792027541`, including exact-source/sandbox bindings, six personas, six routes and 30 service-zone pairs. Full CI passed 10,067 tests; the release hook paths passed 5,634 each. Authenticated readback verified phone shutdown. Governed cleanup `36793063392` resumed only the exact self-generated prior quote incident through the existing staff takeover/resume handlers, with all other handoffs and booking/payment/address/reservation records unchanged.

Hosted quote `36793188958` still produced no pending offer. Read-only exact-input receipt `36793816202` identified a model reply treating proposal tools as immediate mutations despite the customer's request for an unconfirmed quote. Clarify that proposal actions trigger preview and quoting only; a later separate confirmation authorizes execution. Retry an absent proposal once for an explicit quote request, allowing genuine missing-field questions and retaining all server validation. No mutation retry or new execution permission is introduced.

Actual audio `36793666839` passed six informational turns (package recommendation/reason, boarding, walking and declined extras), then failed on the approved-offer enquiry with a policy-risk handoff. Persisted receipt `36794584657` identifies an OpenAI reply, not the server-owned offer response. A named-package enquiry with no eligible approved offer now receives a factual server-owned answer without an improvised coupon or price. Eligible offers still require existing price validation; the positive test activates only the seeded synthetic canonical package in its in-memory fixture. Missing live price authority remains a refusal.

Normal and forced-loader Node 22 gateway/offer regressions each passed 72 tests, including bounded quote retry, genuine clarification, eligible/no-eligible offer responses, no booking/order before confirmation and unchanged ownership/duplicate protection. All 175 scoped UI/source contracts passed; typecheck and changed-file lint passed. Nine protected contracts update only the intentionally changed AI provider fingerprint; UI handlers and other protected entries remain. New exact-source CI and staging certification are required before another hosted attempt. The new audio-triggered handoff is still queued; it has not been reset. Phone calls remain paused, and no confirmed hosted sale, delivered checkout, capture, provider acceptance, interruption or premium voice acceptance is claimed.
