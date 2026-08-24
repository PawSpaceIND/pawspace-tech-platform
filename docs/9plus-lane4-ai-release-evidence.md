# Lane 4 — AI, voice, readiness, CI: closure evidence

Branch `closure/9plus-lane4-ai-release`, cut from `main` at `a95ed7adbbf513ed78e4b88b22afa38ce3b5c940` and synced with `main` at `85ac0c6e275a93d1690428c59aac0b214cdcddf4`.

Every number below is produced by something in this branch that a reader can re-run. Where a claim
cannot be made because nothing external is connected, this document says so rather than rounding it up.

---

## 1. The headline finding: the AI module's proof was 76% grep

`scripts/evidence-class-audit.mjs` classifies every suite by what it actually **executes**, derived from
its imports and never from its name:

| evidence class | what it can catch | suites | share |
| --- | --- | --- | --- |
| `real_execution` | behaviour, persistence, negative paths. The only class that can prove a gate refuses something | 123 | 40% |
| `imported_unit` | pure logic and refusal decisions; cannot prove anything was written or read back | 24 | 8% |
| `hosted_provider` | that an integration is live | **0** | 0% |
| `source_contract` | that a named symbol still exists in a file | 160 | 52% |

Run it: `node scripts/evidence-class-audit.mjs`. Add `--json` for the per-suite rows.

Before this branch, the `ai` bucket was 17 suites: **3 executed, 13 source-text**. A test asserting that
`"refund.issue"` and `"approval_gated"` appear in `lib/ai-tool-registry.ts` passes if both words sit in a
comment and the gate is gone. That is what the AI module's coverage consisted of.

Two properties make the classification honest, and both were added after they misclassified the
strongest suites in the repository as the weakest:

- Signals are collected **transitively** through test-local modules. A suite that drives routes through
  `helpers/grooming-journey-harness.mjs` imports no source file itself.
- A `wrangler dev` spawn counts as real execution and its worker entry is followed. The Release-CI D1
  jobs boot an actual Worker over an actual D1 binding; that is more execution than a `node:sqlite`
  shim, not less, and no `node:sqlite` import appears in the suite that drives it.

**What this audit cannot tell you**, stated because the point of it is to stop the repository claiming
more than it has: it is STATIC analysis. It reads what a suite imports and spawns; it does not run
anything, so it cannot know whether an imported function was ever called or a booted Worker ever
received a request. A file that imports `lib/refunds.ts` and `node:sqlite` and then asserts `1 === 1`
classifies as `real_execution` and proves nothing. The classes are therefore an **upper bound** on
evidence strength — decisive in the direction that matters (a `source_contract` suite cannot be proving
behaviour, whatever it asserts) and no more than that in the other. Measuring actual invocation would
need per-suite coverage instrumentation over a real run; that is a different, much heavier tool and is
not pretended to here. The boundary is itself pinned by a test.

`tests/evidence-class-audit.test.mjs` proves each class positively and by sabotage (remove the feature,
the classification must drop), and enforces two floors that cannot regress:

- no suite may claim execution in its name while only reading source — currently **0**;
- the AI and voice buckets must carry executed evidence, not source-text volume.

### Renames

Six AI suites named for gates they proved by grep now say what they are:

| was | is |
| --- | --- |
| `ai-analytics-gate9` | `ai-analytics-source-contract` |
| `ai-evaluation-security-gate7` | `ai-evaluation-security-source-contract` |
| `ai-integrated-uat-closure` | `ai-integrated-uat-source-contract` |
| `ai-voice-gate8` | `ai-voice-source-contract` |
| `ai-web-chat-gate6` | `ai-web-chat-source-contract` |
| `ai-whatsapp-uat-gate5` | `ai-whatsapp-uat-source-contract` |

**40 suites remain that claim a verdict in their name and prove it by grep** — `walking-gate3`,
`taxi-closure`, `boarding-gate1` and the rest. `walking-gate3` greps `lib/walking-*.ts` and passes
whether or not a walking booking can be created. They are owned by other closure lanes, so they are
**frozen rather than renamed across a lane boundary**: the guard freezes the exact SET (a count-only
guard would let a new overclaiming suite appear whenever an old one was renamed away in the same
change), and refuses any new one in Lane 4 scope. The full list is in the audit output
and is a cross-lane finding for Lanes 1–3, not a Lane 4 change.

### Per-module counts (top of the table; full table in the CI artifact)

| module | suites | real_execution | imported_unit | hosted_provider | source_contract | route handlers executed |
| --- | --- | --- | --- | --- | --- | --- |
| cross-area | 33 | 32 | 1 | 0 | 0 | 44 |
| ai | 20 | 6 | 1 | 0 | 13 | 2 |
| provider | 18 | 6 | 0 | 0 | 12 | 2 |
| release | 12 | 1 | 3 | 0 | 8 | 1 |
| voice | 10 | 5 | 4 | 0 | 1 | 3 |
| readiness | 2 | 1 | 0 | 0 | 1 | 0 |

Release CI now publishes this inventory as an artifact on every run (`evidence-inventory` job), so a
closure claim can be read against the kind of evidence behind it.

---

## 2. AI provider boundary

`lib/ai-provider-adapter.ts` carried the same defect set the telephony adapter was hardened against
last month, one for one:

| defect | what actually happened |
| --- | --- |
| no deadline | a provider that accepts and then stalls held a Worker request open until the platform killed it. The caller saw a generic 500, so nothing retried and nothing escalated |
| headers-only timeout would not have been enough | an `AbortController` released after `await fetch` bounds the handshake and not the body. A provider that sends headers and then trickles bytes is unbounded again |
| no size bound | `await response.text()` on an untrusted origin |
| no output validation | `(body.content \|\| [])` throws on a null body, so a 200 carrying `null` crashed the caller instead of degrading to a handoff |
| provider body echoed | `detail.slice(0, 300)` put arbitrary provider text — the provider's description of **our** request, prompt included — into a `reason` rendered on staff screens and written to audit rows kept indefinitely |
| unverified `modelRef` | a configured key produced `modelRef: "claude-sonnet-4-6"`, claiming a model that had never answered |

Now: every failure is classified (`timeout`, `network`, `rate_limited`, `provider_error`,
`client_error`, `oversized_output`, `malformed_output`, `empty_output`, `not_configured`) with a
`retryable` flag; the abort signal is held through the body read; every caller-visible reason comes from
a fixed vocabulary plus a numeric status; `aiProviderConnection()` reports configuration as
configuration and `verified` stays false until `verifyAiProvider()` completes a real round trip.

**`tests/ai-provider-adapter-execution.test.mjs` — 20 executed cases.** The origin is the only thing
stubbed; no AI module is mocked.

| requested behaviour | executed evidence |
| --- | --- |
| normal output | text, requested model, stop reason and measured latency returned; the model **sent on the wire** is asserted to be the model reported |
| empty output | `""`, whitespace-only and `content: []` all refuse with `empty_output`, never pass through as a reply |
| malformed output | 8 shapes — `null`, `[]`, a bare string, `{}`, non-array `content`, a text block with no text, non-JSON, `[null, 7]` — each a classified refusal rather than a thrown exception |
| timeout | a provider that never answers hits the deadline; **and** a provider that answers with headers then trickles the body hits the same deadline (this case fails if the timer is cleared after the handshake — verified by sabotage) |
| 4xx | 400/401/403/404/422 → `client_error`, `retryable: false` |
| 5xx | 500/502/503 → `provider_error`, `retryable: true`; 429 → `rate_limited`, retryable |
| network failure | `network`, retryable |
| retry / idempotency | a rate-limited call retried succeeds; a 400 is proved terminal, because a caller that retries a 400 forever is the bug the classification prevents |
| no-provider fallback | with no credential the adapter refuses **without any network call at all** |
| no prompt/secret leakage | canary prompt, canary provider body and a canary credential across five failure shapes; every reason asserted free of all three, and asserted to contain no structured payload at all |
| credential handling | key travels in the header, never in the URL or the body |

Bounds proved: `max_tokens` clamped both ways; the deadline clamped against `0`, negatives, garbage and
absurd values; the response cap enforced on an oversized body.

### Mandatory human approval

`ai-governance` has always forbidden eight autonomous actions. Two of them — `outbound_contact` and
`customer_merge` — had **no tool code in the registry**, so there was no `approval_gated` entry to refuse
the capability when asked for by code and nothing telling a reviewer these two need a human. Added
`communication.send` and `customer.merge`, plus `HIGH_IMPACT_TOOL_FOR_ACTION` so the mapping is one fact
in one place.

**`tests/ai-tool-approval-execution.test.mjs` — 14 executed cases** against a real SQLite-backed D1.
The eight actions are read from `forbiddenAutonomousActions`, so a ninth forbidden action fails the
suite until it has a gate.

| requested proof | executed evidence |
| --- | --- |
| refunds, pricing, payments, payouts, campaigns, communication, provider decisions, customer merges | each returns `approval_required`, `executed: false`, and **leaves no execution-request row at all** — an approval-gated tool is not even queued by the AI |
| a `*`-permission founder | cannot execute one either: gating is a mode, not a permission, so nothing can hold it |
| forbidden tools | 5 unregistered codes refused, including `__proto__` and a trailing-space variant |
| invalid tool arguments | 10 server-authoritative fields (`price`, `total`, `provider`, `walletBalance`, `refundAmount`, …) refused before anything runs; out-of-range quote arguments refused |
| retry / idempotency | a mutation without an idempotency key is refused; a replayed prepare returns the first request; a replayed confirmation creates no second case |
| human approval before effect | nothing exists until the customer confirms |
| ownership | a customer cannot drive a tool against another customer's data, nor confirm another's pending mutation |
| audit without leakage | the full trail (`confirmation_requested` → `explicitly_confirmed` → `executed_mutation`) exists, a canary argument value appears in **none** of it, and the arguments are identified by a SHA-256 hash proved to differ for different arguments |
| canonical rejection | recorded as `failed` / `canonical_service_rejected`, never silently swallowed |

### Human handoff

**`tests/ai-orchestrator-handoff-execution.test.mjs` — 10 executed cases** driving the real
orchestrator over real SQLite, asserting on the `ai_handoffs` and `ai_conversation_turns` rows that
exist afterwards. "The provider failed" is not one path: a thrown error, an empty answer, whitespace,
an unsupported answer and a low-confidence answer are five branches, and a customer who gets silence
from any of them has been dropped. Also proved: a refund conversation never reaches the model; an
explicit request for a human wins over a healthy provider; a prompt-injection attempt is not forwarded;
the rollout gate is fail-closed on a cold database; the model's context contains one customer's data and
not another's; and — so the negatives are not passing for the wrong reason — a healthy provider on an
in-scope question **does** answer.

One behavioural change: handoff-reason precedence now puts the structural blockers (rollout off, no
provider) above `low_confidence`. Every branch hands off either way, but recording `low_confidence`
while the assistant is switched off sends an operator looking for a better model instead of a switch.

### Honesty fixes

Two surfaces reported a disconnected provider as a hardcoded constant regardless of the environment
(`app/api/ai-intelligence/route.ts`, `aiConversationSnapshot`). One had that constant **pinned by a
source-text assertion** in `platform-closure`, which is how it survived: the assertion protected the
literal instead of the property. Both now derive the status, and report separately that configuration is
not verification.

### Not claimed

**No actual AI provider traffic was executed.** `PAWSPACE_AI_PROVIDER_API_KEY`,
`PAWSPACE_AI_PROVIDER_URL`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are absent from this environment;
there is no `.dev.vars` and no AI binding in any wrangler config. `INT-AI-01` therefore stays at
`production_setup_required`, and `verifyAiProvider()` — the function that would produce the evidence —
returns `verified: false, failure: "not_configured"` here. Every failure branch above is executed
against a stubbed origin, which is the difference between "the code handles a 429" (proved) and "this
provider is live" (not proved, and not claimed).

---

## 3. Voice operator console

The voice stack shipped its governance layer, 27-state machine, ten-check policy gate, provider adapter
and signed callback receiver **with no operator surface**. The only way to run one of the eighteen UAT
scenarios was to hand-craft HTTP requests. `/team/voice` was also unreachable from Team home — the same
gap `/team/ai` had.

`app/team/voice/page.tsx` is built around three properties, each a way an operator console can cause the
harm the governance layer exists to prevent:

1. **Nothing on it can enable voice.** The environment decides (`lib/voice-call-gate.ts`); the page reads
   that decision, disables its own controls to match, and shows the blocked reason rather than letting
   controls silently do nothing. It sends no field the gate consults.
2. **A dial is never the first click.** "Check policy" runs the real gate as a dry run with nothing
   created and nothing dialled; the dial stays disabled until a preview for the **current** request comes
   back allowed.
3. **One composed request dials at most once.** The idempotency key is minted when the preview passes and
   reused for every attempt, so a double-click or an impatient retry returns the existing call.

The decision lives in `lib/voice-operator-console.ts`, not in a `disabled={...}` attribute: a safety
property expressed in JSX can only be checked by reading markup, which makes "the button was disabled"
and "the button was disabled for the right reason" indistinguishable.

**`tests/voice-operator-console.test.mjs` — 16 executed cases.** The one that matters most: an allowed
preview followed by an edit to the recipient number must not dial. Every field is checked individually,
and whitespace is proved **not** to count as a different recipient. Also proved: an allowed preview
cannot clear a closed gate; unloaded state is not treated as permission; a sales-approval-gated use case
is never offered while that approval is absent; a recipient number is only ever rendered as its last
four digits.

The console also exposes the ledger with per-call operator actions (hand off, opt out, retry, cancel) and
the full per-call audit trail — policy decisions, state transitions and provider callbacks.

### Not claimed

**No real Exotel call was created, and no STT or TTS ran through a configured engine.** All six
`EXOTEL_*` secrets and every `PAWSPACE_VOICE_*` variable are absent from this environment, and no
wrangler config declares them. `INT-VOICE-01` stays at `sandbox_setup_required`. The eighteen scenarios
in `docs/VOICE_UAT_CHECKLIST.md` are executable **once credentials exist**; the operator console is what
makes running them practical. Setup remains an external Exotel task, not an engineering one.

---

## 4. Readiness registry

The registry is the platform's single answer to "is this integration actually live?", and its previous
answer could be produced with nothing behind it: `evidence_reference` was free text, so a row whose
twelve verification columns all read `verified` and whose reference read "verified in UAT" was reported
as `controlled_live_verified` with no artefact anyone could check.

`controlled_live_verified` now additionally requires a stored observation of an actual provider round
trip, and requires `evidence_reference` to name it by id so the claim and the artefact cannot drift
apart. An observation carries the five things that make a claim checkable later:

| field | refused when |
| --- | --- |
| `provider_reference` | a placeholder (`TODO`, `n/a`, `pending`, …) or under six characters — it has to identify something on the provider's side |
| `commit_sha` | not exactly 40 hex characters, or all zeros. "Verified on main" does not identify a build |
| `observed_at` | absent, implausibly early, or in the future |
| `expected_result` / `actual_result` | either absent or a placeholder. `matched` is **derived**, never asserted |
| `durable_reference` | prose, or a scheme that could not resolve to the declared `evidence_kind` (a `platform_audit_row` pointed at `provider:…`, a `provider_dashboard_record` at `ledger:…`). Must be `d1:` / `audit:` / `ledger:` / `r2:` / `kv:` / `artifact:` / `provider:` — an artefact nobody can fetch again is not durable evidence |

The registry validates that a reference **could** resolve and that it matches the kind of artefact
claimed. It does **not** dereference it: verifying an R2 object or a third-party dashboard record is not
possible from this module, and a check that appeared to do so would be the same overclaiming the
registry exists to prevent. That boundary is pinned by a test rather than left implicit.

A mismatch is still **recorded** — it is a real observation and the trail should keep it — but a row with
`matched = 0` can never support verification.

**Credential presence is configuration and nothing else.** That was already the intent; it is now
executed: a suite drives `syncIntegrationCredentialPresence` with a full set of Exotel and AI
credentials and asserts `readiness_state`, `last_verified_at`, `controlled_live_verified_at` and all
twelve verification columns are untouched.

Recording evidence is a separate `POST` action from `PATCH` on purpose: a single call must not be able to
both assert a readiness state and manufacture the evidence for it.

**`tests/integration-readiness-live-evidence.test.mjs` — 16 executed cases**, including sixteen distinct
rejected observations, and the two negatives that matter most — a mismatched observation does not unlock
controlled live, and a failed attempt rolls the state back rather than leaving it half-granted.

### Evidence requests from Lanes 1–3

`integration_evidence_requests` lets another closure lane record what it needs proven **before anyone has
credentials**. A request is idempotent per code + lane + scenario (re-running a lane's closure script
does not reset the queue or double-count a blocker) and closes only when a matched observation for that
scenario exists. `POST /api/integration-readiness {action:"request_evidence"}` files one at
`launch.view`; asking for proof changes no readiness state.

**No lane has filed a request.** `list_pull_requests(state=open)` on
`PawSpaceIND/pawspace-tech-platform` returns `[]` — no Lane 1, 2 or 3 PR is open, so there are no
evidence requests to integrate yet. The mechanism is in place and the queue is empty.

### Current readiness table (unchanged by this branch, and that is the point)

| integration | provider | readiness | why not higher |
| --- | --- | --- | --- |
| `INT-VOICE-01` | Exotel | `sandbox_setup_required` | no credential in any environment; no call has ever been placed |
| `INT-AI-01` | not approved | `production_setup_required` | no provider credential; external provider not considered connected by default |
| `INT-PAY-01` | Razorpay | `code_ready` | sandbox only; live mode disabled |
| `INT-COMMS-01/02` | LimeChat / Exotel SMS | `sandbox_setup_required` | adapter boundary exists, external execution pending |
| everything else | — | see the registry | 0 integrations are `controlled_live_verified` |

`listIntegrationReadiness().productionReady` is `false`, and `p0ControlledLive` is `0`.

---

## 5. Staging certification

`deploy-staging.yml` built, configured, deployed, installed secrets and printed "Staging deployed as
pawspace-staging". Six facts a human UAT round depends on were unverified, and two of them had already
cost testers a round: the staff directory was a separate manual workflow nobody had run, and UAT sign-in
refuses any email that is not an active `app_users` row.

The workflow now checks out the requested **exact** sha and refuses a branch name, a short sha, a
mismatched `HEAD` or a dirty tree; captures a rollback reference **before** deploying; deploys with
`--message "staging <sha>"` so the live version is attributable; loads the staff directory; and runs
`tests/e2e/staging-certification.mjs` against the deployed origin and the deployed configuration.

| requested proof | how it is proved |
| --- | --- |
| exact deployed SHA | `wrangler versions list` must contain the deploy message **exactly**. A substring match would let "redeploy of staging `<sha>` (retry)" satisfy it |
| dedicated D1 binding | exactly one binding, named `DB`, database `pawspace-staging`, id equal to `STAGING_D1_ID` and not equal to `PRODUCTION_D1_ID` |
| environment mode | `PAWSPACE_PAYMENT_ENV=sandbox`, `PAWSPACE_UAT_LOGIN=on`, and no live or approval flag riding along |
| required seeds and staff identities | founder, admin and manager must each be an active `app_users` row with a role definition **and** must complete a real sign-in — two different failures, both of which stranded testers |
| route smoke pack | six read routes must answer for a real staff session **and** refuse an anonymous caller |
| post-deploy hosted gate | every check above runs against the deployed origin, not a local build |
| sanitized evidence artifact | uploaded pass or fail; refused outright if a known sensitive value survives into it |
| rollback reference | required, not advisory — a deploy with no recorded predecessor has no way back |

Two design rules shared with the release-preview gate:

- **A required check that could not be run FAILS.** A check nobody ran is indistinguishable from a
  failing one, and a gate that reports success for an unverified deploy is worse than no gate.
- **Isolation is checked first and THROWS**, rather than being recorded and continued past. Every later
  check writes a session and reads tables in whatever database the config points at; if that is
  production, running them *is* the harm. A test proves that on an isolation failure not one statement
  and not one request is issued.

Certification is read-only: it never posts to a business route, because it runs against a database
testers are about to use.

**`tests/staging-certification.test.mjs` — 29 executed cases**, each breaking exactly one thing in an
otherwise correct world. Eight distinct ways of pointing at something that is not isolated staging; a
credential serialized into the deployed config (the defect `stage-config.mjs` was fixed for, now proved
at the artefact that actually shipped); a route open to anonymous callers; a sign-in that returns 200
with no cookie.

### Release CI

Two jobs added:

- **Evidence class inventory** — publishes the audit output as an artifact on every run.
- **Test harness hook paths** — `tests/helpers/module-hooks.mjs` has two implementations of the same
  resolver: `module.registerHooks` on Node ≥ 22.15, and an out-of-thread loader hook below it. Every
  other job pins 22.13.0, so the `registerHooks` branch was **never exercised anywhere in CI** — which is
  exactly how the loader-hook branch came to be missing from several suites and to take the whole file
  down on the pinned version. This job runs all 57 hook-dependent suites on a Node that has
  `registerHooks`, then forces the fallback on the same runner. Both paths verified locally: 685 cases,
  0 failures, each way.

Release CI is now 11 jobs. All new suites run in the existing `web-tests` and `backend` jobs, which glob
tracked `tests/*.test.mjs`.

---

## 6. Convergence status

**Lanes 1–3 have not opened their pull requests.** `list_pull_requests(state=open)` returns `[]`. No
head SHAs are available, so the cross-lane blocker review, the shared-file ownership check and the merge
sequencing cannot be performed yet.

Recommended order once the three PR URLs and head SHAs are supplied: **Lane 2 → Lane 1 → Lane 3 →
Lane 4**, each remaining branch syncing once from `main` after the preceding merges. Then one exact-`main`
Release CI run, one isolated release preview, the hosted post-deploy / real-D1 / integration gates, and
the final module matrix.

**Business human UAT is not authorised, and no production deployment is proposed**, for reasons that are
independent of the other lanes:

- No integration is `controlled_live_verified`; `p0ControlledLive` is 0.
- The AI provider has never been reached from this platform.
- No voice call has ever been placed; no STT or TTS has run.
- `hosted_provider` evidence across the entire repository is **0 suites**.

Those four are external-setup blockers, not engineering blockers. The engineering side of Lane 4's owned
scope is closed and executable; the operational side needs credentials that do not exist in any
environment yet.

---

## 7. How to re-run everything in this document

```bash
# evidence class inventory (and the per-module table)
node scripts/evidence-class-audit.mjs
node scripts/evidence-class-audit.mjs --json

# the 116 executed cases added by this branch
node --experimental-strip-types --test \
  tests/ai-provider-adapter-execution.test.mjs \
  tests/ai-tool-approval-execution.test.mjs \
  tests/ai-orchestrator-handoff-execution.test.mjs \
  tests/voice-operator-console.test.mjs \
  tests/integration-readiness-live-evidence.test.mjs \
  tests/staging-certification.test.mjs \
  tests/evidence-class-audit.test.mjs

# both test-harness hook paths
mapfile -t suites < <(grep -l "helpers/module-hooks.mjs" tests/*.test.mjs | sort)
node --experimental-strip-types --test "${suites[@]}"
PAWSPACE_FORCE_LOADER_HOOK=1 node --experimental-strip-types --test "${suites[@]}"

# the whole tracked suite
npm test
```
