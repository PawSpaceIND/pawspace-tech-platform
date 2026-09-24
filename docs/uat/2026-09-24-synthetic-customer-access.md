# Staging synthetic-customer access

## Purpose and boundary

Provide repeatable customer testing without repeatedly entering OTPs. This is a separate test-identity issuer, not removal of authentication. Normal OTP flows remain available for their own tests.

`/staging-login` shows two fixed customer personas only when explicitly enabled. The existing UAT access code is required. Sessions have normal customer permissions, are audited as `uat_persona`, and never claim real phone ownership. Customer ownership, privileged MFA, payment evidence and contact-consent checks remain active.

The profile endpoint now reconstructs customer identity from the validated platform session rather than requiring `otp` in its source label. This is needed to prevent the app treating a valid synthetic session as a guest after navigation or reload. A caller-supplied customer ID cannot select another profile.

The existing provider switch in `/partner-app` remains the provider-testing entry. Staff continue using their existing role-specific staging login.

## Enable and stop

Run **Deploy staging** for the exact reviewed commit with `confirm=staging`, `sms_smoke=disabled`, and `test_customer_personas=on`. Existing isolation and certification remain mandatory. Do not enable production flags, real calls or customer messaging to make a test pass.

Use `test_customer_personas=off` on the next normal staging deployment to stop issuance and deny existing synthetic sessions. Sessions also expire within 24 hours. Access is off by default, host-restricted, and fails closed on missing/unsafe sandbox settings. It never accepts an arbitrary customer ID or phone.

## Evidence requirements

Executable tests use isolated SQLite-backed D1 to prove issuer, canonical profile/account, role/ownership, expiry, collisions, production refusal and disable-after-issuance. Desktop/mobile browser tests run against the actual local Worker with preview-superuser off, and require pet persistence after reload without an OTP call.

These checks certify the test-login mechanism, not every service, captured payment/refund, provider completion, finance posting, live voice integration or normal OTP journey. Remote E2E must be repeated against the exact deployed build after deployment certification.
