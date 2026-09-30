# Read-only staging fixture attestation

GET `/__staging/fixture-isolation?expectedSha=<exact lowercase 40-character SHA>`

For the separately approved one-booking Grooming journey, append `&scope=grooming_strict`.
The only accepted scopes are `bengaluru_roster` (default) and `grooming_strict`; duplicate,
empty or arbitrary scopes and all recipient/provider query parameters are refused.

## Narrow Grooming scope

`grooming_strict` reads only documented CUS0000 and `uatcap_groom_ft`, joined to its canonical
provider identity. The groomer must have the exact checked-in synthetic contact/provenance,
no email, matching Bengaluru cities, active/live full-time capacity and Grooming service scope.
The customer phone must resolve uniquely under the same normalized-phone predicate as customer
OTP, and the partner phone must resolve uniquely under the partner OTP exact lookup. An alias
on another account fails closed rather than allowing a login to an unproved identity.
The same Founder, host, revision, payment/payout, OTP and effective external-recipient exclusion
gates apply. Its SELECT does not read or depend on the global roster or Boarding tables.

A passing narrow snapshot explicitly sets `strictProviderSelectionRequired=true` and keeps
`automaticAssignmentCovered=false`, `reassignmentRecoveryCovered=false`, `assignmentLock=false`
and `bookingMutationAuthorized=false`. It is not a whole-roster pass: unknown providers outside
this fixed choice can coexist while the narrow snapshot passes and the broad snapshot refuses.
Do not use it for Walking, automatic assignment, manual reassignment or recovery.

The separately approved V2 test must select this exact named fixture. Existing production
`preferredModeForChoice` forces `providerSelection=specific` to strict matching, and the V2
checkout refuses a returned provider different from the explicitly selected one. This endpoint
does not change those guards, create a reservation, prove live capacity or authorize a booking.
Match the snapshot with the deployment isolation certificate and re-read before/after the bounded
test; stop on identity, version, fingerprint or chosen-provider drift.

Requires an existing signed, active Founder UAT session with wildcard permission. It is hidden outside the exact isolated `pawspace-staging.*.workers.dev` staging profile. Other identities, arbitrary query parameters, writes, missing runtime locks or unproven version metadata fail closed. No login, seeding, bookings, external messaging or payment is performed.

The narrow Worker handler runs before the generic API gateway, whose authorization/schema/audit helpers can write. It uses the existing read-only signed UAT staff resolver; every fixture operation is a SELECT. Missing schema or a failed read is an unproven result, never an empty safe roster. Output contains booleans and nonsecret version/revision evidence, never recipient, allowlist, signing-key or customer details.

## What a successful default roster snapshot proves

- The documented CUS0000 seed still has its exact synthetic primary number, source and Bengaluru city, with no extra phone/email identity
- The eight required documented providers exist, and every Bengaluru capacity profile (including inactive or uat_ready rows), plus profiles referenced by Bengaluru boarding hosts, has the exact documented synthetic canonical number, matching identity, seed provenance and no email
- No selected customer/provider recipient matches the conservative generic phone/email gate, effective Meta fallback allowlist, or actual voice last-ten-digit gate
- Payment/payout sandbox and live-approval locks, UAT communication/scheduling, non-live voice and disabled live customer/production OTP hold
- The served Worker has platform version metadata and a configured build revision matching the requested candidate

The provider manifest is copied only from checked-in synthetic SQL fixtures. A Bengaluru host linked to a differently located capacity profile fails closed. The complete Bengaluru capacity roster is bounded; overflow, unknown identities and missing associations fail. The query is deliberately broader than active scheduling candidates rather than accidentally ignoring a reactivated provider.

## What this does not prove

`bookingMutationAuthorized`, `staffFallbackRecipientsCovered`, `alternateProviderTablesCovered`, `assignmentLock` and `productionReadiness` remain false. A scoped pass is **not permission to create bookings**. Staff/Ops fallback destinations, alternate provider sources, specific service routes, AI/provider side effects and production readiness require separate source/runtime proof. Google Maps may make permitted synthetic UAT requests; this endpoint does not claim all network traffic is disabled.

The runtime cannot independently inspect its Cloudflare D1 binding's account/database ID without external infrastructure access. Match its Worker version and build SHA to the existing deployment-isolation certificate before use. Version metadata/SHA variables are introduced in the normal staging configuration; older/dedicated deploy paths missing them return revision_unproven.

This is a time-of-check snapshot, not a transaction lock. A successful snapshot includes a stable SHA-256 fixtureSnapshotId for the proved synthetic rows and checks (never hashes or exposes secret allowlists); failed snapshots emit null. Re-read immediately before and after each independently approved bounded UAT step. Stop on candidate/version/config or fixtureSnapshotId/roster drift, missing evidence, any failed boolean, or evidence of a destination outside the attested scope. A later successful snapshot cannot retroactively certify an earlier action.

## Validation

`node --experimental-strip-types --test tests/staging-fixture-isolation.test.mjs`

Tests execute the handler and existing token resolver against SQLite through a SELECT-only D1 wrapper. Any write/batch/exec or direct network dispatch fails. They cover production/unauthorized/nonfounder/exit/tampered identities, missing/mismatched version, invalid runtime locks, unknown/mismatched/oversized/inactive roster, generic email/phone normalization, Meta's raw-truthiness fallback, and real voice allowlist normalization. These are local tests; no hosted UAT or deployment is performed by this change.

Narrow-scope tests also prove that the fixed single-provider SELECT succeeds without Boarding
tables or unrelated roster identities, while missing/non-Grooming/non-full-time/changed contacts
fail; both fixed recipients fail on each effective external channel; arbitrary and duplicate scope
inputs are refused; and existing strict-choice/replay helpers cannot silently switch provider.
Normalized customer aliases and duplicated partner OTP targets are rejected using SELECT-only
checks, without revealing any other matched account.

## Known fail-closed roster prerequisite

The legacy runtime defaults `groom_arun`, `groom_kiran`, `groom_sanjay`, `train_kiran`, `train_ramesh` and `train_meera` can be selected under the UAT identity exemption without a canonical-provider phone row. `loadGovernedProviders` uses the capacity record, while `governedUatSeedFixture` explicitly recognizes these IDs; the staging SQL supplies their home bases. A missing canonical phone/login therefore does not prove they are unselectable.

Those identities are deliberately not invented or omitted from this attestation. If hosted rows cannot be matched to documented synthetic contacts, the result stays unproven. A separately authorized fully isolated fixture database or independently verified complete fixture identity provision may be necessary before automatic assignment testing. This read-only change does neither and does not alter active voice configuration.
