# Task4 — local migration and canonical authority candidate

**Status: draft for root review.** Source and SQLite tests only. No remote migration, runtime setting, mode activation, browser, paid model, publication or PR. This candidate is not a completed production dual workflow.

Current base: `cceeceba21db95d510d81b235cb17f76db22a88b` (fetched main, merged #1216). The ten new local candidate files were initially replayed from `257fb5968d5ef52e7f33b2a18a429e83a83c7ad0` in isolated detached worktree `2026-10-01/task-2/task4-ownership`. The fetched `cceeceba` base has no tracked `0045` migration or candidate-file collision. A fresh remote-main check after restart failed DNS resolution; recheck is required before draft publication. Original-base evidence is retained separately under workspace `task4-evidence/original-base`; updated-base results are under `task4-evidence/replayed-main`. Post-restart 90-test results and candidate typecheck evidence are under workspace `task4-evidence/resumed-review`. Shared handlers remain untouched. No checkout AGENTS.md/SKILL.md was found. Runtime-owned schema conventions and governed migration runners were inspected directly.

## Coherent scope

Ten new files; no existing production files changed:

- `drizzle/0045_grooming_dual_mode_revisions.sql`: replay-safe revision persistence, existing-thread backfill, ownership/status/scope/handoff triggers, conservative global controls/terms revision and installation marker. Migration number must be checked against current main before publication.
- `lib/grooming-revision-installation.ts`: manifest generated from exact candidate trigger definitions, readiness and atomic SQL installation predicate. Missing, partial or stale/no-op definitions cannot issue/commit authority. No lazy schema creation.
- `lib/grooming-persisted-ownership-lease.ts`: existing canonical thread/customer/assignment/handoff projection and durable owner epoch; generation recheck and final batch assertion.
- `lib/grooming-dual-mode-authority.ts`: server-resolved scope, actor, controls, incarnation and stored terms; opaque capability, generation recheck and guarded canonical transaction entry point.
- `lib/grooming-dual-mode-ownership.ts`: initial pure ownership/confirmation/send contract. Do not persist this as a parallel workflow database.
- Three isolated tests: `grooming-dual-mode-ownership.test.mjs`, `grooming-persisted-ownership-lease.test.mjs`, `grooming-dual-mode-authority.test.mjs`.
- `tests/helpers/grooming-authority-harness.mjs`: loads existing source-owned prerequisite DDL and candidate migration into in-memory SQLite.
- This document.

The `drizzle` archive is governed replay material, not an automatic migration ledger. No new `migrations/` directory, bootstrap change or runtime flag was added. Existing source tables must be initialized by their current owners before this archive is installed. A missing prerequisite aborts/incompletely installs; opted-in authority refuses incomplete installation. Root must choose the runtime-owned installer/bootstrap sequence before wiring.

## P1 reproduction and correction

The prior handoff-count proposal was insufficient. Executed repository `assignConversation` AI → staff → AI and `setConversationStatus` open → closed → open calls returned to their original state without any handoff event change. Both old leases were accepted and committed booking linkage. The earlier 38 passing tests missed these paths. They now exist as rejection regressions.

`conversation_ownership_revisions` stores a monotonic integer per canonical thread, including a tombstone after deletion. Existing-thread backfill uses `INSERT OR IGNORE`, preserving revisions on replay. Triggers advance on insertion, deletion and changes to thread ID, customer, lead, booking, ticket, assignment or status. Handoff insert/update/delete also advances the affected thread revision, including queued pause and resume when assignment values happen to be unchanged. Moving a thread/handoff ID advances both old/new identities. Guards prevent revision reset/delete; CHECK constraints stop wrapping beyond JavaScript's safe integer range. Timestamp/message/SLA-only writes do not invalidate ownership.

Database triggers cover EVERY SQL writer of these columns: assignment/status functions, handoff CAS batches, enqueue assignment overrides, web-chat implicit reopen, CRM merges, direct SQL and replacement/reused IDs. They participate in the source transaction: failed takeovers/status changes roll back both state and revision. No changes to each writer are required for this epoch. Administrative DROP/rebuild/REPLACE of revision tables is prohibited; restore/rebuild requires a new hosting incarnation and drained old deployments.

Resolution binds the initial thread scope to its owner revision and sandwiches all control reads with the persisted control epoch, refusing mixed snapshots instead of attaching a new epoch to stale scope.

The adapter has no handoff-count or timestamp fallback. It requires a complete installed schema, a valid durable revision, an open canonical thread and matching assignment/handoff. Employee capability requires explicit authorized staff takeover. AI rejects active/queued handoffs and an explicitly employee-owned attached `ai_lead_ownership` row.

## Persisted controls, terms and incarnation authority

One conservative `grooming_effective_control_revision` counter covers the current source tables for:

- Founder goals, budget envelopes and constraints.
- Executive runtime config, audience rollout, global/channel/intent/provider/model kill switches, active profiles/intents/prompts/knowledge.
- WhatsApp routing modes, canonical lead work and AI lead ownership.
- Stored canonical Grooming offer state/quote/actions/confirmation and canonical booking commercial/scope fields.

Insert/update/delete triggers advance the counter in the SAME source statement/transaction. Off/on, away/back, row replacement and same-value control writes invalidate old work. Replay does not reset it. The counter is deliberately global; unrelated controlled-table activity may discard an otherwise valid draft. This is conservative for the first bounded journey; per-scope counters and throughput are not claimed proven.

Payment status/reconciliation is excluded. Canonical booking status-only updates also do not advance this AI counter. This preserves mandatory payment/lifecycle reconciliation under either owner and even at control-counter saturation. Commercial changes remain revisioned. Every payment/booking command still retains the existing canonical payable-state/CAS/role/finance checks. This adapter does not grant payment capture, payout, price override or refund authority.

The migration seeds a random **database incarnation** once; replay retains it. Independent installs differ. A backup restores this value too, so a **hosting deployment incarnation** must rotate on every config/secret/deployment/restore, with old deployments drained. The adapter reads required `PAWSPACE_DEPLOYMENT_INCARNATION` only from `cloudflare:workers.env`; missing means unavailable, never a guessed default. No setting was created or activated here. Hosting must provide this immutable value before integration; an old worker's environment cannot be made transactionally current by a D1 preflight alone.

Server-resolved authority contains the installation epoch/incarnation, owner revision, global persisted control/terms revision, database incarnation, hosting incarnation and a fingerprint of relevant authoritative environment switches. It reuses `activeGoalContext`, `resolveAiAudienceGate`, `resolveActiveAiBusinessConfig`, `atlasAiExecutionEnabled` and the existing Sales `resolveVerticalRuntime`. Customer UAT-only rollout, existing goal modes and WhatsApp fail-closed routing remain effective. Staff generation obeys staff rollout/model configuration; employee canonical continuation does not depend on model switches.

Canonical scope comes from the thread's owned Grooming booking, attached active Grooming lead or stored Grooming offer. Customer/service authority never comes from a model action or submitted lease. Terms come from the latest canonical `voice_sales_offers` quote/actions/expiry/confirmation. A mutation requires confirmed, unexpired stored terms. Quoting/offer preparation must retain the existing read/proposal path and requires a separate reviewed ownership-fenced pending-offer write boundary before reservation; the current mutation entry point intentionally does not treat unconfirmed proposals as confirmed orders.

`issue` takes a server-authenticated actor and canonical identifiers, not authority fields. The trusted system actor must carry existing service identity/communications permission; staff retain existing conversation access. The returned handle is an opaque frozen object tracked in a private WeakMap. JSON/client/model-shaped handles and handles from another adapter instance cannot authorize a commit. A dispatcher after restart must resolve its own persisted canonical context rather than reconstructing a handle from JSON.

## Review corrections and migration sequencing

Schema version 2 adds a durable installation epoch and random incarnation alongside the owner revision, controls revision and installation marker (four tables; 57 exact trigger definitions). A missing/stale trigger or marker advances installation authority before repair, invalidating handles issued before a mutation gap. Recreating the installation table rotates its incarnation. Intact replay preserves both values. SQL comparison literals are split so the existing replay normalizer cannot rewrite stored trigger definitions; the governed remote planner skips intact DROP/CREATE pairs and repairs stale pairs. Hosted installation/repair requires draining affected workers and coordinated runtime-owned prerequisite creation; local replay is not hosted sequencing proof.

The server selects an active assistant profile and binds its actual provider/model before resolving scoped kill switches. Generation checks the connected executor matches that selection. The final batch binds exact selected profile/prompt IDs, versions, hashes and active windows using database time, so expiry between refresh and commit rejects canonical writes and discretionary send intents. Employee continuation still bypasses model configuration and retains staff permissions.

Canonical booking currency and every base canonical field except lifecycle `status` and touch `updated_at` invalidate commercial authority, including away/back changes without an offer update. Existing payment/status reconciliation remains outside that commercial counter. Regression tests cover all four review findings; no existing production writer changed.

## Canonical transaction boundary

`generate` checks effective authority immediately before generation and after asynchronous completion; stale output/proposals are discarded. The trusted provider executor must identify its connected provider/model exactly as selected by the active profile; this change does not connect any provider or promise to cancel an already-started paid request.

`commitCanonicalBatch` re-resolves authority then prepends owner, full controls/incarnation, installation, active goal and exact confirmed quote/actions/expiry assertions to the SAME D1 batch as existing canonical statements. Database-time assertions bound goal/quote expiry at final commit. It does not wrap an asynchronous route call and pretend that is atomic. Caller-side canonical permissions, consent, scope, terms, envelope, provider/capacity and finance approval guards remain mandatory.

The assertion currently uses deliberate SQLite integer overflow to abort/roll back a lost lease. Local tests prove preceding/following statement rollback under SQLite emulation. Real hosted D1 must verify this behavior and stored-trigger formatting before wiring. Trigger definitions are compared in readiness and final SQL; a same-name stale/no-op trigger cannot stand in for the candidate schema. Conservative formatting mismatch is unavailable, not bypassed.

Root-reviewed integration locations:

| Existing location | Planned insertion |
|---|---|
| `ai-conversation-orchestrator.ts` | Resolve server authority for the ONE Grooming journey before provider use; after reply generation and before actionable suggestion/turn persistence. Epoch replaces active-handoff-only ABA logic. |
| `ai-first-control-plane.ts` and `ai-tool-registry.ts` | Propagate trusted internal capability, retain current allow-list, role/elevated-service scope and customer confirmation. Fence confirmation claim AND final canonical transactions. No body/header lease authority. |
| `uat-scheduling/route.ts:commitAssignmentDispatch` | Same reservation/assignment/offer batch, retaining provider capacity, lease and unbooked-group guards. |
| `canonical-bookings/route.ts:executeCanonicalBookingRequest` | Same final booking/work-order/payment-record batch, alongside existing reservation/provider confirmation guards. |
| `payment-order-intent.ts` → `financial-lifecycle.ts:claimPaymentIntent` | Same initial durable intent/outbox transaction and canonical amount/stage key. Provider attempts already started continue through existing uncertainty/reconciliation saga. |
| `meta-whatsapp-ai-executor.ts` → `communication-engine.ts` | Same message/outbox transaction, then dispatcher claim/recheck before discretionary provider send. Preserve canonical lead+booking+ticket thread context and existing consent/opt-out/window rules. |

Send intent/command identities are canonical and stable across actors; they exclude mode/epoch. An uncertain/claimed/sent external attempt is not a new retry opportunity after takeover. Already-in-flight external delivery/payment order creation is reconciled, not forgotten or duplicated. Mandatory callbacks/recovery remain outside discretionary AI gates.

Actual current enqueue characterization proves that forwarding lead AND booking retains the canonical thread, while forwarding only booking can create a second thread. Fix that at integration. Actual current resume updates session/thread but does not restore an attached lead's `ai_owned` projection; the stronger server adapter refuses such a lead until explicit resume updates it in the existing CAS transaction. Do not bypass this gap or create another lead. These shared-handler changes remain pending root review.

## Open PR ownership and publication gate

Read-only recheck during this candidate:

- **#1215 OPEN**, head `5b2c01ea`: owns `ai-tool-registry.ts`, `uat-scheduling/route.ts`, grounded runtime and voice-specialist work. Direct integration conflict. No edits made there.
- **#1216 merged externally** (latest root coordination; prior read-only head `80b3e9bf`): owns `canonical-bookings/route.ts` provider-confirmation change. Direct integration conflict. Preserve/revalidate its guard behavior after it lands.
- #1217 previously inspected head `a17fa693`, based on #1216: provider leave recovery/Training lifecycle, no direct candidate file overlap. Mandatory recovery must not inherit discretionary AI ownership gating.
- #1209 merged/current-main changes and #1207 analytics/test publication are root-managed; no UI, analytics or fixture snapshot changes here.

Root reviews this migration/adapter and integration scope before publication. No grouped PR was created yet. A draft after approval should remain visibly conditional on hosted proof and shared-handler wiring; do not call the ten files a completed dual engine.

## Current local evidence

Run:

```sh
NODE_PATH=/Users/karthikeyanparamasivam/Documents/Codex/pawspace-voice-closure/node_modules \
node --experimental-strip-types --test --test-concurrency=1 \
 tests/grooming-dual-mode-authority.test.mjs \
 tests/grooming-persisted-ownership-lease.test.mjs \
 tests/grooming-dual-mode-ownership.test.mjs \
 tests/ai-handoff-transaction-execution.test.mjs \
 tests/grooming-payment-reconciliation.test.mjs
```

The candidate suites use repository handoff/access/control functions and source-owned canonical booking-core DDL; the guarded transaction inserts into that actual canonical schema. They cover replay/backfill, tombstones/ID reuse, assignment/status/customer/lead/booking/ticket ABA, control/terms ABA, missing/partial/stale-trigger installation, reset/delete protection, saturation, rollback, opaque-handle refusal, server-only incarnations/scope/confirmation, generation staleness, canonical transaction race fencing and models-off employee continuation.

Current combined result: **90/90 passed**, sequential execution after review corrections. The original 72-test result is historical; current coverage includes scoped provider/model switches, selected configuration expiry, commercial currency/all-column ABA, installation repair fencing, intact replay and governed trigger-pair planning.

These are **SQLite emulation of D1 SQL/batch semantics, NOT Cloudflare D1 execution**. The pure foundation's simplified canonical fixture remains contract evidence only. The new authority suite exercises real canonical schema and statements, not complete HTTP checkout routes. Existing handoff/payment suites run unchanged. The focused compiler check reports zero diagnostics in the four candidate TypeScript files using existing sibling dependencies; it is not a repository-wide typecheck/build pass.

## Normal hosted isolated D1 validation plan — not executed

1. Root approve candidate and resolve #1215/#1216 ownership; replay onto reviewed main and re-run local migration/schema/transaction tests. Confirm source table prerequisites and migration number. Review installer/bootstrap ordering; no silent lazy partial install.
2. Provision a NEW named disposable D1 database and ordinary isolated preview Worker through the repository's normal deployment tooling. Verify the exact new database ID/binding before any remote command; do not use production or existing customer staging databases. Give it a unique hosting incarnation, staging/e2e environment and empty synthetic customer data. No paid model/payment/channel credentials.
3. Initialize prerequisite schema via existing runtime owners, then apply only the approved revision candidate through governed replay. Record exact migration hash, Worker revision, D1 database ID and installation manifest. Replay it twice; prove unchanged counter/incarnation and complete trigger definitions as stored by actual D1. Partial install, omitted/stale trigger, absent revision row and saturation must reject opted-in work.
4. Through the ordinary hosted Worker/D1 binding, execute real `DB.batch` ownership/control guards with actual canonical statements and synthetic actors. Assert failure rolls back writes before AND after the assertion, and failed takeover rolls back revision. Use competing requests to reproduce assignment/status/scope/handoff ABA and control off/on cycles. Do not substitute CLI SQL-only success for Worker batch proof.
5. After root-approved shared wiring, drive the ONE canonical Grooming lead → stored quote → reservation → booking/order flow through existing hosted handlers with deterministic test provider/network adapters already permitted in the isolated environment. No paid model or live provider invocation. Test AI → employee → AI before quote, after reservation, pending payment and reply in flight; verify exactly one canonical thread/lead/booking/order/intent and fresh terms confirmation. Models-off employee continuation must use the same handlers and permissions.
6. Exercise existing signed synthetic callback/reconciliation paths during employee ownership and stale AI work. Simulate external uncertain send/order outcomes via dedicated test adapters; prove durable reconciliation instead of resending. Keep consent, opt-out, role/finance/provider/capacity guards in the test matrix.
7. Rotate deployment incarnation with old Worker drained; prove old capabilities/queued discretionary context are refused while mandatory reconciliation continues. Test database restore/rebuild protocol. Archive hashes/results and delete only the approved disposable environment after evidence is retained.

Until those hosted results and final wiring exist, production race closure, external exactly-once delivery and usable deployed dual workflow remain unproven. No 90% readiness claim.


## Latest coordination: prospective shared-file ownership, no edits authorized by this map

Lead-brief owner `01a0f1ed` retains `crm-automation-governance` read-only eligibility and staff-sales brief/Page work. Task4 does not request those files. Hold `lib/ai-conversation-orchestrator.ts` for the Task4 boundary. Availability-race owner `01a0f596` retains its fix; the scheduling/booking entries below require explicit root coordination on `cce` before any edit.

**Proposed Task4-owned shared edits after root review:**

1. `lib/ai-conversation-orchestrator.ts`: trusted capability creation and pre/post-generation/turn persistence boundaries.
2. `lib/ai-first-control-plane.ts`: trusted capability propagation alongside existing delegated role/confirmation guards.
3. `lib/ai-tool-registry.ts`: confirmation CAS and trusted propagation to the existing canonical handlers; #1215 conflict must resolve first.
4. `lib/ai-human-handoff.ts`: attached-lead projection restoration on explicit resume in the same existing CAS batch. Existing writer revision coverage is already supplied by migration triggers; do not duplicate epoch increment logic here.
5. `app/api/uat-scheduling/route.ts`: final reservation/assignment batch fence; coordinate #1215 and availability owner.
6. `app/api/canonical-bookings/route.ts`: final booking batch fence preserving merged #1216 and availability guards.
7. `lib/payment-order-intent.ts`: carry canonical trusted context to initial durable payment intent.
8. `lib/financial-lifecycle.ts`: same intent/outbox-claim transaction fence for discretionary AI-origin commands; keep mandatory callback/reconciliation entry points independent.
9. `lib/meta-whatsapp-ai-executor.ts`: fresh authority, stable canonical context and full thread linkage after generation.
10. `lib/communication-engine.ts`: same canonical message/outbox enqueue batch fence and optional server-only explicit thread context.
11. `lib/communication-provider-boundary.ts`: durable discretionary dispatch claim/recheck; no ownership gate on `recordCommunicationProviderCallback`.

**Other-owner/shared prerequisites, not files Task4 will silently edit:**

- `lib/voice-sales-specialists.ts:prepareVoiceSalesOffer/confirmVoiceSalesOffer` owns current canonical stored-offer SQL. Its owner must add/review an optional server-only ownership/terms assertion at the pending-offer batch/confirmation claim. Wrapping that async function at its caller is insufficient. No premium voice implementation is proposed or edited by Task4.
- `lib/razorpay-order-outbox-saga.ts` retains uncertainty/reconciliation semantics. Any discretionary pre-attempt metadata/check adjustment requires its owner/root review; no ownership gating on an external attempt already underway.
- `worker/index.ts` is a conditional bootstrap edit only after root selects reviewed runtime installation sequencing. The new source adapter/manifest itself remains read-only and does not install DDL on request.

**Control resolver files:** Task4's new `lib/grooming-dual-mode-authority.ts`, `lib/grooming-persisted-ownership-lease.ts`, `lib/grooming-revision-installation.ts` own the additive adapter. No edits planned to existing `goal-context-engine.ts`, `ai-audience-rollout.ts`, `ai-business-configuration.ts`, `agents/runtime/vertical-runtime.ts`, or `atlas-tool-gateway.ts`: their decisions are reused. Existing persisted control/terms/owner writers are covered centrally by database triggers.

Minimal migration candidate is the current `drizzle/0045_grooming_dual_mode_revisions.sql`: three additive tables (thread revision tombstones, global effective revision/incarnation, installation marker), replay-safe existing-thread backfill and owner/status/scope/handoff/control/terms triggers. It creates no goal/mode/rollout value and activates nothing. Check number/prerequisites against `cce`; real D1 installation/batch proof and runtime sequencing remain approval gates.

All these shared edits remain PROPOSED. Current diff is ten new local candidate files only. No shared handler, availability source, lead-brief source or premium voice file has been changed.


## First integration slice: exact Grooming stored quote → reserve → booking fence

This is the NEXT PROPOSAL ONLY, not implemented while independent review `01a0f559` is active. The broader eleven-handler map above is a roadmap, not a single edit request. First slice has four shared files, plus additions to the new authority module/test; no orchestrator, handoff, control resolver, outbox, payment, lead-brief, availability or UI edits in this slice.

| File / owner contract | Exact bounded change |
|---|---|
| `lib/voice-sales-specialists.ts` — requires voice owner's explicit contract; Task4 will not silently take it | Add an optional server-only canonical transaction hook to the stored Grooming offer batch in `prepareVoiceSalesOffer` and exact `pending -> executing` confirmation claim in `confirmVoiceSalesOffer`. Retain the existing three-action plan, fresh server quote comparison, confirmation text, expiry, ownership and commercial checks. No voice transport/provider/specialist behavior changes. |
| `lib/ai-tool-registry.ts` — #1215 ownership review first | Propagate a trusted internal capability/transaction port to `schedule.reserve` and `booking.create` canonical function calls only. Keep stable existing tool/offer command IDs and canonical argument validation. Do not accept authority from request JSON, headers, model action arguments or database JSON. |
| `app/api/uat-scheduling/route.ts` — coordinate #1215 + availability owner `01a0f596` | Accept an optional internal function argument and prepend the authority assertion to `commitAssignmentDispatch`'s existing final reservation/assignment/offer batch (including its unbooked-group branch). Preserve capacity, provider and lease guards. |
| `app/api/canonical-bookings/route.ts` — preserve merged #1216 + availability owner's delta | Accept that same internal optional argument and prepend the authority assertion to the final canonical booking/work-order/payment-record batch. Preserve unconditional provider confirmation guard introduced by #1216 and current reservation confirmation guard. |

Add narrowly named `quote_prepare` and `quote_confirm` transaction boundaries to **new** `lib/grooming-dual-mode-authority.ts`; they do not imply customer consent. `quote_prepare` permits only server-calculated pending terms storage under current owner/control authority. `quote_confirm` binds the exact existing offer identity/quote/actions and an explicit existing confirmation event to the existing CAS claim. `tool_commit` remains unavailable until the canonical confirmation is persisted. These additions need independent approval because current candidate intentionally requires confirmed terms for every `tool_commit`.

Expected execution order, with a fresh server-resolved capability after each successful transaction:

1. Resolve the actual authenticated/service actor, canonical Grooming thread/lead, Founder goal, installed revisions and incarnation. Generate the quote through existing canonical Grooming code. Guard the pending-offer batch before its first supersede/insert statement; takeover/control/terms changes refuse the entire batch. Use the same offer/turn ID on retry.
2. On the customer's separate confirmation, retain the current fresh quote/terms comparison. Guard the EXACT `pending -> executing` claim transaction with expected owner/control/offer identity and expiry; return a lost claim without creating reservations. The claim changes the controls/terms epoch, so refresh after it commits.
3. Execute existing `schedule.reserve` through the registry/canonical scheduler. Final SQL checks current authority inside the SAME batch as reservation, assignment and provider offer. If takeover wins before this point, no reservation is created. If reservation wins first, retain the one existing group; employee continuation uses it.
4. Refresh authoritative state and execute existing `booking.create`. Final SQL checks current authority inside the SAME batch as booking/work order/payment record, ALONGSIDE #1216 provider/reservation assertions. If takeover occurs between reservation and booking, the stale AI does not create a booking; staff reuses the existing group/command under its own current permissions and canonical policy. Link the result to the same thread/lead through existing projection, with any post-commit errors retried against the committed canonical ID.

Slice test matrix must exercise the ACTUAL canonical handlers on the replayed base (not only inserting into core DDL): concurrent takeover at quote supersede/insert, confirmation claim, reservation batch and booking batch; assignment/status/scope/control ABA; failed canonical/provider guard rollback; one pending/confirmed offer, one reservation group and one booking/work order; changed quote forces a NEW confirmation; stale AI refusal leaves staff continuation possible with models off. Reference command results across retry/mode switches, never regenerate booking IDs.

The current stored offer always contains `schedule.reserve`, `booking.create`, `checkout.payment_order.create`; this slice must NOT truncate that list or change the customer flow to hide an unfenced payment action. Local tests may supply existing deterministic payment/network adapters. The slice adds fences through booking only and is NOT eligible for active dual-mode enrollment until the subsequent durable payment-intent and discretionary-send fences have reviewed hosted proof. No runtime exposure/activation is part of the slice.

### Hosted proof for this slice (following the normal isolated plan above)

Root first approves schema/install + these four shared-owner contracts and the two new quote boundaries. Use a NEW disposable D1 binding with the normal preview Worker, prerequisite runtime schema owners and unique immutable deployment incarnation. Execute installed candidate trigger/guard statements through actual hosted `DB.batch`, capture stored definitions and replay results, and test rollback before/after guards. Then run the unchanged canonical quote/scheduler/booking handlers with synthetic data, explicit hosted test actors and deterministic existing test network adapters. Inject competing ownership/control writes at each of the four checkpoints and assert on real D1 canonical rows. Keep all paid credentials and external provider dispatch absent. Do not deploy onto production/customer staging, execute a remote migration, or activate a dual-mode setting without the separate root approval.

Evidence must record Worker version, D1 database ID, exact main/candidate/migration hashes and each injected failure/row assertion. Local focused-test evidence does not replace this proof. No ad-hoc local SQLite or CLI-only SQL run qualifies as hosted Worker batch verification.

### Runtime prerequisite ownership

`ensureGroomingRevisionPrerequisiteTables` explicitly prepares the four revision tables before governed installation. It does not install triggers, seed counters, mark readiness, or run on request paths. Existing durable revisions and incarnations are preserved on replay. Hosted installation still requires the existing owned prerequisites, worker drain, governed migration sequencing and hosted D1 qualification; readiness remains read-only and fails closed until the reviewed installation is complete.


### Incremental runtime installer reconciliation (source candidate)

This correction is based on remote #1222 head `927b4d11607861265e4bd9640bbbcd2f41f9b81a`, preserving the prerequisite owner and both fixture-clock commits. `groomingRevisionPrerequisiteDdl` is exported from `lib/grooming-revision-schema.ts`; both its preparer and the installer use those sole declarations. No duplicate runtime DDL owner is added. The old six-file candidate remains isolated separately and was not pushed over the advanced branch.

`POST /api/ai-bootstrap` gains an explicit `operation: install_grooming_revision_schema` branch with existing same-origin authentication and `settings.manage`, refusal of preview identities and client seed/approval fields, and completion audit. Existing seed semantics remain on their own path. No ordinary Worker request/scheduled bootstrap or dual-mode activation is added.

The operation requires a server-held `PAWSPACE_GROOMING_SCHEMA_INSTALL_APPROVAL` receipt read directly from the Worker environment: purpose `grooming_revision_installation`, binding `DB` (including exact configured D1 object identity), schema version 2, exact authenticated actor email, hosting deployment incarnation, approval ID, `workersDrained: true`, expiry within one hour, and exact expected installation epoch/incarnation and database incarnation (null before initialization). Nothing was provisioned or invoked remotely. Operator issuance must establish/maintain the actual worker and ingress drain, withdraw the receipt after use, and rotate deployment incarnation as required. Source code cannot independently establish that external maintenance protocol.

Before writes, the installer checks platform-owned prerequisite tables/columns, token-level revision-table definitions and live PRAGMA column/key/collation/index/foreign-key contracts. Formatting, comments and identifier quoting are allowed without erasing quoted CHECK values or SQL operators. Unsupported syntax and semantic changes fail closed; unexpected revision-table triggers/indexes are refused. Existing expected triggers remain compared exactly and are repaired only under the maintenance approval.

One guarded batch creates missing revision tables, seeds persistent incarnations, asserts the preflight trigger snapshot, expected incarnations and database-time approval expiry, advances installation epoch before trigger changes, backfills existing threads without reset, repairs changed trigger definitions, publishes marker 2 and asserts final definitions, resulting epoch and expiry. An intact installation changes no revision/schema state and records its completion audit in a batch guarded before and after the audit. Tests cover competing initial installs, partial failure rollback, stale approval, expiry at commit, administrative trigger races and invalidating old leases across a repair gap. Real D1 trigger preparation/batch rollback and the receipt/drain lifecycle remain hosted qualification gates before operational invocation.

Independent review must cover this exact incremental candidate before updating #1222. Fresh remote-head compare and publisher coordination are required; any update preserves external ancestry and uses no force-push.

Local reconciled validation: **152/152 tests passed**, including original ownership/handoff/payment, installer and prerequisite tests, all **16 schema governance** checks, and the preserved pricing/availability clock suites. Seven scoped candidate modules have zero TypeScript diagnostics; this is not a repository-wide typecheck or hosted D1 result.


### Completion audit review correction

An injected `security_audit_events` completion-insert failure reproduced the P2 report: the previous endpoint returned an error after initialization or repair had already committed (repair advanced epoch 2 to 3). The endpoint now supplies the existing `securityAuditStatement` builder to the trusted installer. That completed audit and the resulting readiness assertion are in the same installation transaction; the endpoint makes no separate post-commit completion write. Audit or final-assertion failure rolls back schema/repair, epoch and completion together. Intact replay retains its audit semantics in a guarded audit-only batch, leaves revision/schema state unchanged, and is retryable after audit failure. A successful repair audit records its committed installation epoch and approval ID. Hosted D1 transaction qualification remains required.

The audit-cleared candidate was replayed onto #1222 head `0abbdf6d8189359195649fdc942b84dc098c1ac6`. Existing provider booking guards, fixture-clock changes, migration prerequisite fixtures and chunked trigger-readiness lookup are preserved; the trigger-manifest delta against that head is only its export. No remote installation or activation is performed.

The external chunked-lookup import also required the existing prerequisite test to install the repository loader hooks before dynamically importing readiness. This test-only integration correction preserves application imports and covers both loader paths.

Latest-base validation on `0abbdf6d`: **193/193 combined tests passed**, including D1 migration pipeline/chunked replay, IN-list fanout and provider booking transaction regressions. The installer/prerequisite suites also passed **36/36** through the fallback loader. Scoped TypeScript diagnostics remain zero for seven candidate modules; no repository build or hosted installer was run.
