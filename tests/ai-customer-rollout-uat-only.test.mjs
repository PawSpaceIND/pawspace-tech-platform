/**
 * Owner decision 2026-09-22 (decision 3 of 10) — the customer AI rollout is UAT-only.
 *
 * Staging could not exercise the customer assistant at all: the rollout stage sat at 'off', and widening
 * it is a settings.manage action on /team/ai/rollout that no UAT persona holds, so every tester reached
 * a human handoff and the customer AI path was untestable. Opening it needed the stage to stop being a
 * standing permission first — a row saying 'customers' must not mean "answer customers" wherever that
 * database is later restored, copied or promoted.
 *
 * So the stage is now read together with the deployment, and the check FAILS CLOSED: a deployment that
 * does not say what it is does not open the AI to customers. These tests drive the real gate against a
 * real database at each deployment label rather than reading the source for the expression.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__ROLLOUT_UAT_DB__", "__ROLLOUT_UAT_ENV__");

const rollout = await import("../lib/ai-audience-rollout.ts");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}

/** A database at `stage`, read on a deployment labelled `deployment` (undefined = never labelled). */
async function at(stage, deployment) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__ROLLOUT_UAT_DB__ = db;
  globalThis.__ROLLOUT_UAT_ENV__ = deployment === undefined ? {} : { PAWSPACE_DEPLOYMENT_ENV: deployment };
  await rollout.setAiRolloutStage(db, { stage, reason: "rollout gate proof", actorEmail: "founder@pawspace.in" });
  return { db, sqlite };
}

test("a UAT deployment answers customers when the stage says customers", async () => {
  for (const deployment of rollout.CUSTOMER_AI_UAT_ENVIRONMENTS) {
    const { db } = await at("customers", deployment);
    const gate = await rollout.resolveAiAudienceGate(db, { audience: "customer" });
    assert.equal(gate.allowed, true, `${deployment} is a UAT deployment, so the owner's rollout applies there`);
    assert.equal(gate.effectiveStage, "customers");
  }
});

test("the same database does not answer customers off a UAT deployment", async () => {
  // The stage is not a standing permission: this is the same row, read somewhere else.
  for (const deployment of ["production", "prod", "PRODUCTION", "", "something-nobody-configured"]) {
    const { db } = await at("customers", deployment);
    const gate = await rollout.resolveAiAudienceGate(db, { audience: "customer" });
    assert.equal(gate.allowed, false, `a '${deployment}' deployment must not open the AI to customers`);
    assert.equal(gate.stage, "customers", "the configured stage is still reported honestly");
    assert.equal(gate.effectiveStage, "staff_only", "what applies here is reported separately from what is configured");
    assert.match(gate.reason, /UAT/, "the customer must be given the real reason, not a generic 'rollout is off'");
  }
});

test("an unlabelled deployment fails closed", async () => {
  const { db } = await at("customers", undefined);
  const gate = await rollout.resolveAiAudienceGate(db, { audience: "customer" });
  assert.equal(gate.allowed, false, "an environment that does not say what it is does not get to open the AI to customers");
});

test("staff are unaffected: 'staff_only' means the same thing on every deployment", async () => {
  for (const deployment of ["production", "staging", ""]) {
    const { db } = await at("staff_only", deployment);
    assert.equal((await rollout.resolveAiAudienceGate(db, { audience: "staff" })).allowed, true, `staff keep the assisted preview on '${deployment}'`);
    assert.equal((await rollout.resolveAiAudienceGate(db, { audience: "customer" })).allowed, false);
  }
});

test("'off' still means nobody, on a UAT deployment too", async () => {
  const { db } = await at("off", "staging");
  assert.equal((await rollout.resolveAiAudienceGate(db, { audience: "staff" })).allowed, false);
  assert.equal((await rollout.resolveAiAudienceGate(db, { audience: "customer" })).allowed, false);
});

test("the rollout snapshot reports whether customers are actually being answered, not what the row says", async () => {
  // An operator reading 'customersEnabled: true' on a deployment where every customer reaches a human
  // would have had no way to tell the difference. The stage is still reported, beside it.
  const gated = await at("customers", "production");
  const gatedSnapshot = await rollout.aiRolloutSnapshot(gated.db);
  assert.equal(gatedSnapshot.stage, "customers");
  assert.equal(gatedSnapshot.customersEnabled, false, "customers are not being answered here, whatever the row says");
  assert.equal(gatedSnapshot.customerRolloutApprovedHere, false);
  assert.equal(gatedSnapshot.customerRolloutUatOnly, true);

  const live = await at("customers", "staging");
  const liveSnapshot = await rollout.aiRolloutSnapshot(live.db);
  assert.equal(liveSnapshot.customersEnabled, true);
  assert.equal(liveSnapshot.customerRolloutApprovedHere, true);
});

test("the staging seed opens the rollout to customers, and repairs a seeded row upward without overruling a person", async () => {
  const { readFile } = await import("node:fs/promises");
  const seed = await readFile(new URL("../scripts/uat-staging-provider-capacity.sql", import.meta.url), "utf8");
  const statements = seed.split(";\n").map((line) => line.trim()).filter((line) => /ai_audience_rollout/.test(line));
  assert.ok(statements.length >= 3, "the seed must create the table, insert the row, and repair an existing one");

  // Run the seed's own statements against three staging databases: never seeded, seeded at 'off' by an
  // earlier seed, and set to 'off' by a person. INSERT OR IGNORE alone would fix only the first.
  const run = (existing) => {
    const sqlite = new DatabaseSync(":memory:");
    for (const statement of statements) {
      sqlite.exec(`${statement};`);
      if (existing && /CREATE TABLE/.test(statement)) sqlite.prepare("INSERT INTO ai_audience_rollout (id,stage,reason,updated_by,updated_at) VALUES (1,?,'earlier state',?,1)").run(existing.stage, existing.updatedBy);
    }
    return sqlite.prepare("SELECT stage,updated_by FROM ai_audience_rollout WHERE id=1").get();
  };

  assert.equal(run(null).stage, "customers", "a staging database that never had the row gets it");
  assert.equal(run({ stage: "off", updatedBy: "founder_seed" }).stage, "customers", "a row an earlier seed left at 'off' is repaired upward");
  assert.equal(run({ stage: "staff_only", updatedBy: "uat_staging_seed" }).stage, "customers", "and one left at 'staff_only' too");

  const humanChoice = run({ stage: "off", updatedBy: "ops.manager@pawspace.in" });
  assert.equal(humanChoice.stage, "off", "a stage a person set on /team/ai/rollout is theirs; a seed must not overrule it");
  assert.equal(humanChoice.updated_by, "ops.manager@pawspace.in");
});
