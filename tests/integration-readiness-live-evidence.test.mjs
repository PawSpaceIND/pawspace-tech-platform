/**
 * Executed evidence for the readiness registry's own honesty.
 *
 * The registry is the platform's single answer to "is this integration actually live?", and its
 * previous answer could be produced with nothing behind it: `evidence_reference` was free text, so a
 * row whose twelve status columns all read "verified" and whose reference read "verified in UAT" was
 * reported as controlled-live verified with no artefact anyone could check. That is the exact failure
 * the registry exists to prevent, so every rejection below is executed rather than described.
 *
 * The credential case is the one that matters most to a reader of the readiness table: a key appearing
 * in the environment moves credential_status and NOTHING else. A provider with credentials and no
 * traffic is configured, not live.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__READINESS_DB__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => {
      sqlite.exec("BEGIN");
      try { const out = []; for (const item of items) out.push(await item.run()); sqlite.exec("COMMIT"); return out; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const registry = await import("../lib/integration-readiness.ts");

const REAL_SHA = "a95ed7adbbf513ed78e4b88b22afa38ce3b5c940";
const OBSERVED = Date.UTC(2026, 7, 20, 9, 30);
const GOOD_EVIDENCE = {
  integrationCode: "INT-VOICE-01",
  scenario: "outbound call reaches ringing then completed",
  providerReference: "CAd41f2c7bd9e84c1a9f0b",
  commitSha: REAL_SHA,
  observedAt: OBSERVED,
  expectedResult: "call state completed",
  actualResult: "call state completed",
  evidenceKind: "provider_webhook_receipt",
  durableReference: "ledger:voice_call_orders:VC-000123",
  recordedBy: "ops@pawspace.in",
};

async function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA journal_mode=MEMORY;");
  const db = makeD1(sqlite);
  await registry.ensureIntegrationReadinessTables(db);
  sqlite.exec("CREATE TABLE voice_call_orders (id TEXT PRIMARY KEY)");
  sqlite.prepare("INSERT INTO voice_call_orders (id) VALUES (?), (?)").run("VC-000123", "VC-1");
  sqlite.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("AUD-1", "ops@pawspace.in", "ops", "voice.callback", "voice_call", "VC-1", "completed", "{}", OBSERVED);
  return { sqlite, db };
}
const row = (sqlite, code) => sqlite.prepare("SELECT * FROM integration_registry WHERE integration_code=?").get(code);

// ---------------------------------------------------------------------------
// Credential presence is configuration only
// ---------------------------------------------------------------------------
test("a credential appearing in the environment moves credential_status and nothing else", async () => {
  const { sqlite, db } = await fresh();
  const before = row(sqlite, "INT-VOICE-01");
  const beforeByCode = new Map(["INT-VOICE-01", "INT-AI-01"].map(code => [code, row(sqlite, code)]));
  assert.equal(before.credential_status, "unknown");

  await registry.syncIntegrationCredentialPresence(db, {
    EXOTEL_API_KEY: "k", EXOTEL_API_TOKEN: "t", EXOTEL_SID: "s",
    EXOTEL_CALLER_ID: "080", EXOTEL_VOICE_APP_ID: "1", EXOTEL_WEBHOOK_SECRET: "w",
    PAWSPACE_AI_PROVIDER_API_KEY: "sk-test",
  });

  for (const code of ["INT-VOICE-01", "INT-AI-01"]) {
    const after = row(sqlite, code);
    assert.equal(after.credential_status, "configured", `${code} credential presence not recorded`);
    assert.equal(after.readiness_state, beforeByCode.get(code).readiness_state);
    assert.notEqual(after.readiness_state, "controlled_live_verified", `${code} became live because a key exists`);
    assert.equal(after.controlled_live_verified_at, null);
    assert.equal(after.last_verified_at, null, "a key is not a verification");
    for (const column of ["auth_verification_status", "webhook_verification_status", "idempotency_status", "replay_status", "retry_status", "audit_logging_status"]) {
      assert.equal(after[column], "not_tested", `${code}.${column} advanced on credential presence alone`);
    }
  }
  // And the readiness state is exactly what the seed said, unchanged by the sync.
  assert.equal(row(sqlite, "INT-VOICE-01").readiness_state, before.readiness_state);
});

test("removing a credential is reported too, and still does not touch readiness", async () => {
  const { sqlite, db } = await fresh();
  await registry.syncIntegrationCredentialPresence(db, { PAWSPACE_AI_PROVIDER_API_KEY: "sk-test" });
  assert.equal(row(sqlite, "INT-AI-01").credential_status, "configured");
  await registry.syncIntegrationCredentialPresence(db, {});
  assert.equal(row(sqlite, "INT-AI-01").credential_status, "missing");
  assert.equal(row(sqlite, "INT-AI-01").readiness_state, "production_setup_required");
});

test("IDfy is code-ready after Lane 2 but stays setup-required until the callback secret is present", async () => {
  const { sqlite, db } = await fresh();
  const outboundOnly = { IDFY_API_KEY: "key", IDFY_ACCOUNT_ID: "account", IDFY_URL: "https://idfy.invalid" };
  await registry.syncIntegrationCredentialPresence(db, outboundOnly);
  assert.equal(row(sqlite, "INT-KYC-01").credential_status, "missing", "outbound credentials cannot configure an unsigned callback");

  await registry.syncIntegrationCredentialPresence(db, { ...outboundOnly, IDFY_WEBHOOK_SECRET: "secret" });
  const configured = row(sqlite, "INT-KYC-01");
  assert.equal(configured.code_boundary_status, "code_ready");
  assert.equal(configured.credential_status, "configured");
  assert.equal(configured.readiness_state, "production_setup_required", "configuration is not provider verification");
  assert.equal(configured.controlled_live_verified_at, null);

  sqlite.prepare("UPDATE integration_registry SET code_boundary_status='partial',updated_by='system_seed' WHERE integration_code='INT-KYC-01'").run();
  await registry.ensureIntegrationReadinessTables(db);
  assert.equal(row(sqlite, "INT-KYC-01").code_boundary_status, "code_ready", "an untouched pre-callback registry row must advance");
});

// ---------------------------------------------------------------------------
// What counts as evidence
// ---------------------------------------------------------------------------
test("a complete, matched observation is recorded and reported back", async () => {
  const { db } = await fresh();
  const recorded = await registry.recordIntegrationLiveEvidence(db, GOOD_EVIDENCE, OBSERVED + 1_000);
  assert.equal(recorded.matched, true);
  assert.equal(recorded.commitSha, REAL_SHA);
  const stored = await registry.integrationLiveEvidence(db, "INT-VOICE-01");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].providerReference, GOOD_EVIDENCE.providerReference);
  assert.equal(stored[0].durableReference, "ledger:voice_call_orders:VC-000123");
});

test("every incomplete or unfalsifiable observation is refused, with the missing part named", async () => {
  const { db } = await fresh();
  const cases = [
    ["a branch name instead of a commit", { commitSha: "main" }, /exact 40-character commit SHA/],
    ["a short SHA", { commitSha: "a95ed7a" }, /exact 40-character commit SHA/],
    ["an all-zero SHA", { commitSha: "0".repeat(40) }, /real commit SHA/],
    ["a placeholder provider reference", { providerReference: "TODO" }, /real provider-side reference/],
    ["an empty provider reference", { providerReference: "" }, /real provider-side reference/],
    ["a provider reference too short to identify anything", { providerReference: "ab1" }, /real provider-side reference/],
    ["no observation time", { observedAt: 0 }, /timestamp it was observed at/],
    ["an observation before the platform existed", { observedAt: Date.UTC(2019, 0, 1) }, /timestamp it was observed at/],
    ["an observation in the future", { observedAt: OBSERVED + 86_400_000 }, /cannot be observed in the future/],
    ["no expected result", { expectedResult: "" }, /expected result/],
    ["a placeholder expected result", { expectedResult: "TBD" }, /expected result/],
    ["no actual result", { actualResult: "" }, /actual result/],
    ["prose instead of a durable reference", { durableReference: "we saw it on the dashboard" }, /durable reference/],
    ["an unknown evidence kind", { evidenceKind: "someone_said_so" }, /Invalid evidence kind/],
    ["no scenario", { scenario: "" }, /scenario it proves/],
    ["nobody recording it", { recordedBy: "" }, /person who recorded it/],
  ];
  for (const [label, override, expected] of cases) {
    await assert.rejects(
      registry.recordIntegrationLiveEvidence(db, { ...GOOD_EVIDENCE, ...override }, OBSERVED + 1_000),
      expected, `${label} was accepted as evidence`);
  }
  assert.deepEqual(await registry.integrationLiveEvidence(db, "INT-VOICE-01"), [], "a refused observation must leave no row");
});

test("an evidence kind must be pointed at by a compatible locally resolvable row", async () => {
  const { db } = await fresh();
  const mismatches = [
    ["platform_audit_row", "ledger:voice_call_orders:VC-1"],
    ["platform_ledger_row", "audit:AUD-1"],
  ];
  for (const [evidenceKind, durableReference] of mismatches) {
    await assert.rejects(
      registry.recordIntegrationLiveEvidence(db, { ...GOOD_EVIDENCE, evidenceKind, durableReference }, OBSERVED + 1_000),
      /cannot be evidenced by a/, `${evidenceKind} accepted ${durableReference}`);
  }
  // And the matching combinations are accepted.
  for (const [evidenceKind, durableReference] of [["platform_audit_row", "audit:AUD-1"], ["platform_ledger_row", "ledger:voice_call_orders:VC-1"], ["provider_api_response", "ledger:voice_call_orders:VC-1"]]) {
    const recorded = await registry.recordIntegrationLiveEvidence(db, { ...GOOD_EVIDENCE, evidenceKind, durableReference, scenario: `accepts ${evidenceKind}` }, OBSERVED + 1_000);
    assert.equal(recorded.matched, true);
  }
});

test("a well-shaped reference to a row that does not exist is refused", async () => {
  const { db } = await fresh();
  await assert.rejects(
    registry.recordIntegrationLiveEvidence(db, { ...GOOD_EVIDENCE, durableReference: "ledger:voice_call_orders:VC-does-not-exist-yet" }, OBSERVED + 1_000),
    /could not be resolved/,
  );
  assert.deepEqual(await registry.integrationLiveEvidence(db, "INT-VOICE-01"), []);
});

test("an observation for an integration that is not in the registry is refused", async () => {
  const { db } = await fresh();
  await assert.rejects(registry.recordIntegrationLiveEvidence(db, { ...GOOD_EVIDENCE, integrationCode: "INT-MADE-UP" }, OBSERVED + 1_000), /Integration not found/);
});

test("a mismatch between expected and actual is recorded but never counts as verification", async () => {
  const { db } = await fresh();
  const recorded = await registry.recordIntegrationLiveEvidence(db, { ...GOOD_EVIDENCE, expectedResult: "call state completed", actualResult: "call state no_answer" }, OBSERVED + 1_000);
  assert.equal(recorded.matched, false);
  const stored = await registry.integrationLiveEvidence(db, "INT-VOICE-01");
  assert.equal(stored.length, 1, "a failed observation is still a real observation and is kept");
  assert.equal(stored[0].matched, false);
});

// ---------------------------------------------------------------------------
// controlled_live_verified cannot be reached without it
// ---------------------------------------------------------------------------
/** Everything the pre-existing gate requires, so the only thing left missing is the evidence row. */
async function makeOtherwiseComplete(db, code, evidenceReference) {
  const verified = Object.fromEntries(["authVerificationStatus", "webhookVerificationStatus", "idempotencyStatus", "replayStatus", "retryStatus", "deadLetterStatus", "timeoutStatus", "rateLimitStatus", "reconciliationStatus", "monitoringStatus", "auditLoggingStatus", "killSwitchStatus"].map(key => [key, "verified"]));
  await registry.updateIntegrationReadiness(db, {
    integrationCode: code, reason: "Preparing the controlled-live gate test",
    changes: { environment: "production", codeBoundaryStatus: "code_ready", credentialStatus: "configured", approvalReference: "APPROVAL-123", evidenceReference, ...verified },
    actorId: "ops@pawspace.in",
  });
}

test("controlled-live verification is refused when everything else is complete but no observation exists", async () => {
  const { sqlite, db } = await fresh();
  await makeOtherwiseComplete(db, "INT-VOICE-01", "verified in UAT");
  await assert.rejects(
    registry.updateIntegrationReadiness(db, { integrationCode: "INT-VOICE-01", reason: "Claiming controlled live", changes: { readinessState: "controlled_live_verified" }, actorId: "ops@pawspace.in" }),
    /a recorded live-evidence observation whose expected and actual result matched/);
  assert.notEqual(row(sqlite, "INT-VOICE-01").readiness_state, "controlled_live_verified");
  assert.equal(row(sqlite, "INT-VOICE-01").controlled_live_verified_at, null);
});

test("a mismatched observation does not unlock controlled live either", async () => {
  const { sqlite, db } = await fresh();
  await registry.recordIntegrationLiveEvidence(db, { ...GOOD_EVIDENCE, actualResult: "call state failed" }, OBSERVED + 1_000);
  await makeOtherwiseComplete(db, "INT-VOICE-01", "live-evidence:whatever");
  await assert.rejects(
    registry.updateIntegrationReadiness(db, { integrationCode: "INT-VOICE-01", reason: "Claiming controlled live", changes: { readinessState: "controlled_live_verified" }, actorId: "ops@pawspace.in" }),
    /expected and actual result matched/);
  assert.notEqual(row(sqlite, "INT-VOICE-01").readiness_state, "controlled_live_verified");
});

test("the evidence reference must name the observation, so the claim and the artefact cannot drift apart", async () => {
  const { db } = await fresh();
  const recorded = await registry.recordIntegrationLiveEvidence(db, GOOD_EVIDENCE, OBSERVED + 1_000);
  await makeOtherwiseComplete(db, "INT-VOICE-01", "live-evidence:INTEV-SOMETHINGELSE");
  await assert.rejects(
    registry.updateIntegrationReadiness(db, { integrationCode: "INT-VOICE-01", reason: "Claiming controlled live", changes: { readinessState: "controlled_live_verified" }, actorId: "ops@pawspace.in" }),
    new RegExp(`expected live-evidence:${recorded.id}`));
});

test("with a matched observation and a reference that names it, controlled live is granted and stamped", async () => {
  const { sqlite, db } = await fresh();
  const recorded = await registry.recordIntegrationLiveEvidence(db, GOOD_EVIDENCE, OBSERVED + 1_000);
  await makeOtherwiseComplete(db, "INT-VOICE-01", `live-evidence:${recorded.id}`);
  const after = await registry.updateIntegrationReadiness(db, { integrationCode: "INT-VOICE-01", reason: "Controlled live confirmed against recorded evidence", changes: { readinessState: "controlled_live_verified" }, actorId: "ops@pawspace.in" });

  assert.equal(after.readinessState, "controlled_live_verified");
  assert.ok(after.controlledLiveVerifiedAt > 0, "the grant is stamped");
  assert.equal(after.controlledLiveVerifiedBy, "ops@pawspace.in");
  // And the whole decision is reconstructable from the audit trail.
  const events = sqlite.prepare("SELECT event_type FROM integration_readiness_events ORDER BY created_at").all().map(event => event.event_type);
  assert.ok(events.includes("live_evidence_recorded"), events.join(", "));
  assert.ok(events.includes("readiness_updated"));
});

test("a rejected controlled-live attempt writes NOTHING - not the state, not the other columns, not an event", async () => {
  // The gate used to write first and roll back only readiness_state and the two verification stamps.
  // A rejected attempt that also set environment='production' and every evidence column left all of
  // those persisted, with no readiness_updated event describing them - so an operator saw a row that
  // had silently moved most of the way to "live" as the result of a call that reported failure.
  const { sqlite, db } = await fresh();
  const before = row(sqlite, "INT-COMMS-01");
  const eventsBefore = sqlite.prepare("SELECT COUNT(*) n FROM integration_readiness_events").get().n;

  await assert.rejects(registry.updateIntegrationReadiness(db, {
    integrationCode: "INT-COMMS-01", reason: "Claiming controlled live with everything but the evidence",
    changes: {
      readinessState: "controlled_live_verified", environment: "production", codeBoundaryStatus: "code_ready",
      credentialStatus: "configured", approvalReference: "APPROVAL-999", evidenceReference: "trust me",
      authVerificationStatus: "verified", webhookVerificationStatus: "verified", auditLoggingStatus: "verified",
      notes: "should not survive",
    },
    actorId: "ops@pawspace.in",
  }), /blocked until/);

  const after = row(sqlite, "INT-COMMS-01");
  for (const column of ["readiness_state", "environment", "code_boundary_status", "credential_status", "approval_reference", "evidence_reference", "auth_verification_status", "webhook_verification_status", "audit_logging_status", "notes", "updated_by", "updated_at"]) {
    assert.deepEqual(after[column], before[column], `${column} was changed by a rejected update`);
  }
  assert.equal(after.controlled_live_verified_at, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM integration_readiness_events").get().n, eventsBefore,
    "a rejected update must not leave an audit event either");
});

test("a rejected sandbox_verified attempt writes nothing either", async () => {
  const { sqlite, db } = await fresh();
  const before = row(sqlite, "INT-COMMS-01");
  await assert.rejects(registry.updateIntegrationReadiness(db, {
    integrationCode: "INT-COMMS-01", reason: "Sandbox verified with no evidence reference",
    changes: { readinessState: "sandbox_verified", notes: "should not survive" }, actorId: "ops@pawspace.in",
  }), /Sandbox verification requires an evidence reference/);
  assert.equal(row(sqlite, "INT-COMMS-01").readiness_state, before.readiness_state);
  assert.equal(row(sqlite, "INT-COMMS-01").notes, before.notes);
});

test("the registry row and both audit trails commit atomically", async () => {
  const { sqlite, db } = await fresh();
  const before = row(sqlite, "INT-COMMS-01");
  const originalPrepare = db.prepare;
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (!String(sql).startsWith("INSERT INTO security_audit_events")) return statement;
    return { bind: () => ({ run: async () => { throw new Error("injected security audit failure"); } }) };
  };

  await assert.rejects(registry.updateIntegrationReadiness(db, {
    integrationCode: "INT-COMMS-01", reason: "Atomic readiness update failure injection",
    changes: { notes: "must roll back" }, actorId: "ops@pawspace.in", actorRole: "operations",
  }), /injected security audit failure/);

  assert.equal(row(sqlite, "INT-COMMS-01").notes, before.notes, "the registry update committed without its audit");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM integration_readiness_events WHERE integration_code='INT-COMMS-01'").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='integration.readiness.update'").get().n, 0);
});

test("an accepted readiness update writes the registry event and security audit together", async () => {
  const { sqlite, db } = await fresh();
  await registry.updateIntegrationReadiness(db, {
    integrationCode: "INT-COMMS-01", reason: "Record an ordinary governed readiness note",
    changes: { notes: "reviewed by operations" }, actorId: "ops@pawspace.in", actorRole: "operations",
  });
  assert.equal(row(sqlite, "INT-COMMS-01").notes, "reviewed by operations");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM integration_readiness_events WHERE integration_code='INT-COMMS-01'").get().n, 1);
  const audit = sqlite.prepare("SELECT actor_email,actor_role,outcome FROM security_audit_events WHERE action='integration.readiness.update'").get();
  assert.deepEqual({ ...audit }, { actor_email: "ops@pawspace.in", actor_role: "operations", outcome: "completed" });
});

// ---------------------------------------------------------------------------
// Cross-lane evidence requests
// ---------------------------------------------------------------------------
test("a lane can file an evidence request before anyone has credentials, and it stays open", async () => {
  const { db } = await fresh();
  const filed = await registry.requestIntegrationEvidence(db, { integrationCode: "INT-VOICE-01", lane: "lane-2", scenario: "booking confirmation call reaches the customer", requirement: "One completed call with a provider call SID and a signed status callback", requestedBy: "lane2@pawspace.in" });
  assert.equal(filed.satisfied, false);
  const open = await registry.openIntegrationEvidenceRequests(db);
  assert.equal(open.length, 1);
  assert.equal(open[0].lane, "lane-2");
  assert.equal(open[0].readinessState, "sandbox_setup_required", "the request carries the current readiness so a reader sees why it is still open");
});

test("filing the same request twice does not reset the queue or double-count a blocker", async () => {
  const { db } = await fresh();
  const input = { integrationCode: "INT-VOICE-01", lane: "lane-2", scenario: "booking confirmation call reaches the customer", requirement: "One completed call with a provider call SID", requestedBy: "lane2@pawspace.in" };
  const first = await registry.requestIntegrationEvidence(db, input);
  const second = await registry.requestIntegrationEvidence(db, input);
  assert.equal(second.id, first.id);
  assert.equal((await registry.openIntegrationEvidenceRequests(db)).length, 1);
});

test("a matched observation closes the request for that scenario, and a mismatched one does not", async () => {
  const { db } = await fresh();
  const scenario = "outbound call reaches ringing then completed";
  await registry.requestIntegrationEvidence(db, { integrationCode: "INT-VOICE-01", lane: "lane-1", scenario, requirement: "A completed call observed against an exact SHA", requestedBy: "lane1@pawspace.in" });

  await registry.recordIntegrationLiveEvidence(db, { ...GOOD_EVIDENCE, scenario, actualResult: "call state busy" }, OBSERVED + 1_000);
  assert.equal((await registry.openIntegrationEvidenceRequests(db)).length, 1, "a mismatched observation does not satisfy a request");

  await registry.recordIntegrationLiveEvidence(db, { ...GOOD_EVIDENCE, scenario }, OBSERVED + 2_000);
  assert.deepEqual(await registry.openIntegrationEvidenceRequests(db), []);
});

test("an evidence request for an unknown integration or with no requirement is refused", async () => {
  const { db } = await fresh();
  await assert.rejects(registry.requestIntegrationEvidence(db, { integrationCode: "INT-NOPE", lane: "lane-1", scenario: "something", requirement: "a requirement", requestedBy: "x@pawspace.in" }), /Integration not found/);
  await assert.rejects(registry.requestIntegrationEvidence(db, { integrationCode: "INT-VOICE-01", lane: "", scenario: "something", requirement: "a real requirement", requestedBy: "x@pawspace.in" }), /needs a lane/);
  await assert.rejects(registry.requestIntegrationEvidence(db, { integrationCode: "INT-VOICE-01", lane: "lane-1", scenario: "ok scenario", requirement: "short", requestedBy: "x@pawspace.in" }), /needs a lane/);
});

// ---------------------------------------------------------------------------
// The registry never reports itself production-ready
// ---------------------------------------------------------------------------
test("the readiness summary reports zero controlled-live integrations on a cold database", async () => {
  const { db } = await fresh();
  const listed = await registry.listIntegrationReadiness(db, { PAWSPACE_AI_PROVIDER_API_KEY: "sk-test" });
  assert.equal(listed.summary.controlledLiveVerified, 0, "a configured credential produced a live-verified count");
  assert.equal(listed.productionReady, false);
  assert.ok(listed.summary.p0Required > 0);
  assert.equal(listed.summary.p0ControlledLive, 0);
});
