# Chat readiness closure

Public chat previously displayed an empty Result when approved knowledge had no match. Authenticated chat required customers to type an internal customer ID. A knowledge read failure was also swallowed as an empty result.

The customer chat now displays questions and answers, a useful no-match state, sign-in guidance, bounded request timeouts, preserved input on failure and a stable retry key. The authenticated route derives missing customer identity from the verified session and retains explicit ownership checks. Public knowledge initializes its owned configuration schema; query failures propagate. Unknown chat modes are rejected.

During closure, a separate privacy defect was found: an authenticated customer could reuse another customer's idempotency key and receive that customer's thread/message reference. Replay lookup now checks the stored customer ID before returning anything. Regression tests cover both foreign-key refusal and valid own replay.

Local browser checks exercised the public no-match state, guest sign-in guidance, disposable customer OTP login and a signed-in question without manual ID entry. With no external model configured, that question returned the governed human-handoff message. Layout was inspected at desktop and 390x844 phone width. This does not certify a real model response, staff takeover, live voice, or a complete support resolution journey.

The new regression suite also executes cold storage, injected knowledge-read failure, invalid mode refusal and signed-session identity derivation. Full-run evidence must name its exact candidate SHA; changes merged to main during testing require fresh integration verification. Native files and external integration settings are outside this change.
