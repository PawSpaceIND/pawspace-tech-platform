# Communication simulator isolation audit

Parent candidate: `b7678ca3`. The 95% human-test readiness goal remains unverified.

## Reproduced defect

The administrative `delivery_event` action accepted any provider name without a signed callback. Executable tests demonstrated that staff could manufacture a `limechat` delivery event, run sandbox simulation without the required environment locks, and store caller-supplied `externalDelivery:true` on a synthetic receipt. These were failures before the change, not inferred risks.

## Corrected connected behavior

- Manual delivery events accept only `sandbox_simulator`, on a message already assigned to that simulator. Real provider-bound messages and references cannot be overwritten through either manual simulation action.
- Both simulation actions require explicit sandbox payment mode, live approval `false`, and production prohibition `true`.
- The server forces `simulation:true` and `externalDelivery:false` on manual receipts and responses. Successful simulation remains labelled with its simulator provider; it is not a provider delivery receipt.
- Refused manual receipt/simulator actions leave an administrative security audit event with the actor and denial outcome.
- Simulator dispatch atomically claims the outbox row and verifies affected rows. Concurrent requests produce one acceptance event.
- Failed simulator messages cannot escape through the generic, Interakt or Meta UAT delivery adapters. Generic and WhatsApp scheduled dispatchers exclude simulator-owned records. Legitimate provider callback paths remain separate.

## Evidence

- Four executing isolation tests pass: forged provider refusal; environment and provider ownership guards; explicitly labelled synthetic receipt with duplicate-event protection; concurrent claim and exclusion from external delivery after failure.
- **88 communication regressions passed**, including generic bridge, Interakt, Meta UAT, consent, timeout and callback behavior. This run preceded the final denial-audit addition; that addition is exercised by the final infrastructure run below.
- **313 final infrastructure checks passed**, zero failures/skips. Counts overlap and are not additive.
- Build, TypeScript and diff checks passed.
- A request through the rebuilt local Worker/D1 with the seeded E2E admin attempted a `limechat` delivery event on an existing synthetic demo message. It returned **403**, and a subsequent read confirmed the message state was unchanged. No external message was sent.

The previous full-platform result remains 4,652 passing tests at `205f17f6`; this follow-up uses the focused/infrastructure evidence above, not a claimed new full-suite run.

## Remaining scope

Controlled administrative replay of historical dead-letter messages still needs its own implementation and end-to-end audit. No historical demo DLQ record was replayed or relabelled delivered. Native provider receipts, staging browser acceptance, environment validation and release/rollback evidence remain open. Synthetic simulation counters must not be used to certify real-provider delivery or business analytics.
