import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as nodeModule from "node:module";
import { assertWithinBudget, freshCountingD1 } from "./helpers/d1-harness.mjs";

// ---------------------------------------------------------------------------
// Every AI screen opened empty on staging. The engine was not broken — the assistant was switched
// off, and could not be switched on:
//
//   1. lib/pawspace-ai-seed.ts + POST /api/ai-bootstrap install the starter grounding (assistant
//      profile, system policy, approved knowledge, intent catalogue), but NOTHING in the product
//      called them. /team/ai/configuration only offered lifecycle buttons for versions that did not
//      exist, so a fresh environment could never create its first one and the page read
//      "No versions configured" permanently.
//   2. With no active knowledge, /chat public mode returned nothing: publicAiWebKnowledge selects
//      ai_knowledge_source_versions WHERE status='active'.
//   3. Nothing on any screen said WHY the assistant was silent — /team/ai printed
//      "Provider is not connected" as fixed boilerplate regardless of the actual state.
//
// These tests pin the fix by exercising the real code paths, not by reading copy.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl = ${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const configRoute = await import("../app/api/ai-business-configuration/route.ts");
const bootstrapRoute = await import("../app/api/ai-bootstrap/route.ts");
const adapter = await import("../lib/ai-provider-adapter.ts");
const configLib = await import("../lib/ai-business-configuration.ts");
const chatAdapter = await import("../lib/ai-web-chat-adapter.ts");

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const configPage = read("app/team/ai/configuration/page.tsx");
const teamAiPage = read("app/team/ai/page.tsx");

/** A completely empty database — exactly a freshly-deployed environment. */
function coldDb(env = {}) {
  const harness = freshCountingD1();
  globalThis.__PAWSPACE_TEST_ENV = { DB: harness.db, ...env };
  return harness;
}
const json = async (response) => {
  const payload = await response.clone().json();
  assert.ok(response.ok, `expected 2xx, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
};
const get = (url) => configRoute.GET(new Request(`http://localhost${url}`));

// ---------------------------------------------------------------------------
// 1. The zero-to-one defect.
// ---------------------------------------------------------------------------
test("cold environment: the AI configuration screen can install the first grounding itself", async () => {
  const { db } = coldDb();
  const before = await json(await get("/api/ai-business-configuration?mode=status"));
  assert.equal(before.data.configurationRequired, true, "a fresh environment starts with no active profile or policy");
  assert.equal(before.data.activeKnowledge, 0);
  assert.equal(before.data.activeIntents, 0);

  // The screen must actually reach the bootstrap endpoint — this is the wiring that was missing.
  assert.match(configPage, /fetch\("\/api\/ai-bootstrap",\s*\{\s*method:"POST"/, "the configuration page must call POST /api/ai-bootstrap");
  assert.match(configPage, /Install starter assistant grounding/);

  const created = await json(await bootstrapRoute.POST(new Request("http://localhost/api/ai-bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })));
  assert.ok(created.data.knowledgeCount >= 10, "the starter knowledge base is installed");
  assert.ok(created.data.intentCount >= 5, "the starter intent catalogue is installed");

  const after = await json(await get("/api/ai-business-configuration?mode=status"));
  assert.equal(after.data.configurationRequired, false, "the profile and system policy are now active");
  assert.equal(after.data.activeProfile.key, "pawspace_default");
  assert.ok(after.data.activeKnowledge >= 10);
  assert.ok(after.data.activeIntents >= 5);

  // Activation went through the real lifecycle, so each version carries a genuine digest and an audit trail.
  const snapshot = await configLib.aiBusinessConfigurationSnapshot(db);
  for (const row of [...snapshot.profiles, ...snapshot.prompts, ...snapshot.knowledge, ...snapshot.intents]) {
    assert.equal(String(row.status), "active");
    assert.match(String(row.immutable_hash), /^[0-9a-f]{64}$/, "immutable_hash is a real SHA-256, not a placeholder");
    assert.ok(String(row.approved_by).length > 0, "an approver is recorded");
  }
  assert.ok(snapshot.auditEvents.length >= 4 * (1 + 1 + 10 + 5) / 4, "the lifecycle wrote audit events");
});

test("cold environment: /chat public mode is empty until the grounding exists, and answers after", async () => {
  const { db } = coldDb();
  const before = await chatAdapter.publicAiWebKnowledge(db, { query: "boarding" });
  assert.equal(before.knowledge.length, 0, "with no active knowledge there is nothing public chat can say");

  await bootstrapRoute.POST(new Request("http://localhost/api/ai-bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  const after = await chatAdapter.publicAiWebKnowledge(db, { query: "boarding" });
  assert.ok(after.knowledge.length >= 1, "public chat now answers from approved knowledge");
  assert.equal(after.customerDataAccess, false, "public mode still never touches customer data");
  assert.equal(after.toolExecution, false);
  assert.ok(after.knowledge.every((item) => /^[0-9a-f]{64}$/.test(item.immutableHash)), "each public answer cites the approved version it came from");
});

// ---------------------------------------------------------------------------
// 2. Honest state: the screen must report the real reason the assistant is silent.
// ---------------------------------------------------------------------------
test("provider connection is reported from configuration, not asserted as boilerplate", async () => {
  coldDb();
  const disconnected = await adapter.aiProviderConnection();
  assert.equal(disconnected.connected, false);
  assert.match(disconnected.reason, /PAWSPACE_AI_PROVIDER_API_KEY/);

  coldDb({ PAWSPACE_AI_PROVIDER_API_KEY: "sk-test-not-a-real-key" });
  const connected = await adapter.aiProviderConnection();
  assert.equal(connected.connected, true, "a configured key must be reported as connected");
  assert.equal(connected.providerRef, "anthropic");
  assert.ok(!JSON.stringify(connected).includes("sk-test-not-a-real-key"), "the key itself is never returned");

  // The team AI page must no longer state the provider is disconnected as a fixed fact.
  assert.doesNotMatch(teamAiPage, /Provider is not connected/, "that sentence stayed on screen even once a key was configured");
});

test("status reports all four requirements, and any one of them switches the assistant off", async () => {
  const { db } = coldDb({ PAWSPACE_AI_PROVIDER_API_KEY: "sk-test-not-a-real-key" });
  const rollout = await import("../lib/ai-audience-rollout.ts");
  await bootstrapRoute.POST(new Request("http://localhost/api/ai-bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));

  // Grounding + provider are in place, but the rollout is still 'off'.
  let status = (await json(await get("/api/ai-business-configuration?mode=status"))).data;
  assert.equal(status.rollout.stage, "off");
  assert.equal(status.answersStaff, false, "rollout 'off' alone keeps the assistant silent");
  assert.equal(status.answersCustomers, false);

  await rollout.setAiRolloutStage(db, { stage: "staff_only", reason: "test", actorEmail: "staff@test" });
  status = (await json(await get("/api/ai-business-configuration?mode=status"))).data;
  assert.equal(status.answersStaff, true, "provider + grounding + staff rollout + no kill switch = on for staff");
  assert.equal(status.answersCustomers, false, "staff_only never implies customers");

  // A kill switch overrides everything else, which is the whole point of it.
  await configLib.setAiKillSwitch(db, { scopeType: "global", scopeKey: "ai", disabled: true, reason: "safety stop under test", actorEmail: "staff@test" });
  status = (await json(await get("/api/ai-business-configuration?mode=status"))).data;
  assert.equal(status.answersStaff, false, "a global kill switch switches the assistant off regardless of the rest");
  assert.equal(status.killSwitches.length, 1);
  assert.match(status.killSwitches[0].reason, /safety stop under test/);
});

test("the status read is a read: it never activates, disables or drafts anything", async () => {
  const { db } = coldDb();
  await bootstrapRoute.POST(new Request("http://localhost/api/ai-bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  const before = await configLib.aiBusinessConfigurationSnapshot(db);
  await get("/api/ai-business-configuration?mode=status");
  await get("/api/ai-business-configuration?mode=status");
  const after = await configLib.aiBusinessConfigurationSnapshot(db);
  assert.equal(after.profiles.length, before.profiles.length, "reading status must not create versions");
  assert.equal(after.killSwitches.length, before.killSwitches.length);
  assert.equal(after.auditEvents.length, before.auditEvents.length, "reading status must not write audit events");
});

// ---------------------------------------------------------------------------
// 3. Re-running the bootstrap supersedes rather than corrupting.
// ---------------------------------------------------------------------------
test("reinstalling the grounding supersedes v1 instead of leaving two active profiles", async () => {
  const { db } = coldDb();
  const call = () => bootstrapRoute.POST(new Request("http://localhost/api/ai-bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  await call();
  await call();
  const snapshot = await configLib.aiBusinessConfigurationSnapshot(db);
  const profiles = snapshot.profiles.filter((row) => String(row.profile_key) === "pawspace_default");
  assert.equal(profiles.length, 2, "both versions are kept — configuration is versioned, never edited in place");
  assert.equal(profiles.filter((row) => String(row.status) === "active").length, 1, "exactly one version is active");
  assert.equal(profiles.filter((row) => String(row.status) === "retired").length, 1, "the previous version is retired, not deleted");
  const active = await configLib.resolveActiveAiBusinessConfig(db, { channel: "chat", intent: "service_info" });
  assert.equal(active.profile.version, 2, "the newest version wins");
});


// ---------------------------------------------------------------------------
// 4. Budget: the status read must not carry configuration history it does not use.
//
// A note on which guard catches this, because the first version of this test was wrong.
//
// The shared harness models two D1 limits: the bind cap (one over-wide statement) and the call
// budget (many individually-legal statements — this is what catches N+1). Neither catches this
// defect. The status handler called aiBusinessConfigurationSnapshot, which is a FIXED six queries
// whether there are ten configuration versions or a thousand; the call count never moved. The waste
// was in ROWS: up to 100 profiles + 200 intents + 200 knowledge + 100 prompt policies + 200 audit
// events transferred to compute two integers.
//
// So this adds a third meter — rows returned — over the shared harness rather than beside it. It is
// the guard that discriminates here, and it is worth proposing for tests/helpers/d1-harness.mjs.
// ---------------------------------------------------------------------------

/** Wraps a counting harness to also tally rows returned, the cost a call budget cannot see. */
function withRowMeter(harness) {
  let rows = 0;
  const inner = harness.db.prepare.bind(harness.db);
  harness.db.prepare = (sql) => {
    const wrap = (statement) => ({
      ...statement,
      bind: (...args) => wrap(statement.bind(...args)),
      first: async () => { const row = await statement.first(); if (row) rows += 1; return row; },
      all: async () => { const result = await statement.all(); rows += result.results.length; return result; },
    });
    return wrap(inner(sql));
  };
  return { rows: () => rows, resetRows: () => { rows = 0; } };
}

test("the status read does not carry configuration history it never uses", async () => {
  const harness = coldDb();
  const meter = withRowMeter(harness);
  const bootstrap = () => bootstrapRoute.POST(new Request("http://localhost/api/ai-bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  await bootstrap();

  meter.resetRows();
  await assertWithinBudget(harness, { max: 20, label: "status read on a fresh install" }, () => get("/api/ai-business-configuration?mode=status"));
  const freshRows = meter.rows();

  // Nine more bootstraps: ~10 profiles, ~50 intents, ~100 knowledge versions and their audit trail.
  for (let round = 0; round < 9; round += 1) await bootstrap();
  const versions = await configLib.aiBusinessConfigurationSnapshot(globalThis.__PAWSPACE_TEST_ENV.DB);
  assert.ok(versions.knowledge.length >= 100, "the history really did grow");

  meter.resetRows();
  await assertWithinBudget(harness, { max: 20, label: "status read against 100+ versions" }, () => get("/api/ai-business-configuration?mode=status"));
  const grownRows = meter.rows();

  // The property: reading status must cost the same after a hundred versions as after ten.
  assert.equal(grownRows, freshRows, `status transferred ${grownRows} rows against 100+ versions vs ${freshRows} against 10 — it must not scale with history`);
  assert.ok(freshRows < 40, `status should read a handful of rows, not the whole configuration history (got ${freshRows})`);
});
