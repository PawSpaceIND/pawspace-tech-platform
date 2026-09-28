# G07 continuation after merged PR #1157

Base: `f2cc5d4abc013d2a8ad27cab2a1f11a98455d8d3`. Scope: the server-side completed-history part of G07, not a replacement of closed #1157 and not all G01–G19 closure. The independently merged voice #1156 changes are preserved unchanged by integrating current main `db2c97003837663c7370e6ada2d9d1bf574e443e`. Location #1158 remains separate.

## Existing gap and reuse
The shared scheduling engine already supports `repeatProviderId` and a governed repeat-provider ranking bonus. The customer-facing scheduling route did not populate that input. A new executable regression on the unchanged baseline chose `groom_arun` rather than the eligible previously used `groom_sanjay`; the history-aware route passes the same assertion.

The route now resolves history only after customer/pet ownership and the service address have been checked, in both preview and new reservation. Existing booking/group replay remains authoritative and is not reassigned when history changes.

## Implemented selection rule
Use the latest completed Grooming booking for this customer in the governed city which includes every currently selected pet and has already ended. This is an inferred continuity signal, not a stored declaration of the customer's favourite. Failed, cancelled, pending, future, other-customer, other-service, other-city and unrelated-pet records cannot supply affinity. Invalid historical pet JSON is not trusted. All matching history is queried without a client-side 500-record cutoff. Ordering uses actual instants, then deterministic creation/id tie breakers.

A specific current provider choice or an existing explicit preferred-provider request takes precedence. Caller-supplied repeat-provider/bonus fields are ignored. The existing operator policy controls the weight and can disable history affinity. Only eligible providers can receive the ranking benefit; leave, closed rosters, current bookings, retired profiles, service exclusions and all other existing scheduler checks still apply. If none is available the reservation still fails, rather than forcing the former groomer.

A missing history table means no prior booking history; it creates no booking tables. An actual database read error propagates instead of inventing a first-time-customer result. There is no cross-customer cache or new external AI/network call. No browser input, coupon/payment calculation or subscription price/scope is modified.

## Verification boundaries
Tests execute the real history query, existing policy resolver and actual authenticated scheduling route against isolated SQLite/D1 fixtures. The before/after route regression is retained in local evidence. New tests cover history scoping, multi-pet matching, incomplete/future records, explicit choice, caller spoofing, operator disablement, fallback, replay and no-eligible-provider refusal. Broader scheduling/pet-ownership/preview-latency and existing V2 payment/booking suites are run separately. Exact counts and completed build/full-suite status are reported on the PR after execution.

Only the intentionally modified scheduling-route fingerprint is refreshed in existing presentation manifests; no unrelated hash, test-quality limit, assertion or permission guard is weakened. No real booking/payment, provider notification, live AI call, deployment or rollout is performed by these local tests.

## Still open
G07 is partial: an explicit saved favourite-provider setting and its customer-facing explanation/controls are not introduced. History from a completed canonical Grooming visit is usable irrespective of purchase origin, but the subscription purchase UI, per-plan provider preference and address-change scope are not implemented or certified here. This is not a guarantee that the former groomer always wins: suitability and the governed weight still determine ranking. G01/G06 and the full G15–G19 provider-calendar workflows remain separate.

Evidence: `Documents/PawSpace-fixes/g07-repeat-groomer-evidence-20260928/` on the authorized Mac.
