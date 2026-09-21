# What is still open before human testing can be called complete (2026-09-21)

This is the honest residual list for PawSpace V2 on branch `fix/v2-human-test-launch-20260921`.
Nothing here is a guess: each line names what was actually observed and who has to act.

## 1. External setup nobody in the build can supply

| Item | What blocks it | What was verified instead | Who acts |
| --- | --- | --- | --- |
| Razorpay TEST capture, signed webhook, refund, invoice reconciliation | No Razorpay sandbox credentials in the local environment; every Pay is an honest inline 503 ("Razorpay test checkout is not configured"). Staging certification reports Razorpay TEST **is** configured there, so this line can be closed on staging by a human. | Reservation, recovery, replay and refusal paths end to end; no fake success anywhere. | Ops/owner, on staging |
| Real AI answers (chat, bot routing quality, voice STT→AI→TTS) | No AI provider key and no Workers AI binding locally; every turn hands off honestly. Exact refusal strings recorded in the AI findings. | Handoff, staff takeover, return-to-AI, ownership boundaries, refusal visibility, audit rows. | Owner (provider funding/config) |
| Pet Taxi route ETA / neighbourhood search | `GOOGLE_MAPS_SERVER_API_KEY_UAT` unset locally → governed 503. Customer copy no longer names the variable (V2-059). | Quote refusal, Boarding→Taxi continuation UI, trip lifecycle with route classes. | Ops/owner |
| Durable media storage for service proof | Media adapter not connected: uploads are hashed and discarded (`objectStored=false`, `adapterConnected=false`). | Upload, review and approval flow; the UI now states what actually happened rather than "uploaded and verified". | Ops/owner |
| WhatsApp / Haptik / SMS external delivery | `HAPTIK_API_KEY` unset (503), WhatsApp UAT webhook secret unset (503), `PAWSPACE_COMMUNICATION_ENV` unset locally. | Simulated inbound refused honestly; consent gates enforced. | Ops/owner |
| Native device behaviour (background GPS, camera, notifications, storage) | Not reachable from a headless browser at all. | Browser geolocation including a real `PERMISSION_DENIED` path, geofence refusal and recovery. | Human tester on a device |

## 2. Owner decisions (policy, not code)

1. **Sitting Meet & Greet pricing** — the customer card says ₹500, the review line says ₹0, and no ₹499/₹500 rule exists anywhere in the code. The dead control is a defect and is being fixed; the price itself is an owner decision and was not invented.
2. **Cancellation of unpaid reservations** — an unpaid grooming or boarding reservation cannot be cancelled by the customer ("Cancellation unavailable"); boarding request controls are disabled while unpaid. Intended or not is a policy call.
3. **Customer AI rollout stage** — currently `staff_only`, so every customer turn is handed off as `rollout_gated`. Moving the stage is an owner decision.
4. **Human contact channel for web-chat handoffs** — after a staff takeover there is no staff→customer reply path on a non-WhatsApp thread, and the customer is told only that the conversation is being routed. Which channel answers, and what the customer is promised, is an owner decision (the missing reply control is being fixed once the channel is chosen).
5. **Lead-routing policy key and assignment UI** — assignment policies match on a free-text city label; the CRM stores a city id. The matching now accepts both, but whether policies should be keyed by city id, and whether staff get an assignment screen at all, is an owner decision.
6. **Employee-AI thread identity** — handoff rows are keyed to CRM contact ids, so the queue shows masked ids instead of canonical customers.
7. **Completion and payout before cash collection** — providers can complete a pay-after-service job before the cash is collected.
8. **Trainer compensation rule** — a completed training session is held "pending rate configuration" because no rate exists.
9. **Seeded sitter/host acceptance window** — three minutes, which expires before a local payment can be made.
10. **An active leave policy for UAT** — the 500 is fixed and the refusal is governed, but whether a policy is seeded for testers is an HR/owner call.

## 3. Verification that only a human on staging can close

- Browser journeys **on the deployed staging host**. The sandbox that produced this branch cannot reach it, so every
  browser result here came from a local build of the exact SHA. Staging carries the CI certification (28/28).
- The "Automated human sweep (staging)" workflow only runs from `main` and requires the SHA to be contained in `main`,
  so it cannot cover a PR-branch SHA. Run it after merge.
- Publishing grooming packages in staging Pricing Control: every local run had to publish them first
  (`PATCH /api/pricing-control`, reason "UAT publish"). Staging needs the same or `/v2/grooming` cannot book.

## 4. Repository gates that need a human decision

- **Gitleaks Secret Scan** is red for this PR's commit range: ten test-only literals (QA idempotency labels, a test
  signing value, and the `rzp_test_taxiFixture` key-id **format** fixture). The current source no longer contains
  key-shaped literals, but the historical commits in the range still do. The repo's convention for exactly this case
  is to list the exact fingerprints in `.gitleaksignore`; that file was deliberately **not** touched here because it
  is a security-policy gate. A maintainer should decide.
- **CodeQL** reports one new high-severity alert on this PR, and it is the only red check left. A maintainer
  needs to read it; it takes seconds with repo access:
  <https://github.com/PawSpaceIND/pawspace-tech-platform/security/code-scanning?query=pr%3A960+tool%3ACodeQL+is%3Aopen>

  What was tried from here, so nobody repeats it. The alert's rule, file and line live in the check run's
  *annotations*. The GitHub MCP toolset exposes no code-scanning or annotations method; the check run's own
  `output.text` is empty and its summary gives only the count; the CodeQL action uploads its SARIF to the
  code-scanning API rather than as a workflow artifact, so there is nothing to download; the CodeQL bundle
  cannot be fetched to re-run the analysis locally because the egress proxy does not allow that repository;
  and a direct API call is refused (403) without credentials this session was not granted.

  What was ruled out by auditing the diff against what `security-extended` rates high:
  - `js/code-injection` — `tests/lp-d06-handling-requirements-labels.test.mjs`, new on this branch, sliced
    function bodies out of `app/partner-app/job-notes.tsx` and passed them to `new Function`. That was a real
    sink and was removed (the tests render the component instead), but **CodeQL stayed red afterwards**, so
    it was not this alert. The change is kept on its own merits. The repository's two other `new Function`
    uses both predate this branch.
  - `js/sql-injection` — the only interpolated SQL identifier added here, `${field}` in `lib/lead-attempt.ts`,
    is a ternary over two hardcoded column names and cannot carry user input.
  - `js/redos` — the one added regex with a quantified group, the email check, cannot backtrack ambiguously
    (its repeated group must start with a literal `.`, which its character class excludes) and its input is
    length-capped at 254 first.
  - `js/insecure-randomness` — the two added `Math.random()` uses are test-fixture invoice numbers, not
    secrets, tokens or keys.

  Note the check's own caveat: *"Alerts not introduced by this pull request might have been detected because
  the code changes were too large."* This PR is 285 files, so a pre-existing alert surfacing here is a real
  possibility and should be considered before anyone treats it as a regression.
