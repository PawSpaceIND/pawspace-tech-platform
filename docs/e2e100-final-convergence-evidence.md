# E2E100 final convergence evidence

Date: 2026-08-24 (Asia/Kolkata)

Repository: `PawSpaceIND/pawspace-tech-platform`

Branch: `testfix/e2e100-final-convergence`

## Baseline and lane verification

The final candidate starts from current `main` at `0b42923aa6e7d1a92f078e94a6aadc71c9dd559c`. PR #302 was refreshed to `2606c8354bfb51ea7c0b5c531f374bd91d0cf9f1`, passed Release CI run `32695835255`, and was merged as `5377743765dbfed0bd28ff101550bbe8127e0040` before this convergence began.

| Lane | Closed PR head verified | Remote disposition | Lane Release CI | Convergence action |
|---|---|---|---|---|
| T1 customer/booking | `00b6dbcd8775f0324aabb0949152af1c27aa1adf` | #310 closed without merge | `32693934368` green | Carried OTP identity fix, T1 evidence and 25-case matrix; retained newer merged payment-link implementation |
| T2 provider/Operations | `18577140c35291bf7110b6a21cc97412b2f620e3` | #309 closed without merge | `32691658049` green | Carried provider offer, eligibility, expiry, ownership and settlement fixes plus evidence/matrix |
| T3 CRM/AI/comms | `ddc541ed7e7ce81f1337efbef10b8911ca05d957` | #307 closed without merge | `32687904375` green | Carried external communications boundary and evidence/matrix; retained newer merged AI idempotency, deadline and verified-grounding controls |
| T4 Finance/GST/close | `0dd6d241a5a0ffc54867f6fa2ff2aaf334b68ea2` | #308 closed without merge | `32689759374` green | Carried Finance/GST/year-close fixes, provider contract tests and evidence/matrix; retained newer merged payment-link implementation |

The preserved demo seed SQL and generator were not overwritten or weakened.

## Conflict adjudication

- Payment-link conflicts were resolved to current `main`, which already contains the refreshed and merged #302 implementation: bounded sandbox provider requests, provider-truth expiry, attempt-unique references, atomic request/mapping/reconciliation writes, expired-link replacement, signature-verified capture mapping and refund-path preservation.
- AI conflicts were resolved to current `main`, which is stronger than the closed T3 fork: atomic turn reservations, retry ownership, provider deadlines, effective-window knowledge verification and fail-closed high-impact output handling remain canonical.
- Both public callback boundaries remain explicitly allow-listed in the API gateway: provider verification and communications-provider callbacks.
- T3 case 073 referenced a pre-convergence filename. The same named Gate 7 behavioral contract now lives in `tests/ai-evaluation-security-source-contract.test.mjs`; the matrix path was corrected without changing product behavior or weakening the assertion.

## Convergence defects fixed

### E2E100-CONV-001 — payment contract test escaped to the real provider hostname

Classification: confirmed convergence code defect. The first exact-head Web run (`32700988399`) proved that T4's external contract tests were present but its guarded transport had been lost during conflict resolution. Five contract cases consequently reached `api.razorpay.com` and failed with HTTP 401 instead of reaching their loopback server. No successful provider action or money movement occurred.

Correction: restore the bounded provider request layer while retaining the newer canonical payment-link behavior. A custom endpoint is now accepted only when all three conditions hold: sandbox environment, explicit contract-test flag and a loopback HTTP(S) hostname. Requests have a bounded timeout, redirect refusal and a 65,536-byte response ceiling. The permanent provider suite proves accepted order/link responses; HTTP 400/401/429/500/503; timeout; network failure; invalid responses; and refusal of non-contract/live overrides.

Focused retest: **19/19 passed** across provider contract, verify-first and post-service payment-link suites. Full E2E100 retest: **102/102 passed**.

## Combined execution result

Command:

```text
node --experimental-strip-types --test \
  tests/e2e100-t1-customer-booking.test.mjs \
  tests/e2e100-t2-provider-operations.test.mjs \
  tests/e2e100-t3-crm-ai-comms.test.mjs \
  tests/e2e100-t4-finance-gst-close.test.mjs
```

Result: **102/102 passed** — all 100 E2E100 business cases plus the T3 and T4 exact-range guards; zero failed, skipped, cancelled or todo.

| Range | Result |
|---|---|
| E2E100-T1-001–025 | 25/25 pass |
| E2E100-T2-026–050 | 25/25 pass |
| E2E100-T3-051–075 | 25/25 pass |
| E2E100-T4-076–100 | 25/25 pass |

## Repository gates

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint | PASS — 0 errors; 18 pre-existing warnings |
| Build | PASS |
| Artifact validation | PASS |
| Local `npm test` aggregate | MANAGED-ENVIRONMENT BLOCKER — command launch was intercepted before test execution because the workspace does not permit the listener/provider-capable aggregate command |
| Exact-head Release CI | PASS — corrected code-head run `32701505234` passed all 11 jobs; the final evidence-only PR head is revalidated by the same required workflow |

## External and policy boundaries

- No actual Razorpay charge, capture, refund, bank transfer, payroll payment, partner payout or statutory filing is claimed.
- No actual WhatsApp, SMS, email or voice delivery is claimed without configured provider accounts and callback registrations.
- Sitting hourly/daycare and city-restricted Operations identity behavior remain explicit catalogue/policy blockers documented by their owning lanes; no commercial or access policy was invented.
- Engineering integration readiness remains separate from real-provider, real-device and deployed-environment verification.

At convergence completion, no merge or deployment had been performed. PR #311 was subsequently
authorized and merged as `6f21f24c76e49aae7828786910054581bb6727e9`. Production remains untouched.

## Controlled UAT staging deployment follow-up

Staging workflow run `32702926154` checked out the exact merge SHA, built it, deployed worker
`pawspace-staging`, verified the dedicated staging D1 binding and sandbox configuration, and installed
the UAT Worker secrets. It then failed before certification while loading `employee-seed.sql`:
Wrangler was given the D1 UUID as the positional database even though `d1 execute` resolves a database
name or configured binding. The customer/demo seed was therefore not started and human UAT was not
declared ready.

Classification: confirmed deployment-workflow code defect (`E2E100-DEPLOY-001`). The correction uses
binding `DB` from `dist/server/wrangler.json` for both staff seeding and certification reads. That
binding points to the D1 id already checked against the live staging Worker by the isolation preflight.
A permanent regression rejects raw-ID execution in both paths. Focused staging/release gate result:
**168/168 passed**. A new exact-head staging deployment and certification are required after this
hotfix is merged; only then may the idempotent customer and demo seed workflow run.

### E2E100-DEPLOY-002 — deployment status output did not contain the hosted origin

After PR #312 merged, exact-SHA staging run `32705240467` proved the D1 fix in the controlled
environment: deployment, isolation, encrypted secret installation and `employee-seed.sql` all passed.
The run then failed closed before hosted certification because `wrangler deployments status` did not
emit a `workers.dev` URL. No customer/demo seed was started and UAT remained closed.

Correction: capture the authoritative account-qualified `workers.dev` URL directly from the successful
`wrangler deploy` output in the same pipefail-protected step and pass that step output to certification.
The workflow refuses to guess an origin if Wrangler does not report one. A permanent regression requires
deploy-output capture and forbids URL resolution through `deployments status`. Focused staging/release
gate result: **168/168 passed**.

### E2E100-DEPLOY-003 — post-deploy secret updates replaced the attributed version

Exact-SHA staging run `32706638921` proved the URL handoff, isolated Worker/D1 binding, sandbox
posture, encrypted UAT secret installation and idempotent employee seed. Hosted certification then
failed closed because the active version's deployment message was empty. The deploy itself had carried
the expected `staging 9818da38806ce1e335db1fe2f1262f5a090175c4` message, but each subsequent
`wrangler secret put` creates and immediately deploys a new Worker version. The certification was
therefore correctly inspecting a newer, unattributed version rather than the version just built.

Classification: confirmed deployment-workflow code defect. The correction uploads the three UAT
credentials as encrypted bindings in the same `wrangler deploy --secrets-file` operation as the code
and exact-SHA message. The temporary owner-readable JSON file is created from masked Actions secrets,
never logged or uploaded, and removed by an EXIT trap. Cloudflare documents that secrets omitted from
the file remain preserved. A permanent regression forbids a later `wrangler secret put` and requires
the secrets file on the attributed deployment command.

### E2E100-DEPLOY-004 — hosted staff probe used a non-existent role column

The same run loaded `employee-seed.sql` successfully, but all three post-seed staff probes failed to
execute. The first incorrect read was the certification query joining and selecting
`role_definitions.role_code`; the canonical table is keyed by `role_definitions.code`. This was a
certification defect, not missing staff data.

Classification: confirmed certification code defect. The query now joins `r.code=u.role_code` and
aliases `r.code AS role_code`. Its permanent behavioural regression executes the production query
against an in-memory database with the canonical `app_users` and `role_definitions` schemas. Focused
staging/auth result: **59/59 passed**. Full staging/release gate result: **169/169 passed**. The
customer/demo seed remains intentionally paused until a new exact-head staging run fully certifies.
