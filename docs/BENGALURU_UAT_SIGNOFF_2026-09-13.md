# Bengaluru UAT sign-off pack — release candidate v1.0.0-unified-rc.2

Prepared 2026-09-13 (UTC). Evidence pack per `docs/PRELIVE_REGRESSION_BENGALURU_PILOT_UAT.md` §2 and §16. Everything here is referenced, not embedded; all identities and phone numbers below are seeded UAT fixtures from `docs/UAT-TESTER-GUIDE.md`, never real customers.

## 1. Release candidate identity

| Field | Value |
|---|---|
| Candidate commit | `6722ba616ed7aad2d2b73bbda64979eb531c563e` (merge of PR #827 into `main`) |
| Tag | `v1.0.0-unified-rc.2` (annotated, "PawSpace unified RC2 - Bengaluru UAT sign-off candidate"). See §7 for the push note. |
| Release branch | `release/v1.0.0-unified-rc.2` at the candidate commit |
| CI on the exact tree | The candidate's tree is byte-identical to PR #827's final head `5dada343b8d89afd2454f2596aa877b529328037`, on which all 37 check runs passed (Release CI lint/typecheck/build/backend/web tests/D1 regressions, browser E2E personas, seeded browser journeys, staging isolation + full certification, security supply chain, CodeQL). |
| `main` after the candidate | `6fc6d56c` = PR #828 (sweep harness determinism) and PR #833 (UAT roster SQL). Test and seed changes only; not part of this candidate. Any product change after certification creates a new candidate. |

Source PRs in the candidate:

| PR | Merged as | What it closes |
|---|---|---|
| #816 | `cdfa804` | Automated multi-persona human-UAT sweep harness |
| #825 | `9b1730c` | UAT provider roster assignable in every Bengaluru zone (provenance + home bases) |
| #830 | `5f209c3` | Partner before/after proof chain (register → confirm upload → ops review) and optional Alternative Phone on the grooming review step |
| #827 | `6722ba6` | Staging customer-checkout sandbox locks (`FORBID_PRODUCTION`, `PAWSPACE_PAYMENT_LIVE_APPROVED`), one shared proof release rule for the gate and the media listing, Booking Command Center service-proof verification panel |

## 2. Environment and configuration

| Item | Value |
|---|---|
| Worker | `pawspace-staging` at https://pawspace-staging.karthik-fce.workers.dev |
| Database | D1 `pawspace-staging` (`1b879a28-c8a9-40b0-830d-1ce439061a00`), isolated from production; certification refuses any production binding |
| Mode vars (certified on the deployed Worker) | `PAWSPACE_DEPLOYMENT_ENV=staging`, `PAWSPACE_PAYMENT_ENV=sandbox`, `FORBID_PRODUCTION=true`, `PAWSPACE_PAYMENT_LIVE_APPROVED=false`, `PAWSPACE_RAZORPAYX_LIVE_APPROVED=false`, `PAWSPACE_UAT_LOGIN=on`, `PAWSPACE_SCHEDULING_ENV=uat`, `PAWSPACE_MEDIA_ENV=uat`, `PAWSPACE_COMMUNICATION_ENV=uat`, `PAWSPACE_VOICE_ENV=uat`, `PAWSPACE_MAPS_ENV=sandbox` |
| Payments | Razorpay TEST keys only (`rzp_test_…`); live keys, live approval and live webhooks absent. No live money moved at any point. |
| Credentials | Uploaded as Worker secrets; certification proves none is serialized into the deployed config. Not recorded here. |
| Seed | Staff directory (`scripts/employee-seed.sql`) and city-wide UAT provider roster (`scripts/uat-staging-provider-capacity.sql`) loaded by the deploy, then re-loaded by the first sweep at 15:12 UTC |
| Rollback | Deployment reference recorded before the deploy (certification check "a rollback reference was recorded before this deploy — recorded") |

## 3. Deploy certification

| Item | Value |
|---|---|
| Workflow run | "Deploy staging" run 242, 15:03–15:06 UTC — https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34764447528 |
| Result | **CERTIFIED — 28/28 checks passed** on the deployed origin and deployed configuration (isolation, exact SHA, sandbox mode with no live or approval flag, no serialized credential, seeded staff identities can sign in, six disposable personas authenticate, Razorpay TEST and Maps/GPS UAT configured, smoke pack answers for a session and refuses anonymous callers, rollback reference recorded) |
| Evidence artifact | `staging-certification-6722ba616ed7aad2d2b73bbda64979eb531c563e` — https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34764447528/artifacts/10319879024 |

## 4. Automated multi-persona sweep

| Item | Value |
|---|---|
| Workflow run | "Automated human sweep (staging)" run 8, 15:21–15:28 UTC — https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34765336113 |
| Harness | `e2e/automated-human-sweep.spec.ts` at `584f6edd` (PR #828, since merged), target origin above, `reseed=false` |
| Result | **3 of 3 personas passed** (6.2 min, one worker, serial chain) |
| Evidence artifact | `human-sweep-evidence` (report + screenshots, 15 files, 2.9 MB, sha256 `a1f923fc7c1c334972853cccdea74d22f393ff674f3600e48bbef2f5475fe9f7`, expires 2026-12-12) — https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34765336113/artifacts/10320975762 |

Persona results:

| Persona | Identity | Proved | Screenshot in artifact |
|---|---|---|---|
| Customer (mobile app) | sandbox OTP `9312928137` | Login; Google Places doorstep verified; requested window 2026-09-17 09:00–11:00 IST; review step with the optional Alternative Phone; canonical booking **`PS-UAT-MTZYTV6F-E2CB`** created (HTTP 201); pay-after payment page ("Nothing is charged now") confirmed; "Your groomer is reserved." with assigned groomer **PawSpace Grooming Team (UAT)**; groomer note surfaced | `sweep-customer-confirmation.png` |
| Customer, online pay | same | Booking **`PS-UAT-MTZYUY50-AE2E`** created (HTTP 201, payment pending until captured); **Razorpay sandbox checkout iframe mounted**. Capture needs manual card entry in Razorpay's cross-origin iframe, by design | `sweep-customer-razorpay.png` |
| Partner (`/partner/jobs`) | `asha.groomer1@tkpetcare.in` | Staff sign-in; job feed loaded (upcoming 6); booking `PS-UAT-MTZYTV6F-E2CB` present as upcoming grooming · Essential Bath · confirmed · 2026-09-17T03:30Z; job card rendered; dashboard sections rendered | `sweep-partner-jobs.png` |
| Founder / Admin | `founder@pawspace.in` | Sign-in; `/admin` and `/crm` render; booking `PS-UAT-MTZYTV6F-E2CB` visible on the scheduling board for 2026-09-17 in the assigned groomer's column (API and page) | `sweep-admin.png`, `sweep-crm.png`, `sweep-founder-scheduling-board.png` |

Earlier run 7 (from `main` before #828) reached booking `PS-UAT-MTZYF3W6-93A1` then failed on a harness race (a one-shot probe of the pay-after "Confirm booking" button), not on the product. Artifact: https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34764808157/artifacts/10320250562.

## 5. Manual UAT on the same build (reported)

Reported by Karthik (founder) on 2026-09-13 against staging running the candidate code:

- Customer "Review payment": the Razorpay TEST modal mounts. Before PR #827 it was refused with "Customer checkout is not enabled for this environment."
- Partner job completion: before/after proofs uploaded as the groomer, approved as the founder in the Booking Command Center "Service proof verification" panel, job completed.

## 6. Observations (non-blocking) and pre-production decisions

1. **Booking Command Center list scope.** The list loaded the 150 bookings scheduled furthest in the future and did not include the 2026-09-17 booking; the founder step verified via the scheduling board instead. **Decision (2026-09-13): fixed.** The list is now newest-created first, the search box also searches the whole table on the server (`?q=`), `sort=schedule` keeps the previous order and `limit` is capped at 500 (route-level tests seed 160 far-future fixtures plus one booking made today). This is a product change after the candidate, so it ships in the next candidate; see §7.
2. **Proof photo bytes are not stored.** `confirm_upload` records the file's checksum, size and type. Without an object-storage binding (`PAWSPACE_MEDIA_BUCKET`) the API accepts the partner's observation of the file; with the binding present it requires the object to exist, and no endpoint uploads bytes yet. **Decision (2026-09-13): the pilot runs metadata-only proof.** `scripts/prod-config.mjs` now refuses `PRODUCTION_R2_BUCKET_NAME` unless `PRODUCTION_MEDIA_OBJECT_UPLOAD_READY=true` is declared, and the production workflow passes that variable beside the bucket name. Two consequences for the pilot: (a) leave `PRODUCTION_R2_BUCKET_NAME` unset until the byte-upload path exists; (b) production media stays blocked without a scanner unless the `media_scan_policy` service policy sets `manualReviewPermittedWithoutScanner: true` (Service policy control, permission `settings.manage`, audited). That policy must be set before the first production job completion; it is deliberately not defaulted in code.
3. **Live money stays off.** `deploy-production.yml` accepts sandbox payment mode only; live payment activation is a separate explicitly authorized gate.

## 7. Promotion runbook (not executed)

1. Push the RC tag from a maintainer checkout (tag pushes are refused for the automation credential):
   `git fetch origin && git tag -a v1.0.0-unified-rc.2 6722ba616ed7aad2d2b73bbda64979eb531c563e -m "PawSpace unified RC2 - Bengaluru UAT sign-off candidate" && git push origin v1.0.0-unified-rc.2`
2. Dispatch "Deploy production" with `confirm=deploy-production-bengaluru`, `expected_sha=6722ba616ed7aad2d2b73bbda64979eb531c563e`, payment mode `sandbox`, communications and maps modes per the pilot decision, voice `disabled`.
3. Before the first production job completion, set the `media_scan_policy` service policy `manualReviewPermittedWithoutScanner: true` for the pilot scope in Service policy control (audited). Leave `PRODUCTION_R2_BUCKET_NAME` unset.
4. Any product commit after the candidate creates a new candidate and requires re-certification appropriate to its blast radius. The Booking Command Center list fix and the production-config guard (§6) are such commits: promote rc.2 as certified, or cut rc.3 from `main` after they merge and re-run the staging deploy certification and the multi-persona sweep.

## 8. Sign-off

| Role | Name | Decision (approve / reject) | Date |
|---|---|---|---|
| Bengaluru UAT lead | | | |
| Founder | | | |
| Engineering | | | |

Sign-off actor and timestamp are recorded here on approval; the exit criteria are those of `docs/PRELIVE_REGRESSION_BENGALURU_PILOT_UAT.md` §17.
