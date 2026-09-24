# Private Grooming and Training voice sales UAT

## Scope implemented

Two private ElevenLabs configurations share the canonical PawSpace voice runtime:

- Grooming: `agent_9201m39vfcjjec4sya7rat0cerct`, custom model `pawspace-grooming-sales`.
- Training: `agent_2501m39vqwhpf4g94v4djvry31fw`, custom model `pawspace-training-sales`.

The model gathers needs and proposes a checkout. The server validates owned saved pets,
service scope, current commercial terms and actual scheduler availability, then stores a
short-lived immutable offer. A separate unambiguous customer confirmation executes that
stored offer; it does not ask the model to construct another action plan.

Grooming supports one-time packages and prepaid subscriptions using the same live
quote calculation as canonical booking. A subscription remains pending payment; it is
not a recurring debit mandate. Training supports assessment/programme quotes, full/split
payment, server-derived session duration/count and a customer-approved named trainer.
A programme requires a stated cadence and all previewed sessions must fit validity.

The three execution steps are canonical reservation, canonical booking and Razorpay
order creation. A 200 response containing connected:false is not a successful checkout.
Partial failure is audited and handed to staff rather than silently repeating a booking.

## Executed evidence

- 152/152 focused tests pass, zero skips. They include real SQLite-backed canonical
  routes, concurrency, quote changes, ownership, human handoff and provider-failure cases.
- External model/payment requests in those unit/integration tests are mocked.
- TypeScript typecheck, selected-source ESLint and git diff whitespace checks pass.
- Both specialist agent configurations were saved and verified as private with no
  attached telephone number. No customer telephone call was placed.
- Independent no-call provider run 36012959280 passed for the original shared agent:
  real OpenAI synthetic reply (gpt-5.6-luna), existing ElevenLabs agent GET and configured
  Responses endpoint/authentication reference. This is not an audio conversation proof.

## Remaining release proof

This checkpoint does not claim live customer readiness. Deploy this exact code through
isolated staging, bind a verified private browser/call session, prove real speech in/out,
and verify signed post-call reconciliation. Exotel number import/routing and a real
allowlisted carrier call still require separate evidence.

This flow requires saved owned customer/pet records. New-record intake and actual
transactional payment-link delivery are not implemented here. The checkout result
explicitly reports paymentLinkDelivered:false and paymentVerified:false. Never turn
those into success based on model text or a caller saying they have paid.
