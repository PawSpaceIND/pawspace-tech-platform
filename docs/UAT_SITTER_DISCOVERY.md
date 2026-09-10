# Governed sitter discovery — partial Pet Sitting closure

The mobile stay flow previously displayed three static sitter cards, invented review/repeat counts, response times, distances, acceptance/offer counts and sample conversations. A name-to-ID map supplied booking selection.

The scheduling endpoint now supports a customer-owned Pet Sitting preview. It uses the same governed address, booking window, roster, leave, capacity and scheduling rules as reservation. It verifies pet ownership and returns only provider ID, name and engagement model. It creates no reservation, assignment decision or provider offer. Preview availability is provisional; booking rechecks it. An unavailable selected sitter produces an explicit refusal instead of silently substituting a different provider.

The mobile flow loads that preview for its exact location/window/pet selection, invalidates stale results, supplies loading/error/retry states, and uses the selected provider ID for booking. It removes static pre-booking social proof, offer counts, media and conversations. Prices come from the server quote. Missing profile/review/messaging integrations are stated directly.

## Evidence

Real SQLite route tests cover a non-empty preview, zero reservation/decision/offer writes, inactive/leave/wrong-zone exclusion, foreign customer/pet denial, and refusal to substitute an unavailable sitter. Scheduling and Boarding regression checks are run with their declared service-discovery sandbox fixture. Build and typecheck passed; full combined regression is recorded separately.

## Remaining scope

This is not full Pet Sitting certification. The separate /sitting customer page still has static search cards, and post-booking panels still contain simulated care/status/support claims. Those require source-backed lifecycle/proof views and real actions. No complete human journey, native app, connected maps, messaging or money verification is claimed. No live communications or funds are sent by this work.
