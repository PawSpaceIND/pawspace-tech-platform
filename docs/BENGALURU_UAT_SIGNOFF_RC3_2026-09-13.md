# Bengaluru UAT sign-off pack — release candidate v1.0.0-unified-rc.3

Prepared 2026-09-13 20:20 UTC. Evidence pack per `docs/PRELIVE_REGRESSION_BENGALURU_PILOT_UAT.md` §2 and §16. Supersedes the rc.2 pack (`docs/BENGALURU_UAT_SIGNOFF_2026-09-13.md`), which stays for the record. Everything here is referenced, not embedded; all identities and phone numbers below are seeded UAT fixtures from `docs/UAT-TESTER-GUIDE.md`, never real customers.

## 1. Release candidate identity

| Field | Value |
|---|---|
| Candidate commit | `88cc872fc3f4d9e4eec997c56199626df8c49916` (merge of PR #836 into `main`, 20:04 UTC) |
| Tag | `v1.0.0-unified-rc.3` (annotated, "PawSpace unified RC3 - Bengaluru UAT sign-off candidate"). See §7 for the push command. |
| Release branch | `release/v1.0.0-unified-rc.3` at the candidate commit (created 20:16 UTC) |
| CI on the exact tree | Tree `a2cc72e1afee21d4073865934ff6c82a94ef9c43` is byte-identical to PR #836's final head `0746643409260698b7ff96a14cb73cd066235b3e`, on which every check run completed green, including the four required checks (among them "Staging isolation + full certification" and "Test harness hook paths"). The two production-only audit jobs skip on pull requests by design. |
| `main` after the candidate | Unchanged (`88cc872f`) at 20:17 UTC when the release branch was cut |

PRs merged into `main` after rc.2 (`6722ba6`), all part of this candidate, oldest first:

| PR | Merged as | What it changes |
|---|---|---|
| #826 | `1e745e4` | UAT visual sweep aligned with the live address picker (test) |
| #829 | `b2a3278` | Authored UAT availability with live seed verification; server-verified proof byte upload (`PUT /api/service-media/upload`) |
| #833 | `1651f6e` | Partner app mounts the OTP sign-in as the auth gate |
| #828 | `6fc6d56` | Multi-persona sweep made deterministic; reseeding opt-in (test) |
| #831 | `b0633fe` | Razorpay redirect-mode return lands on a confirmation route; Partner App OTP sign-in gate |
| #837 | `085675f` | Partner app sign out / switch partner |
| #834 | `c03bdf5` | UAT sweep selects the service time before the preferred groomer (test) |
| #841 | `ccc5769` | Sweep booking-reservation waits get their own timeout (test) |
| #846 | `b5b0b17` | UAT sweep tolerates a preferred-groomer lookup timeout (test) |
| #839 | `025cafd` | Partner app sign out and UAT provider switch; trainer partner OTP numbers seeded |
| #836 | `88cc872` | rc.2 sign-off pack; Booking Command Center lists newest-created bookings first with server-side search; production proof-media guard |

rc.2's own PRs (#816, #825, #830, #827) are listed in the rc.2 pack and remain in this candidate.

## 2. Environment and configuration

| Item | Value |
|---|---|
| Worker | `pawspace-staging` at https://pawspace-staging.karthik-fce.workers.dev |
| Database | D1 `pawspace-staging` (`1b879a28-c8a9-40b0-830d-1ce439061a00`), isolated from production; certification refuses any production binding |
| Mode vars (certified on the deployed Worker) | `PAWSPACE_PAYMENT_ENV=sandbox`, `FORBID_PRODUCTION=true`, `PAWSPACE_PAYMENT_LIVE_APPROVED=false`, `PAWSPACE_UAT_LOGIN=on`; no production or live-approval flag set |
| Payments | Razorpay TEST keys only; live keys, live approval and live webhooks absent. No live money moved at any point. |
| Credentials | Worker secrets; certification proves none is serialized into the deployed config. Not recorded here. |
| Seed | Staff directory and city-wide UAT provider roster loaded by the deploy (30/30 service-zone pairs covered, 71 seeded roster rows assignable, 54 radius-gated providers located). The sweep ran with `reseed=false`. |
| Rollback | Deployment reference `91028ead-56cd-42bd-b665-da352daa7c4c` recorded before the deploy |

## 3. Deploy certification

| Item | Value |
|---|---|
| Workflow run | "Deploy staging" run 260, 20:05–20:08 UTC — https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34779658703 |
| Inputs | `confirm=staging`, `expected_sha=88cc872fc3f4d9e4eec997c56199626df8c49916`, `sms_smoke=disabled`, ref `main` |
| Result | **CERTIFIED — 28/28 checks passed** at 20:07:53 UTC on the deployed origin and deployed configuration: isolated Worker and D1, exact SHA requested and LIVE, sandbox mode with no live or approval flag, no serialized credential, roster coverage and provenance, five seeded staff identities exist and sign in, sandbox customer OTP, six disposable personas authenticate (6/6), Razorpay TEST and Maps/GPS UAT configured, hosted smoke pack answers for a session (6/6) and refuses anonymous callers, rollback reference recorded |
| Evidence artifact | `staging-certification-88cc872fc3f4d9e4eec997c56199626df8c49916` (1,337 bytes, expires 2026-12-12) — https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34779658703/artifacts/10324461256 |

## 4. Automated multi-persona sweep

| Item | Value |
|---|---|
| Workflow run | "Automated human sweep (staging)" run 23, 20:08–20:16 UTC — https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34779846684 |
| Harness | `e2e/automated-human-sweep.spec.ts` at the candidate commit (includes #828, #841, #846), target origin above, `reseed=false` |
| Result | **3 of 3 personas passed** (5.9 min, one worker, serial chain) |
| Evidence artifact | `human-sweep-evidence` (report + screenshots, 14 files, 2,680,985 bytes, zip sha256 `d22974a25c72a339ca293c0c0e502ca832d71f1b4a28d8578c87f950555e1e79`, expires 2026-12-12) — https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34779846684/artifacts/10324805919 |

Persona results:

| Persona | Identity | Proved on the live build | Screenshot in artifact |
|---|---|---|---|
| Customer (mobile app) | sandbox OTP `9330223179` | Login; Google Places doorstep verified; requested window 2026-09-16 13:00–15:00 IST; review step with Customer Name / Phone / Alternative Phone and instructions; canonical booking **`PS-UAT-MU094QR9-F09C`** created (HTTP 201); pay-after page ("Nothing is charged now") confirmed; "Your groomer is reserved." with assigned groomer **Pooja E. (UAT Central 2)**; groomer note surfaced | `sweep-customer-confirmation.png` |
| Customer, online pay | same | Booking **`PS-UAT-MU095VQ7-DC2D`** created (HTTP 201, payment pending until captured); **Razorpay sandbox checkout iframe mounted**. Capture needs manual card entry in Razorpay's cross-origin iframe, by design | `sweep-customer-razorpay.png` |
| Partner (`/partner/jobs`) | `asha.groomer1@tkpetcare.in` | Staff sign-in; job feed loaded (upcoming 8, total 8) with a grooming card; dashboard sections rendered. The sweep's booking sat in another provider's feed (see §6.1) | `sweep-partner-jobs.png` |
| Founder / Admin | `founder@pawspace.in` | Sign-in; `/admin` and `/crm` render; **Booking Command Center list API HTTP 200, 150 bookings loaded, includes `PS-UAT-MU094QR9-F09C`; the booking is visible in the Booking Command Center**. On rc.2 (run 8) the same probe read "does not include" and fell back to the scheduling board; the #836 list change is verified on the live build | `sweep-admin.png`, `sweep-crm.png`, `sweep-founder-command-center.png` |

## 5. Manual UAT (reported)

Reported by Karthik (founder) on 2026-09-13 against staging running the rc.2 code, which this candidate carries forward: customer "Review payment" mounts the Razorpay TEST modal; partner before/after proofs uploaded as the groomer, approved as the founder in the Booking Command Center, job completed. Manual UAT on the rc.3 build itself is recorded through the sign-off table in §8.

## 6. Observations (non-blocking) and pre-production decisions

1. **Partner feed and provider assignment.** The scheduler assigned the sweep's booking to Pooja E. (UAT Central 2), the best-eligible provider for the 2026-09-16 13:00–15:00 IST window, not the provider linked to `asha.groomer1@tkpetcare.in`; the preferred-groomer chip was not offered for that window, so the harness could not steer the assignment. The feed rendered and the step passed. Scheduler behaviour, not a defect; run 8 on rc.2 happened to land on the linked provider.
2. **Harness wording.** The sweep log still labels the Command Center payload "150 latest by schedule"; since #836 the API returns the newest-created bookings first. Copy only, in `e2e/automated-human-sweep.spec.ts`; follow-up.
3. **Scheduler preview.** The customer step's shortlist preview did not resolve within the harness wait; the booking proceeded with best-eligible assignment. Informational.
4. **Proof media storage on this candidate.** #829 added the byte-upload step: the partner app sends the file to `PUT /api/service-media/upload`, the server hashes the bytes it received and compares size, SHA-256 and type with the upload grant. Without a `PAWSPACE_MEDIA_BUCKET` binding the server records the verified digest and retains no bytes (metadata-only proof); with a private R2 binding the object is stored, and a store refusal returns 503 and registers nothing. The production guard from #836 still requires `PRODUCTION_MEDIA_OBJECT_UPLOAD_READY=true` before `PRODUCTION_R2_BUCKET_NAME` is honoured, which now means exactly "uploads reach the bucket"; its message text predates #829 and still says no byte-upload path exists. Follow-up: reword the message in `scripts/prod-config.mjs`. **Decision to record before production:** metadata-only (leave `PRODUCTION_R2_BUCKET_NAME` unset) or private R2 storage (set the bucket name and `PRODUCTION_MEDIA_OBJECT_UPLOAD_READY=true`); this candidate supports both.
5. **Manual review policy.** Production media release stays blocked without a scanner unless the `media_scan_policy` service policy sets `manualReviewPermittedWithoutScanner: true` for the pilot scope (Service policy control, permission `settings.manage`, audited). Required before the first production job completion; deliberately not defaulted in code.
6. **Live money stays off.** `deploy-production.yml` accepts sandbox payment mode only; live activation is a separate, explicitly authorized gate.

## 7. Promotion runbook (not executed)

1. Push the RC tag from a maintainer checkout (tag pushes are refused for the automation credential):
   `git fetch origin && git tag -a v1.0.0-unified-rc.3 88cc872fc3f4d9e4eec997c56199626df8c49916 -m "PawSpace unified RC3 - Bengaluru UAT sign-off candidate" && git push origin v1.0.0-unified-rc.3`
   rc.3 replaces rc.2 as the candidate. The rc.2 tag (`6722ba616ed7aad2d2b73bbda64979eb531c563e`) may still be pushed for the record; it is no longer required.
2. Dispatch "Deploy production" with `confirm=deploy-production-bengaluru`, `expected_sha=88cc872fc3f4d9e4eec997c56199626df8c49916`, payment mode `sandbox`, communications and maps modes per the pilot decision, voice `disabled`.
3. Set the `media_scan_policy` manual-review policy (§6.5) before the first production job completion.
4. Configure proof media storage per the §6.4 decision.
5. Any product commit after the candidate creates a new candidate and requires re-certification appropriate to its blast radius.

## 8. Sign-off

| Role | Name | Decision (approve / reject) | Date |
|---|---|---|---|
| Bengaluru UAT lead | | | |
| Founder | | | |
| Engineering | | | |

Sign-off actor and timestamp are recorded here on approval; the exit criteria are those of `docs/PRELIVE_REGRESSION_BENGALURU_PILOT_UAT.md` §17.
