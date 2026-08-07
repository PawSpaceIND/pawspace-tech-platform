# PawSpace owner pending closeout

**Purpose:** one place for PawSpace/Karthik actions that require external credentials, business approval, console access or real-world testing. Engineering should continue closing application-side gates without repeatedly interrupting for these items.

## Batch A — external sandbox credentials / console setup

- [ ] **Google Maps UAT** — Google Cloud billing enabled, Routes API enabled, restricted UAT server key created; Cloudflare UAT variables `PAWSPACE_MAPS_ENV=sandbox` and secret `GOOGLE_MAPS_SERVER_API_KEY_UAT` added; execute provider GPS -> ETA/distance -> Google navigation test. Application-side Maps gate is already CI-green; background/live tracking remains OFF.
- [ ] **Razorpay test mode** — add UAT key ID, key secret and webhook secret; execute order -> payment -> signed webhook -> reconciliation and cancellation -> refund -> signed webhook -> Finance reconciliation. Keep live/RazorpayX credentials OFF.
- [ ] **OTP/SMS/WhatsApp UAT delivery** — choose/confirm the UAT delivery provider/account and add its sandbox/test credentials after the PawSpace OTP/session adapter is engineering-closed. Do not enable production messaging until authenticated UAT passes.
- [ ] **Exotel UAT** — add test account/number credentials and verify masked/routed provider-customer calling after identity/session UAT.
- [ ] **Secure media infrastructure** — configure object storage, signed upload/download and scanner callback credentials; verify before/after proof reaches trusted `ready` state. Do not treat synthetic `uat://` proof as production evidence.

## Batch B — business / finance approvals

- [ ] Approve final Bengaluru Grooming cancellation cutoff and refund percentages/fees.
- [ ] Approve final reschedule cutoff, maximum reschedules and any reschedule charge.
- [ ] Approve no-show refund/credit policy.
- [ ] Approve final multi-pet commercial/pricing rule.
- [ ] Approve final Grooming subscription plan values by launch city/zone and permission to switch policy from `observe` to `enforce`.
- [ ] Approve production GST/tax treatment, invoice numbering/format and accounting integration requirements.
- [ ] Approve provider payout/settlement rules, including commission/travel/incentive/penalty treatment where applicable.

## Batch C — production operations / launch

- [ ] Confirm production customer and partner authentication/messaging provider configuration and credential ownership.
- [ ] Confirm production domains/cutover for `pawspace.in`, `partners.pawspace.in`, `team.pawspace.in`, `control.pawspace.in`.
- [ ] Confirm monitoring/alerting, backups/restore test and support/escalation SOP.
- [ ] Run real-device authenticated Customer -> Partner -> Team/Finance UAT including failure paths.
- [ ] Run employee/internal pilot.
- [ ] Run one-zone Bengaluru pilot and approve expansion only after evidence review.

## Rules

- Production credentials must never be committed to GitHub or pasted into docs/chat.
- External integrations are enabled one at a time in sandbox/UAT first.
- This checklist is the owner-action queue. Application engineering gaps remain tracked in `docs/GROOMING_CLOSURE_PLAN.md` and should be closed independently where possible.
