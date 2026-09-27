# Founder CRM permission-denied recovery — 27 September 2026

## Report and scope

A tester reported being signed in as Founder while Customers & pets showed `Permission denied` and the Team menu was unavailable. Remote Desktop Commander returned no connected device; the exact deployed browser identity and revision have not been captured. This is a reproduced code-level cause and a targeted repair, not deployed-incident closure.

Base: `e930ae46916bc905bc9757b2d5067091db01e7eb`.

## Reproduced defects

1. `readUatActorRow` swallowed every D1 exception as `null`. With a valid Founder staff cookie plus an existing customer session, an injected transient directory refusal made the real API gateway fall through to Customer and return 403. With only the staff cookie it returned 401. Both sign-in eligibility SELECTs also misreported database errors as an unrecognised identity.
2. The Team overview route already supplies `staff_sign_in_required`, but the gateway refused customer/provider actors first with generic `Permission denied`. The existing StaffWorkspace sign-in alert/link never received its recovery contract.

## Changes

- Retry only the staff-directory SELECT, once after 150 ms, and only for the existing recognised pre-execution D1 refusal classification. Persistent and unexpected errors propagate; they never become a different identity. Existing Worker transient-error handling remains responsible for service-busy responses and its bounded GET retry.
- Preserve all permission checks and denial audit events. On exactly GET `/api/team-overview`, `/api/crm` and `/api/customer-360`, customer/provider permission denials now carry the existing staff-sign-in recovery code. `/staging-login` is advertised only when UAT sign-in is enabled.
- No role grants, permission-map changes, session lifetime changes, auth bypass, business/payment changes, database migration or deployment configuration changes. No UI files changed; the existing recovery UI consumes this contract.
- PR #1141's browser-session issuance correction is independent. None of its files are changed here.

## Executed verification

Command: `node --test tests/founder-staff-access-recovery.test.mjs` on Node 22.16.0.

Actual production HMAC, directory, role, identity-binding, platform-session and gateway modules run through the repository TypeScript loader against an in-memory transactional SQLite D1 adapter. Only database failures are injected. The host is non-preview, and no authentication function is mocked. Baseline files and unchanged dependencies were verified against their Git blob hashes.

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Original base | 12 | 20 | 0 |
| Patched | 32 | 0 | 0 |

Checks cover valid mixed-cookie Founder precedence, each recognised transient refusal, persistent/unexpected failure handling, bounded retries, in-flight coalescing, immediate role changes/revocation, sign-in eligibility recovery, invalid/unprovisioned identities, restricted Finance, customer/provider denial contracts and audits, safe production messaging, ordinary allowed customer/provider permissions, reauthentication and unchanged origin/secure-cookie guards.

These are module/database integration checks, not a full repository build, full-suite run, live browser test, real hosted-D1 overload experiment or production sign-off.

## Closure gates

- [x] Reproduce failure against the unchanged base.
- [x] Focused regression suite passes after repair.
- [ ] Exact-head repository CI and existing auth/gateway regressions pass.
- [ ] Deploy through the approved staging/release process after review; do not overwrite another agent's preview.
- [ ] Verify Founder in the actual browser: Team navigation, CRM list/search and Customer 360, reload, and return from customer/partner testing.
- [ ] Confirm customers/partners remain denied and explicit role-switch recovery is visible.

Do not mark the user's deployed issue resolved until the final browser gates pass.
