import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

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

// Local stand-in for the shared harness the other branch is landing at tests/helpers/d1-harness.mjs
// ("test the budget, not the shape"). Counts statements and enforces D1's 100-parameter bind cap, so
// an N+1 or an over-wide IN () fails here rather than in production. Swap for the shared harness once
// it is on main.
const meter = { calls: 0, reset() { this.calls = 0; } };

function count(sql, args) {
  meter.calls += 1;
  if (args.length > 100) throw new Error(`D1 allows at most 100 bind parameters; this statement used ${args.length}: ${sql.slice(0, 120)}`);
}

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { count(sql, args); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { count(sql, args); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => { count(sql, args); return { results: sqlite.prepare(sql).all(...args) }; },
  });
  return {
    prepare: (sql) => statement(sql, []),
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
  };
}

/** A completely empty database — exactly a freshly-deployed environment. */
function coldDb(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db, ...env };
  return { sqlite, db };
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
// 4. Budget: the status read must not grow with configuration history.
// ---------------------------------------------------------------------------
test("the status read costs the same whether there is one config version or fifty", async () => {
  coldDb();
  const bootstrap = () => bootstrapRoute.POST(new Request("http://localhost/api/ai-bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  await bootstrap();

  meter.reset();
  await get("/api/ai-business-configuration?mode=status");
  const small = meter.calls;

  // Nine more bootstraps: ~10 profiles, ~50 intents, ~100 knowledge versions and their audit trail.
  for (let round = 0; round < 9; round += 1) await bootstrap();
  const versions = await configLib.aiBusinessConfigurationSnapshot(globalThis.__PAWSPACE_TEST_ENV.DB);
  assert.ok(versions.knowledge.length >= 100, "the history really did grow");

  meter.reset();
  await get("/api/ai-business-configuration?mode=status");
  const large = meter.calls;

  // This is the point of the test: not "how many queries" but "does it scale". The handler used to
  // call aiBusinessConfigurationSnapshot and pull every version row to count two integers.
  assert.equal(large, small, `status issued ${large} statements against 100+ versions vs ${small} against 10 — it must be constant`);
  assert.ok(small <= 20, `status should be a bounded read, got ${small} statements`);
});
