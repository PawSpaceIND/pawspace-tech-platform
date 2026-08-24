/**
 * Lane 2 -> Lane 4 readiness handoff, executed.
 *
 * PR #305 closed Lane 2's ENGINEERING scope and left six OPERATIONAL prerequisites that no amount of
 * code can satisfy: Google Routes credentials, IDfy UAT access, private object storage, malware
 * scanning, and Android and iOS physical-device validation. This suite proves the canonical registry
 * represents all six, that each is visibly blocked, and - the part that actually matters - that none of
 * them can be reported ready while the real dependency is absent.
 *
 * Two genuine gaps were found by running the registry rather than reading it, and both are fixed here:
 *
 *   1. The `idfy` detector checked IDFY_API_KEY + IDFY_ACCOUNT_ID + IDFY_URL and not
 *      IDFY_WEBHOOK_SECRET. Measured: with the three submission credentials set and the secret absent,
 *      credential_status read "configured" - while lib/idfy-callback-boundary.ts refuses EVERY callback
 *      with 503. IDfy verification is asynchronous, so submission credentials alone can never settle a
 *      check; it can only ever reach `manual_review`. The control plane was reporting a connected
 *      channel whose answering half was switched off.
 *
 *   2. Android and iOS physical-device certification had NO representation at all - zero rows. The one
 *      device-adjacent row, INT-GPS-01, is about whether a location event can be trusted once it
 *      arrives, not about whether the journey producing it has ever run on real hardware.
 *
 * ENGINEERING READINESS AND OPERATIONAL READINESS ARE DIFFERENT AXES and this file keeps them apart.
 * INT-KYC-01's code boundary moved to `code_ready` because Lane 2 implemented and executed the callback
 * boundary; its readiness_state stays `production_setup_required` because no IDfy account has ever been
 * reached. Neither fact is allowed to move the other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__HANDOFF_DB__");

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

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__HANDOFF_DB__ = db;
  await registry.ensureIntegrationReadinessTables(db);
  const items = async () => (await registry.listIntegrationReadiness(db)).items;
  const row = async (code) => (await items()).find((item) => item.integrationCode === code);
  return { sqlite, db, items, row };
}

/** The six operational prerequisites PR #305 handed over, and the registry row that owns each. */
const LANE2_PREREQUISITES = [
  ["Google Routes credentials/configuration", "INT-MAPS-01"],
  ["IDfy UAT / provider access", "INT-KYC-01"],
  ["private object-storage configuration", "INT-MEDIA-01"],
  ["malware-scanning capability/provider", "INT-MEDIA-02"],
  ["Android physical-device validation", "INT-DEVICE-01"],
  ["iOS physical-device validation", "INT-DEVICE-02"],
];

/** States that would let a reader believe an external dependency has actually been exercised. */
const READY_STATES = ["sandbox_verified", "controlled_live_verified", "not_applicable"];

// --- every prerequisite is represented, and none of them reads as satisfied ---------------------------

test("all six Lane 2 operational prerequisites are represented canonically", async () => {
  const { row } = await world();
  for (const [prerequisite, code] of LANE2_PREREQUISITES) {
    const item = await row(code);
    assert.ok(item, `${prerequisite} has no canonical registry row (${code})`);
    assert.ok(item.required, `${code} must be a required integration`);
  }
});

test("not one of them is in a state that implies the dependency exists", async () => {
  const { row } = await world();
  for (const [prerequisite, code] of LANE2_PREREQUISITES) {
    const item = await row(code);
    assert.ok(!READY_STATES.includes(item.readinessState),
      `${prerequisite} (${code}) reads ${item.readinessState}, which a reader would take as exercised`);
  }
});

test("the two device prerequisites are not_started, because no device journey has ever run", async () => {
  // `production_setup_required` would overstate it: that implies the sandbox rung has been climbed.
  // Nothing has been executed on any handset, so the honest state is the first one.
  const { row } = await world();
  for (const code of ["INT-DEVICE-01", "INT-DEVICE-02"]) {
    const item = await row(code);
    assert.equal(item.readinessState, "not_started", code);
    assert.equal(item.environment, "none", `${code} must not claim an environment it has never run in`);
    assert.match(item.notes, /never been executed on a physical/i);
  }
});

test("device certification is a separate dependency from the location integration", async () => {
  // INT-GPS-01 answers "can this location event be trusted once it arrives". The device rows answer
  // "has the journey that produces it ever run on hardware". Collapsing them would let a green GPS row
  // imply device coverage that does not exist.
  const { row } = await world();
  const gps = await row("INT-GPS-01"), android = await row("INT-DEVICE-01");
  assert.notEqual(gps.integrationCode, android.integrationCode);
  assert.equal(android.category, "device");
  assert.notEqual(gps.category, "device");
});

// --- none of them can be reported ready without the real dependency -----------------------------------

test("no Lane 2 prerequisite can be moved to controlled-live without a matched observation", async () => {
  // The single most important property of the handoff: a row cannot be talked into being live.
  const { db, row } = await world();
  for (const [prerequisite, code] of LANE2_PREREQUISITES) {
    await assert.rejects(
      () => registry.updateIntegrationReadiness(db, {
        integrationCode: code,
        actorId: "ops@pawspace.in",
        actorRole: "founder_admin",
        reason: "attempting to declare this live with nothing behind it",
        changes: { readinessState: "controlled_live_verified", evidenceReference: "verified in UAT" },
      }),
      /Controlled-live verification is blocked until/,
      `${prerequisite} (${code}) could be declared live with prose as evidence`);
    const after = await row(code);
    assert.ok(!READY_STATES.includes(after.readinessState), `${code} must be unchanged after a refused attempt`);
    assert.equal(after.controlledLiveVerifiedAt ?? null, null, `${code} must carry no verification timestamp`);
  }
});

test("credential presence alone moves nothing but credential status", async () => {
  // A key in the environment is configuration. It is not traffic, and it is not evidence.
  const { db, row } = await world();
  const before = await row("INT-MAPS-01");
  await registry.syncIntegrationCredentialPresence(db, { GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-key-placeholder" });
  const after = await row("INT-MAPS-01");
  assert.equal(after.credentialStatus, "configured", "the key is present, so the configuration column moves");
  assert.equal(after.readinessState, before.readinessState, "readiness must not move");
  assert.equal(after.lastVerifiedAt ?? null, before.lastVerifiedAt ?? null, "nothing was verified");
  assert.equal(after.controlledLiveVerifiedAt ?? null, null);
});

// --- GAP A: the IDfy callback secret ------------------------------------------------------------------

test("DEFECT: submission credentials without IDFY_WEBHOOK_SECRET are not a configured IDfy", async () => {
  // Measured before the fix: this exact environment reported credential_status "configured", while
  // applyIdfyCallback refuses every delivery with 503 because the secret is absent. Submission alone
  // can only ever leave a check at manual_review - the outcome arrives on the callback.
  const { db, row } = await world();
  await registry.syncIntegrationCredentialPresence(db, {
    IDFY_API_KEY: "k", IDFY_ACCOUNT_ID: "a", IDFY_URL: "https://eve.idfy.com/v3/tasks",
  });
  assert.equal((await row("INT-KYC-01")).credentialStatus, "missing",
    "IDfy without its callback secret is not configured - the half that carries the answer is off");
});

test("IDfy reads configured only when every credential including the callback secret is present", async () => {
  // Non-vacuity: the detector must still be able to say yes.
  const { db, row } = await world();
  await registry.syncIntegrationCredentialPresence(db, {
    IDFY_API_KEY: "k", IDFY_ACCOUNT_ID: "a", IDFY_URL: "https://eve.idfy.com/v3/tasks", IDFY_WEBHOOK_SECRET: "s",
  });
  assert.equal((await row("INT-KYC-01")).credentialStatus, "configured");
});

test("each IDfy credential is individually load-bearing", async () => {
  const full = { IDFY_API_KEY: "k", IDFY_ACCOUNT_ID: "a", IDFY_URL: "https://eve.idfy.com/v3/tasks", IDFY_WEBHOOK_SECRET: "s" };
  for (const omitted of Object.keys(full)) {
    const { db, row } = await world();
    const partial = { ...full };
    delete partial[omitted];
    await registry.syncIntegrationCredentialPresence(db, partial);
    assert.equal((await row("INT-KYC-01")).credentialStatus, "missing", `omitting ${omitted} must not read as configured`);
  }
});

test("a fully credentialed IDfy is still not a verified one", async () => {
  // The whole point of keeping engineering and operational readiness apart. Even with all four secrets,
  // nothing has been sent to IDfy and nothing has come back.
  const { db, row } = await world();
  await registry.syncIntegrationCredentialPresence(db, {
    IDFY_API_KEY: "k", IDFY_ACCOUNT_ID: "a", IDFY_URL: "https://eve.idfy.com/v3/tasks", IDFY_WEBHOOK_SECRET: "s",
  });
  const item = await row("INT-KYC-01");
  assert.equal(item.credentialStatus, "configured");
  assert.equal(item.readinessState, "production_setup_required");
  assert.equal(item.controlledLiveVerifiedAt ?? null, null);
});

// --- engineering readiness moved; operational readiness did not ---------------------------------------

test("INT-KYC-01 records the merged callback boundary without upgrading its readiness", async () => {
  const { row } = await world();
  const item = await row("INT-KYC-01");
  assert.equal(item.codeBoundaryStatus, "code_ready",
    "the callback boundary is implemented and executed, so the CODE boundary moved");
  assert.equal(item.readinessState, "production_setup_required",
    "no IDfy account has been reached, so OPERATIONAL readiness must not move");
  assert.doesNotMatch(item.notes, /are not implemented or verified/,
    "the note must not still claim the callback boundary is missing");
  assert.match(item.notes, /No IDfy account has ever been reached/i,
    "and it must still say plainly that nothing external has been exercised");
});

test("the device rows keep a partial code boundary rather than claiming none", async () => {
  // Lane 2 proved the server-side halves. Saying `not_started` would understate the code and let a
  // reader think engineering work is outstanding when the blocker is hardware.
  const { row } = await world();
  for (const code of ["INT-DEVICE-01", "INT-DEVICE-02"]) {
    const item = await row(code);
    assert.equal(item.codeBoundaryStatus, "partial", code);
    assert.match(item.notes, /Server-side halves are executable and proven/i, code);
  }
});

// --- the launch-blocker view surfaces them ------------------------------------------------------------

test("the P0 Lane 2 prerequisite appears as an open launch blocker", async () => {
  // integrationLaunchBlockers is deliberately P0-only - it answers "what stops launch", not "what is
  // outstanding". Of the six, only IDfy is P0. Asserting all six here would be asserting a contract the
  // view never had; the P1 rows are covered by the next test instead.
  const { db } = await world();
  const blockers = await registry.integrationLaunchBlockers(db);
  assert.match(JSON.stringify(blockers), /INT-KYC-01/, "the P0 KYC prerequisite must be an open launch blocker");
});

test("no Lane 2 prerequisite is invisible - each is listed, and each states why it is blocked", async () => {
  // A dependency that is blocked but unlisted is no better than one reported ready. P1 rows do not
  // stop launch, but they must still be readable with a state and a reason.
  const { items } = await (async () => { const w = await world(); return { items: await w.items() }; })();
  for (const [prerequisite, code] of LANE2_PREREQUISITES) {
    const item = items.find((entry) => entry.integrationCode === code);
    assert.ok(item, `${prerequisite} (${code}) is absent from the readiness listing`);
    assert.ok(!READY_STATES.includes(item.readinessState), `${code} must read as outstanding`);
    assert.ok(String(item.notes || "").trim().length > 0, `${code} must say what is missing`);
  }
});

test("no Lane 2 prerequisite counts toward controlled-live readiness", async () => {
  const { db } = await world();
  const { summary, items } = await registry.listIntegrationReadiness(db);
  assert.equal(summary.p0ControlledLive, 0, "no P0 integration has been live-verified anywhere in the platform");
  const live = items.filter((item) => item.readinessState === "controlled_live_verified");
  assert.deepEqual(live, [], "nothing in the registry may claim controlled-live verification");
});
