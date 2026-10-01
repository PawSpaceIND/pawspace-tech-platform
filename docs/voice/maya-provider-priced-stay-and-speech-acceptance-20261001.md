# Maya next-build acceptance

Baseline: certified staging revision `11dbcc13a4f8696ad2db02e34784eb8c9f7e1197`.

## Required baseline evidence

- Three actual microphone/ASR/brain/TTS demonstrations; preserve recordings and final provider transcripts. No telephone dialing.
- Actual model through all-service concierge scenarios: need-led recommendation, one relevant cross-sell, declined extras, health/vet guidance, Funeral bereavement response, Taxi and other service knowledge.
- Actual model through guarded service booking scenarios in an isolated database, with payments mocked. This establishes runtime behaviour only; no payment capture, hosted provider acceptance or handset quality certification.

## First enhancement scope

- Boarding/Sitting: never present a catalogue fallback as the available host/sitter rate. Read only a verified provider-specific quote, explain that availability and acceptance can change, and direct final booking to the app. No voice booking/payment mutation, including an old pending voice offer.
- Concise speech: answer the current question first; ask at most three or four related missing fields; reuse supplied dates, pets and addresses. Keep confirmation separate. One relevant cross-sell only, omitted after refusal, during bereavement, medical/safety concerns and disputes.
- Keep Grooming, Training and Taxi quote/confirmation ownership, exact price, expiry and idempotency checks intact.

## Regression cases

1. Stay provider price present: quote contains that caregiver and quoted total; no capacity reservation, canonical booking or payment order. App continuation is explicit.
2. Provider rate absent or below the approved floor: no fixed/fallback price claim; staff/app review instead.
3. A caller says yes after stay information: cannot execute a stored legacy stay offer.
4. Service switch to a stay supersedes the earlier pending offer; yes cannot accidentally book the earlier service.
5. Ownership mismatch, expired quote, unverified vaccinations and care-window conflicts still fail closed.
6. Existing Grooming/Training/Taxi explicit confirmation paths remain valid and duplicate-safe.
7. Ordinary reply, cross-sell refusal, medical question and Funeral enquiry remain concise and appropriately scoped.

## Premium acceptance remains separate

Record measured reply-start latency, interruption stop and silent gaps. Thresholds already defined in code: p50 reply start <=1000ms, p95 <=1500ms, p95 interruption stop <=300ms, silent gap <=900ms. Missing measurements cannot pass. Human naturalness requires listening/participant acceptance; passing transcripts do not establish it.

## Baseline demos completed before implementation

- Audio run 36827684771 passed all three actual synthetic microphone conversations through ElevenLabs and the PawSpace brain. No phone dial; booking set unchanged. Recordings were 22.24s (Grooming), 17.92s (health), and 22.56s (offer explanation). Input-to-completed-playback durations include caller speech and response playback; they are NOT reply-start latency or silent-gap measurements. The health answer repeated vet advice. The Grooming answer recited four packages, and the booking explanation was verbose. Audio naturalness and carrier performance remain unaccepted.
- Concierge run 36827722490 passed its smoke assertions, but manual transcript review found fixed Daycare prices (499/599 rupees), and a 53-word Taxi explanation that listed the whole intake. The new evaluation explicitly rejects those fixed-price and checklist behaviours.
- Booking run 36827726916 produced five canonical fixture bookings with five MOCKED payment orders. It confirmed the need to remove stay voice checkout under the owner's later policy. No hosted customer booking, captured payment or provider acceptance was proved.

## Implemented safeguards

- Model-facing stay package descriptions omit catalogue price fields and price-bearing descriptions. The canonical app catalogue is unchanged. Current quoted caregiver rates are read through the existing governed commercial quote implementation, with a required provider_rate source and provider identity.
- Stay information records have status app_only, no actions and no confirmation authority. New stay information supersedes an earlier pending executable offer. A yes directs the caller to the app without another model call. Legacy pending stay offers cannot execute. Independent governed AI reservation and booking tools also reject stay mutations.
- Only the fingerprints for ai-conversation-orchestrator.ts, ai-grounded-runtime-provider.ts and ai-tool-registry.ts are updated in existing presentation contracts. Original baseline commits and all UI files remain unchanged. This is an explicitly requested AI behaviour enhancement, not a UI-only change.
- Existing Grooming, Training and Taxi confirmation and replay tests remain in the same executable suite. Phone-test pause, payment approval and API/route structures are unchanged.

## Local validation

91 behavioural/grounding/voice-profile tests pass in both Node loader modes. 159 presentation preservation tests and 18 existing source/voice contracts pass. TypeScript compilation passes. Model and hosted CI validation on the enhancement revision are separate remaining gates.

The medical referral guard now recognises the baseline imperative "please have a veterinarian assess Bruno" as an existing referral. Generic mentions of a vet still receive an actionable contact recommendation. 29 medical/offer tests and the final combined 250-test run pass.
