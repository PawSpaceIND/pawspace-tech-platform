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
