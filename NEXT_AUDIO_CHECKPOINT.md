Audio owner implementation checkpoint — 2026-10-02

Source: main 7a5cbd02c9aa42548e79c0879300950772b8b979, isolated branch codex/native-next-ten-audio.
EV acknowledged AUDIO PAUSED at18:07UTC; fresh GitHub read found unchanged main and no in-progress workflow. Existing gh authentication is usable. No new credentials or grants.

Implemented:
- Separate immutable additional-$5 budget ID; earlier unresolved charges do not hold this pool.
- Native duration reservation before lease issuance, up to10 conversations, maximum120seconds each.
- Atomic D1 model-attempt accounting before provider fetch, including retry/proposal repair. Six attempts per conversation, maximum700 output tokens; full UTF-8 prompt bytes and separately attested framing bound determine model reservation.
- Strict provider/model, source revision, expiry, staging, phone-pause and sandbox payment gates. Failed/cancelled attempts remain charged against the conservative bound. No balance reset or refund path.
- Dedicated THREAD-VOICE-NDEMO-NEXT-AUDIO namespace inherits existing immutable booking/reservation/payment refusal; ordinary runtime requests remain unchanged.
- Ten four-turn scenario definitions covering all five services, consent, app-only caregiver pricing, ambiguity, corrected itinerary, human request and emergency guidance. Outbound is dialogue simulation only. Planned acoustic barge-in must be driven by an actual first-audio event.
- Audio receipt helper retains audio arriving before text, conversation ID and interruption events. Latency is measured from caller audio end to locally received first audio, with its limits labeled. No false listening/naturalness claim.

Verification: native Miniflare D1 tests prove concurrent ten-lease maximum, six-attempt maximum, aggregate cap, immutable pinned evidence, version/customer/expiry denial, and UTF-8 accounting. Provider boundary regression and audio receipt tests pass. Unit-test pricing is invented, labeled UNIT TEST ONLY, and cannot serve as a live pricing receipt.

Still required before publication/deployment/paid dispatch:
1. Complete the hosted runner's authenticated lease-provisioning route and bind native provider hard duration/configuration to the trusted pricing receipt. The budget library deliberately has no HTTP provisioning endpoint and is currently unprovisioned.
2. Obtain account-applicable native optional-feature/region charge ceilings and inclusive model rates/framing bound through existing approved metadata/account routes. Missing fields are not zero; receipt must match exact agent-config hash and source SHA. The earlier metadata inspector has optionalUpperMicros:null. No browser CLI/session is available locally; existing gh can run a metadata-only hosted inspector, but agent GET alone does not establish those monetary ceilings.
3. Port the existing hosted native audio runner to the lease and event helpers; retain conversation cost_fiat/charging fields with verified currency and actual continuous input/output timing, write partial receipts in finally, and actually inject the planned interruption. Do not dispatch the old unbounded runner.
4. Deploy/certify the exact guarded revision after a fresh overlap check, then admit paid batch only on successful gates. No deployment or paid session was launched at this checkpoint.
5. Listening-capable review remains needed for actual naturalness. This environment rejected prior audio input; waveform/transcript analysis cannot honestly substitute for listening.

Prior actual evidence remains the80-WAV artifact from run36997508092, artifact11224080357; expires2026-10-09T11:21:41Z. New scenario definitions and unit audio packets are not new real-provider results.
