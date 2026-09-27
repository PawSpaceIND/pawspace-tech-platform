# G20 — Unexpected logout after sign-in

Date: 2026-09-27
Status: isolated regression reproduced; implementation and focused tests complete; deployed-browser acceptance pending. Not a live-fix or issue-closure claim.
Baseline: e930ae46916bc905bc9757b2d5067091db01e7eb.

## Confirmed code-level cause

`issuePlatformSession` superseded every active session with the same subject type and subject ID whenever a new session was issued. A second browser signing into the same account therefore invalidated the first browser's session. Overlapping verified exchanges could also produce an already-superseded token depending on response order. This is a deterministic cause of unexpected logout, but has not been proven to be the only cause of the user's particular deployed-browser report.

## Change

Browser-facing issuers pass their server `Request` into session issuance. Only the existing cookie token for the newly verified subject is superseded; other browsers remain active until ordinary expiry or revocation. Trusted non-browser callers that omit `request` retain the previous subject-wide replacement behavior. No caller-supplied JSON token or session ID is trusted.

Wired paths: generic verified-identity exchange; customer OTP exchange (also used by web chat); partner OTP; staging customer switch; staging provider switch. Malformed percent-encoding in a session cookie is treated as no valid credential, not an exception that prevents recovery by verified login.

Unchanged: OTP and assertion verification, origin/environment gates, expiry bounds, ownership and permission checks, token hashing and secure cookie flags, explicit logout, identity-binding revocation, booking and payment logic. No schema migration, new secret, or deployment configuration change.

## Executed focused verification

Command: `node --test tests/browser-session-continuity.test.mjs`.
Runtime: Node 22.16.0, actual session/binding/security/request-metrics modules, repository TypeScript loader, in-memory SQLite with transactional D1-batch adapter. No session function was mocked. The unchanged dependency copies were verified against their Git blob hashes.

- Baseline session module: 16 tests; 7 passed; 9 failed; 0 skipped.
- Patched session module: 16 tests; 16 passed; 0 failed; 0 skipped.

Coverage: independent customer and provider browsers; same-browser token rotation; concurrent independent sign-ins; overlapping exchanges; per-browser logout; server-side expiry; binding revocation and rebinding; cross-subject cookie isolation; unknown and malformed cookies; retained trusted-caller subject-wide replacement; failed-issuance rollback; cookie attributes and customer/provider permissions.

These are executed session-layer tests, not completed live OTP, UI, payment-return, or full-repository tests. CI and runtime verification must be checked separately.

## Required acceptance before closing G20

1. Verify the exact PR head through repository CI and the existing identity/OTP/gateway regressions.
2. Deploy through the normal authorized staging path; confirm the served revision.
3. Sign in through the real customer UI, reload, navigate account and booking steps 1–4, background/resume the browser, and confirm the identity endpoint remains authenticated.
4. Sign into the same customer account in a second independent browser; both must remain signed in. Repeat with a provider account and the provider application.
5. Re-login and explicitly log out in one browser; the other remains valid. The logged-out browser must be denied protected requests.
6. Check payment return and inspect the failing browser's network/cookie evidence if any unexpected logout remains; do not extend session lifetime or bypass authorization to conceal it.

Remote Desktop Commander returned no available device during this work, so deployed-browser verification and deployment were not performed. Production was not changed.

## Scope limitation

Tabs in one browser profile still share the same canonical identity cookie. Switching between customer and provider identities on the same origin is not simultaneous dual-role login; use separate browser profiles for that test. Role-separated cookies or a multi-account browser architecture are outside this patch.

## Continuation: Mac verification and CI repair

The Mac reconnected. An isolated checkout of exact PR head `0703b685b2ad7081cd61e2c5a0ae005331a3b4e2` was used; other worktrees were not modified.

Initial CI exposed three failures: the staging customer test represented repeat login without sending the prior cookie, and two presentation contracts retained pre-fix source hashes. The route test now sends the prior cookie for same-browser re-login and retains its old-token refusal assertion. Two further executed route tests require independent browser sessions, profile/account reads, and re-login isolation to work. Ten fingerprint entries in two manifests are updated only for the six authentication source files already changed by this PR; assertions and unrelated entries remain unchanged.

Executed on Mac Node 24.19.0: 70 session/ownership/route tests passed, then 27 OTP/security/presentation tests passed; zero failures or skips in either run. `npm run typecheck` passed. These are focused local results, not the full repository CI result or live-browser acceptance. Exact-head CI and staging verification still must complete.

## Review corrections

Two independently verified authentication findings are included. Malformed JSON, null/non-object payloads and non-string or empty assertions now return the existing 400 validation response before database access; the same-origin 403 check still runs first. No credential is issued on either refusal.

Previously issued UAT provider-switch sessions are recognized using server-owned session metadata or their legacy `uat-provider:` principal. Each new request checks the same UAT flag/signing-key gate as the issuer. Disabling UAT or using an invalid signing key therefore denies those sessions, while ordinary verified partner OTP sessions remain valid. The existing partner identity-source value is preserved for compatibility.

Executed on the Mac: 108 focused tests passed, zero failed/skipped; TypeScript passed. The expanded tests exercise the actual identity route and real session resolver. Narrow protected-source fingerprints were refreshed only for the two further authentication edits. Live after-fix acceptance and final exact-head CI remain separate gates.


## Failed-CI follow-up — 27 September 2026

The completed Pre-UAT run 36320305607 on `1ad259a4ff9e713f9b3ed0500ebc454186b899dc` reported 8,416 passes and eight failures. Seven failed suites were historical source-byte guards: 21 entries in seven manifests still held pre-G20 hashes for the partner OTP and two UAT switch routes. They now match the reviewed source; all unrelated entries remain unchanged. Each old hash was checked against main `c8b3f274a3ca3e7975ed2a84abb22788d4e51f67` before replacement.

The eighth failure, also the sole failure in Test harness hook paths (4,487 passed / one failed), was the LP-D09 ordinary commission-provider fixture identifying itself with the reserved `uat-provider:` principal prefix while test access was disabled. It now uses a normal partner-OTP principal. The provider rates route and session security gates are unchanged. A new executed route regression requires UAT identities to receive 401 when disabled, 200 when enabled, then 401 again immediately after disabling. Fixture databases are closed after each executed test.

The failing eight suites plus session, payload and UAT customer regressions now pass: **230 passed, zero failed, zero skipped**. The affected authentication/route suites also pass under the forced asynchronous loader path. Full exact-head CI and deployed after-fix acceptance are still separate requirements; these targeted results are not blanket release sign-off.
