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
