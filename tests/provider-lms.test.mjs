import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// Test-only resolve hooks: "cloudflare:workers" resolves to a stub whose env.DB is the current
// per-test SQLite-backed D1 shim, so the REAL route and lib execute unmodified.
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__LMS_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

let sqlite;
function freshDb() { sqlite = new DatabaseSync(":memory:"); globalThis.__LMS_DB__ = makeD1(sqlite); }

const route = await import("../app/api/provider-lms/route.ts");
const { saveLmsModule, setLmsModuleStatus, submitLmsCompletion, providerTrainingReadiness, lmsOverview } = await import("../lib/provider-lms.ts");

async function parseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}
const call = async (method, bodyOrQuery, headers = {}) => {
  const url = `http://localhost/api/provider-lms${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const request = method === "GET"
    ? new Request(url, { headers })
    : new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(bodyOrQuery) });
  const response = await (method === "GET" ? route.GET(request) : route.POST(request));
  return { status: response.status, body: await parseBody(response) };
};
// Non-preview provider identity: role service_provider (bookings.view, no manage overrides).
const callAs = async (method, bodyOrQuery, email) => {
  const url = `https://app.pawspace.test/api/provider-lms${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const headers = { "content-type": "application/json", "oai-authenticated-user-email": email };
  const request = method === "GET" ? new Request(url, { headers }) : new Request(url, { method, headers, body: JSON.stringify(bodyOrQuery) });
  const response = await (method === "GET" ? route.GET(request) : route.POST(request));
  return { status: response.status, body: await parseBody(response) };
};

const NOW = Date.now();
// Exact DDL copied verbatim from the owning sources: provider_capacity_profiles columns from
// lib/provider-capacity-governance.ts (only the columns this module reads), identity tables from
// lib/server-auth.ts.
function seedProviderProfilesTable() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL DEFAULT '[]',provider_model TEXT NOT NULL DEFAULT 'commission',rating REAL NOT NULL DEFAULT 0,quality_score REAL NOT NULL DEFAULT 0,travel_buffer_minutes INTEGER NOT NULL DEFAULT 30,max_daily_jobs INTEGER NOT NULL DEFAULT 6,live INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active',updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,services_json,updated_at) VALUES ('prov_groomer','blr','Kiran S','[\"grooming\"]',?)").run(NOW);
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,services_json,updated_at) VALUES ('prov_walker','blr','Anu R','[\"dog_walking\"]',?)").run(NOW);
}
function seedProviderIdentity(email, providerId) {
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`usr-${email}`, email, email.split("@")[0], "service_provider", NOW, NOW);
  sqlite.prepare("INSERT INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, providerId, NOW, NOW);
}

const QUIZ = [
  { question: "How long is the safety check before every grooming session?", options: ["Skip it", "Five minutes minimum"], answerIndex: 1 },
  { question: "What do you do if a pet shows stress signals?", options: ["Continue anyway", "Pause and reassure, escalate if needed"], answerIndex: 1 },
];
async function publishedModule(db, overrides = {}) {
  const saved = await saveLmsModule(db, { title: "Grooming safety SOP", serviceCode: "grooming", summary: "Safety fundamentals for every session", sections: ["Check equipment", "Confirm pet comfort"], quiz: QUIZ, passPct: 100, actorId: "staff:uat", ...overrides });
  await setLmsModuleStatus(db, { moduleId: saved.moduleId, status: "published", actorId: "staff:uat" });
  return saved;
}

// ---- 1. Authoring governance -----------------------------------------------------------------------

test("real execution: module authoring validates content, quiz shape and pass mark; publish/archive are governed", async () => {
  freshDb();
  const db = globalThis.__LMS_DB__;
  await assert.rejects(saveLmsModule(db, { title: "X", serviceCode: "grooming", summary: "s", sections: [], quiz: QUIZ, actorId: "a" }), (e) => e instanceof Response && e.status === 400, "title/summary/sections are required");
  await assert.rejects(saveLmsModule(db, { title: "Valid title", serviceCode: "not-a-service", summary: "Valid summary", sections: ["A"], quiz: QUIZ, actorId: "a" }), (e) => e instanceof Response && e.status === 400);
  await assert.rejects(saveLmsModule(db, { title: "Valid title", serviceCode: "grooming", summary: "Valid summary", sections: ["A"], quiz: [{ question: "Only one option?", options: ["yes"], answerIndex: 0 }], actorId: "a" }), (e) => e instanceof Response && e.status === 400, "a quiz question needs two options");
  await assert.rejects(saveLmsModule(db, { title: "Valid title", serviceCode: "grooming", summary: "Valid summary", sections: ["A"], quiz: [{ question: "Bad answer index?", options: ["a", "b"], answerIndex: 5 }], actorId: "a" }), (e) => e instanceof Response && e.status === 400);
  const saved = await saveLmsModule(db, { title: "Grooming safety SOP", serviceCode: "grooming", summary: "Safety fundamentals", sections: ["Check equipment"], quiz: QUIZ, passPct: 100, actorId: "staff:uat" });
  assert.equal(saved.status, "draft");
  assert.equal(saved.version, 1);
  // Draft cannot be completed
  await assert.rejects(submitLmsCompletion(db, { moduleId: saved.moduleId, providerId: "prov_groomer", answers: [1, 1], idempotencyKey: "draft-try", actorId: "p" }), (e) => e instanceof Response && e.status === 409);
  await setLmsModuleStatus(db, { moduleId: saved.moduleId, status: "published", actorId: "staff:uat" });
  const republish = await setLmsModuleStatus(db, { moduleId: saved.moduleId, status: "published", actorId: "staff:uat" });
  assert.equal(republish.duplicatePrevented, true);
  await setLmsModuleStatus(db, { moduleId: saved.moduleId, status: "archived", actorId: "staff:uat" });
  await assert.rejects(setLmsModuleStatus(db, { moduleId: saved.moduleId, status: "published", actorId: "staff:uat" }), (e) => e instanceof Response && e.status === 409, "archived modules never come back");
});

// ---- 2. Completion: real quiz grading, idempotent attempts ------------------------------------------

test("real execution: a completion is only earned at or above the pass mark; attempts replay idempotently", async () => {
  freshDb(); seedProviderProfilesTable();
  const db = globalThis.__LMS_DB__;
  const saved = await publishedModule(db);
  // Wrong answer on question 2 -> 50% < pass mark 100 -> recorded but NOT passed
  const failed = await submitLmsCompletion(db, { moduleId: saved.moduleId, providerId: "prov_groomer", answers: [1, 0], idempotencyKey: "try-1", actorId: "p" });
  assert.equal(failed.scorePct, 50);
  assert.equal(failed.passed, false);
  let readiness = await providerTrainingReadiness(db, "prov_groomer");
  assert.equal(readiness.trainingReady, false, "a failing attempt never counts as trained");
  assert.equal(readiness.modules[0].state, "not_started");
  // Wrong answer count must match the quiz
  await assert.rejects(submitLmsCompletion(db, { moduleId: saved.moduleId, providerId: "prov_groomer", answers: [1], idempotencyKey: "try-2", actorId: "p" }), (e) => e instanceof Response && e.status === 400);
  // Correct answers -> passed
  const passed = await submitLmsCompletion(db, { moduleId: saved.moduleId, providerId: "prov_groomer", answers: [1, 1], idempotencyKey: "try-3", actorId: "p" });
  assert.equal(passed.scorePct, 100);
  assert.equal(passed.passed, true);
  readiness = await providerTrainingReadiness(db, "prov_groomer");
  assert.equal(readiness.trainingReady, true);
  assert.equal(readiness.modules[0].state, "complete");
  // Idempotent replay of the same attempt
  const replay = await submitLmsCompletion(db, { moduleId: saved.moduleId, providerId: "prov_groomer", answers: [1, 1], idempotencyKey: "try-3", actorId: "p" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM lms_completion_attempts").get().n, 2, "failed try-1 + passed try-3, no duplicate");
});

// ---- 3. Versioning: republish invalidates completions -----------------------------------------------

test("real execution: editing a published module bumps its version and existing completions go stale (retraining required)", async () => {
  freshDb(); seedProviderProfilesTable();
  const db = globalThis.__LMS_DB__;
  const saved = await publishedModule(db);
  await submitLmsCompletion(db, { moduleId: saved.moduleId, providerId: "prov_groomer", answers: [1, 1], idempotencyKey: "pass-v1", actorId: "p" });
  assert.equal((await providerTrainingReadiness(db, "prov_groomer")).trainingReady, true);
  // Content change on the published module -> version 2, completions at v1 no longer count
  const edited = await saveLmsModule(db, { id: saved.moduleId, title: "Grooming safety SOP", serviceCode: "grooming", summary: "Safety fundamentals, updated protocol", sections: ["Check equipment", "New: cooling-off step"], quiz: QUIZ, passPct: 100, actorId: "staff:uat" });
  assert.equal(edited.version, 2);
  assert.equal(edited.retrainingRequired, true);
  const readiness = await providerTrainingReadiness(db, "prov_groomer");
  assert.equal(readiness.trainingReady, false);
  assert.equal(readiness.modules[0].state, "stale_retraining_required", "the old pass is visible as stale, not erased");
  // Passing the NEW version restores readiness
  await submitLmsCompletion(db, { moduleId: saved.moduleId, providerId: "prov_groomer", answers: [1, 1], idempotencyKey: "pass-v2", actorId: "p" });
  assert.equal((await providerTrainingReadiness(db, "prov_groomer")).trainingReady, true);
});

// ---- 4. Scoping: modules apply by service; 'all' applies to everyone --------------------------------

test("real execution: readiness only demands modules covering the provider's services", async () => {
  freshDb(); seedProviderProfilesTable();
  const db = globalThis.__LMS_DB__;
  await publishedModule(db); // grooming-scoped
  const everyone = await saveLmsModule(db, { title: "Platform conduct SOP", serviceCode: "all", summary: "Conduct rules for every provider", sections: ["Be on time"], quiz: [QUIZ[0]], passPct: 100, actorId: "staff:uat" });
  await setLmsModuleStatus(db, { moduleId: everyone.moduleId, status: "published", actorId: "staff:uat" });
  const walker = await providerTrainingReadiness(db, "prov_walker");
  assert.equal(walker.modules.length, 1, "the walker only sees the 'all' module, not the grooming SOP");
  assert.equal(walker.modules[0].moduleId, everyone.moduleId);
  const groomer = await providerTrainingReadiness(db, "prov_groomer");
  assert.equal(groomer.modules.length, 2);
  assert.equal(groomer.requiredTotal, 2);
});

// ---- 5. Route: ownership + staff authoring gate ------------------------------------------------------

test("real execution: a provider can only complete modules for THEMSELVES; authoring requires settings.manage", async () => {
  freshDb(); seedProviderProfilesTable();
  const db = globalThis.__LMS_DB__;
  const saved = await publishedModule(db);
  await call("GET"); // preview actor initializes the security tables
  seedProviderIdentity("kiran@pawspace.test", "prov_groomer");
  seedProviderIdentity("anu@pawspace.test", "prov_walker");
  // Anu (prov_walker) tries to complete AS prov_groomer -> 403
  const foreign = await callAs("POST", { action: "complete_module", moduleId: saved.moduleId, providerId: "prov_groomer", answers: [1, 1], idempotencyKey: "own-1" }, "anu@pawspace.test");
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  // Kiran completes their own module through the real route
  const own = await callAs("POST", { action: "complete_module", moduleId: saved.moduleId, providerId: "prov_groomer", answers: [1, 1], idempotencyKey: "own-2" }, "kiran@pawspace.test");
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.data.passed, true);
  // Reading someone else's readiness is denied; own readiness works
  const foreignRead = await callAs("GET", "providerId=prov_groomer", "anu@pawspace.test");
  assert.equal(foreignRead.status, 403);
  const ownRead = await callAs("GET", "providerId=prov_groomer", "kiran@pawspace.test");
  assert.equal(ownRead.status, 200);
  assert.equal(ownRead.body.data.trainingReady, true);
  // A provider cannot author modules (settings.manage required)
  const author = await callAs("POST", { action: "save_module", title: "Sneaky module", serviceCode: "all", summary: "Should be denied", sections: ["x"], quiz: [QUIZ[0]] }, "kiran@pawspace.test");
  assert.equal(author.status, 403, "module authoring is staff-only");
});

// ---- 6. Overview + contracts -------------------------------------------------------------------------

test("real execution: the staff overview reports pass stats and fleet compliance", async () => {
  freshDb(); seedProviderProfilesTable();
  const db = globalThis.__LMS_DB__;
  const saved = await publishedModule(db, { serviceCode: "all" });
  await submitLmsCompletion(db, { moduleId: saved.moduleId, providerId: "prov_groomer", answers: [1, 1], idempotencyKey: "ov-1", actorId: "p" });
  const overview = await lmsOverview(db);
  assert.equal(overview.metrics.published, 1);
  assert.equal(overview.modules[0].providersPassedCurrentVersion, 1);
  assert.equal(overview.metrics.providersNotReady, 1, "the walker has not passed the 'all' module yet");
  const ready = overview.providers.find(provider => provider.providerId === "prov_groomer");
  assert.equal(ready.trainingReady, true);
  const routeOverview = await call("GET");
  assert.equal(routeOverview.status, 200);
  assert.equal(routeOverview.body.data.truth.republishInvalidatesCompletions, true);
});

test("contract: gateway permission line, DB access rule, and the team surface exist", () => {
  const gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /provider-lms"\)\{if\(method==="GET"\)return "bookings\.view"/);
  assert.match(gateway, /"complete_module"\?"bookings\.view":"settings\.manage"/);
  const source = fs.readFileSync(new URL("../app/api/provider-lms/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /globalThis/, "the route must get the DB via cloudflare:workers env, never globalThis");
  assert.match(source, /requireProviderOwnership/, "provider completions stay ownership-checked");
  const page = fs.readFileSync(new URL("../app/team/people/provider-training/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\/api\/provider-lms/);
});
