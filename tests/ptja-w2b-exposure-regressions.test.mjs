/**
 * PawSpace Total Journey Audit, Wave 2 Batch B — two exposures, each closed by applying a convention
 * the platform already has somewhere else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_W2BE_DB__", "__PTJA_W2BE_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_W2BE_DB__ = db;
  globalThis.__PTJA_W2BE_ENV__ = {};
  return { sqlite, db };
}

async function staffWorld(email, role) {
  const { sqlite, db } = world();
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .bind(`USR-${role}`, email, `Staff ${role}`, role, now, now).run();
  const headers = {
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": "Probe%20User",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
  return { sqlite, db, headers, now };
}

// =====================================================================================================
// PTJA-W2B-R01 — Customer 360 serves the raw phone to an actor the sibling surface masks it for
//
// MEASURED, same actor, same customer, same second, role=associate (holds customers.view, NOT
// customers.view_full_phone):
//   GET /api/subscription-customers -> {"masked":true,"customer_name":"R••• M•","primary_phone":"+91 ••••••3210"}
//   GET /api/customer-360?customerId=CUST-1 -> {"name":"Ritu Malhotra","primaryPhone":"+919876543210",...}
// One surface masks, the other publishes the raw number.
//
// The convention already exists in app/api/subscription-customers/route.ts:
//   const reveal = hasPermission(actor.permissions,"customers.view_full_phone")
// followed by maskPhone/maskName. Customer 360 simply never applied it.
//
// The masking is applied in the ROUTE, not in buildCustomer360, exactly as the sibling does: that
// function is also called by the AI conversation orchestrator, marketing and promotion governance,
// which need the real contact details to actually reach a customer. Masking the shared builder would
// have broken outbound messaging.
//
// Scope recorded rather than widened: email and home address are NOT masked here. The platform defines
// only maskPhone and maskName, an associate arranging a home service legitimately needs the address, and
// inventing a masking rule for fields the platform has never had one for would be a product decision.
// That exposure is carried in the ledger for product confirmation, not silently closed.
// =====================================================================================================

async function customer360World(role) {
  const { sqlite, db, headers, now } = await staffWorld(`${role}@pawspace.test`, role);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES ('CUST-1','blr','Ritu Malhotra','+919876543210','ritu@example.com',?,?)").run(now, now);
  const route = await import("../app/api/customer-360/route.ts");
  const response = await route.GET(new Request("https://uat.pawspace.in/api/customer-360?customerId=CUST-1", { headers }));
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("W2B-R01: Customer 360 masks the phone for an actor without customers.view_full_phone", async () => {
  const result = await customer360World("associate");
  assert.equal(result.status, 200, `an associate may still open Customer 360: ${JSON.stringify(result).slice(0, 200)}`);
  const payload = JSON.stringify(result.body);
  assert.doesNotMatch(payload, /\+?919876543210/,
    `the raw phone must not be served to an associate: ${payload.slice(0, 400)}`);
  assert.match(payload, /•/, "it is masked, not removed");
});

test("W2B-R01: an actor who holds customers.view_full_phone still sees it", async () => {
  // Non-vacuity. Masking unconditionally would satisfy the case above and blind the roles whose job
  // needs the number.
  const result = await customer360World("admin");
  assert.equal(result.status, 200, `an admin may open Customer 360: ${JSON.stringify(result).slice(0, 200)}`);
  assert.match(JSON.stringify(result.body), /\+?919876543210/,
    "an actor holding customers.view_full_phone still sees the real number");
});

// =====================================================================================================
// PTJA-W2B-P01 — any provider session reads the LMS answer key
//
// lmsOverview() builds each module as `{...row, sections, quizQuestions: parse(row.quiz_json).length}`
// where `row` is `SELECT * FROM lms_modules`. The spread re-emits the raw quiz_json column - every
// question's answerIndex - even though the very next expression deliberately reduces the quiz to a COUNT.
//
// MEASURED: a provider platform session called GET /api/provider-lms with no providerId, taking the
// staff overview branch, and received quiz_json in full:
//   [{"question":"What do you do if the dog bites?","options":[...],"answerIndex":1}, ...]
// Replaying those indices through POST complete_module passed every mandatory module at 100%. One GET
// returns the answer key for every published and draft module at once.
//
// The correction removes the column the projection already meant to summarise. Nothing else changes:
// the count, the sections and the compliance roster are all still served.
// =====================================================================================================

test("W2B-P01: the LMS overview does not carry the answer key", async () => {
  const { sqlite, db } = await staffWorld("ops.admin@pawspace.test", "admin");
  const lms = await import("../lib/provider-lms.ts");
  await lms.ensureLmsTables(db);
  const now = Date.now();
  const quiz = JSON.stringify([
    { question: "What do you do if the dog bites?", options: ["Hit it", "Stop and call ops", "Continue"], answerIndex: 1 },
    { question: "Minimum water temperature?", options: ["Boiling", "Lukewarm", "Ice"], answerIndex: 1 },
  ]);
  sqlite.prepare("INSERT INTO lms_modules (id,title,service_code,summary,content_json,quiz_json,pass_pct,required,version,status,updated_by,created_at,updated_at) VALUES ('LMS-1','Handling','grooming','s','[]',?,80,1,1,'published','ops',?,?)").run(quiz, now, now);

  const overview = await lms.lmsOverview(db);
  const payload = JSON.stringify(overview);
  assert.doesNotMatch(payload, /answerIndex/,
    `the answer key must not be served: ${payload.slice(0, 400)}`);
  assert.doesNotMatch(payload, /quiz_json/, "nor the raw column it lives in");

  // Non-vacuity: everything the overview is FOR is still there.
  const module = overview.modules.find((entry) => String(entry.id) === "LMS-1");
  assert.ok(module, "the module is still listed");
  assert.equal(Number(module.quizQuestions), 2, "with its question count");
  assert.equal(String(module.title), "Handling", "and its title");
});

// =====================================================================================================
// PTJA-W2B-R06 — the Launch Readiness handler enforces no permission and invents a role for an
// unprovisioned identity
//
// app/api/launch-readiness/route.ts has its own local actor(): it reads the forwarded identity header
// and returns {email, roleCode: row?.role_code || "associate"} - a MISSING app_users row falls through
// to the literal "associate" instead of refusing. The GET then calls no requirePermission or authorize
// of any kind. lib/server-auth.ts resolveActor, given the same input, throws
// authFailure("Access has not been provisioned for this identity", 403).
//
// MEASURED, both gates driven independently:
//   stranger@example.com          gateway 403 "Access has not been provisioned or is disabled"
//                                 handler  200 with the full readiness register
//   a real customer identity      gateway 403 "Permission denied"
//                                 handler  200 with the same full register
//
// Only gate one refuses. The platform's stated convention is that the gateway is the first gate and the
// handler is the second - the handler is not entitled to assume the gateway ran. The route now
// authorizes on launch.view, which is exactly what the gateway already maps GET /api/launch-readiness
// to, so the two gates agree instead of disagreeing.
// =====================================================================================================

async function launchReadiness(headers) {
  const route = await import("../app/api/launch-readiness/route.ts");
  const response = await route.GET(new Request("https://uat.pawspace.in/api/launch-readiness", { headers }));
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("W2B-R06: an unprovisioned identity is refused by the handler, not given a role", async () => {
  await staffWorld("ops.admin@pawspace.test", "admin");
  const stranger = await launchReadiness({
    "oai-authenticated-user-email": "stranger@example.com",
    "oai-authenticated-user-full-name": "Probe%20User",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  });
  assert.notEqual(stranger.status, 200,
    `an identity with no app_users row must not be handed a role: ${JSON.stringify(stranger).slice(0, 300)}`);
});

test("W2B-R06: a provisioned identity without launch.view is refused too", async () => {
  const { db, now } = await staffWorld("ops.admin@pawspace.test", "admin");
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-CUST','cust@p.test','Customer','customer','active',?,?)").bind(now, now).run();
  const customer = await launchReadiness({
    "oai-authenticated-user-email": "cust@p.test",
    "oai-authenticated-user-full-name": "Probe%20User",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  });
  assert.notEqual(customer.status, 200,
    `a customer identity must not read the launch register: ${JSON.stringify(customer).slice(0, 300)}`);
});

test("W2B-R06: a staff identity that holds launch.view still reads it", async () => {
  // Non-vacuity. Refusing everyone would satisfy the two cases above and break the launch console.
  const { headers } = await staffWorld("founder@pawspace.test", "founder");
  const founder = await launchReadiness(headers);
  assert.equal(founder.status, 200, `the launch console must still work: ${JSON.stringify(founder).slice(0, 300)}`);
});

// =====================================================================================================
// PTJA-W2B-C01 / C07 — two more staff surfaces serving unmasked customer contact data
//
// The same convention gap as Customer 360, on two more routes. app/api/subscription-customers/route.ts
// carries the platform's rule - reveal = hasPermission(actor.permissions,"customers.view_full_phone"),
// then maskPhone/maskName - and neither of these applied it.
//
// MEASURED, role=associate (holds customers.view and communications.manage, NOT
// customers.view_full_phone):
//   GET /api/crm           -> {"primary_phone":"+919845012345","secondary_phone":"+919845099999", ...}
//   GET /api/conversations -> threads[{"primary_phone":"+919845012345"}]
//
// Both now mask name and phone for an actor without customers.view_full_phone, at the route, exactly as
// the sibling does.
//
// Scope recorded rather than widened, the same as for Customer 360: email is NOT masked - the platform
// defines only maskPhone and maskName - and the conversations payload's `internalNote`, which carried
// "Customer threatened to go to consumer court", is left alone because who may read a staff-authored
// internal note is a product decision, not a masking rule. Both are carried in the ledger.
// =====================================================================================================

test("W2B-C01: the CRM contact list masks phones for an actor without customers.view_full_phone", async () => {
  const { sqlite, db, headers } = await staffWorld("associate@pawspace.test", "associate");
  const crm = await import("../app/api/crm/route.ts");
  sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT,owner TEXT,source TEXT,lifetime_value REAL,next_action TEXT,opportunity TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,stage,owner,source,created_at,updated_at) VALUES ('CU-VICTIM','Meera Shah','+919845012345','+919845099999','meera.shah@example.com','Indiranagar','New lead','Neha','Website',?,?)").run(Date.now(), Date.now());

  const response = await crm.GET(new Request("https://uat.pawspace.in/api/crm", { headers }));
  assert.equal(response.status, 200, "an associate may still open the CRM list");
  const payload = await response.text();
  assert.doesNotMatch(payload, /\+?919845012345/, `the raw primary phone must not be served: ${payload.slice(0, 300)}`);
  assert.doesNotMatch(payload, /\+?919845099999/, "nor the secondary");
  assert.match(payload, /•/, "they are masked, not removed");
});

test("W2B-C01: an actor with customers.view_full_phone still sees the CRM numbers", async () => {
  // Non-vacuity.
  const { sqlite, db, headers } = await staffWorld("ops.admin2@pawspace.test", "admin");
  const crm = await import("../app/api/crm/route.ts");
  sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT,owner TEXT,source TEXT,lifetime_value REAL,next_action TEXT,opportunity TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,stage,owner,source,created_at,updated_at) VALUES ('CU-VICTIM','Meera Shah','+919845012345','+919845099999','meera.shah@example.com','Indiranagar','New lead','Neha','Website',?,?)").run(Date.now(), Date.now());

  const response = await crm.GET(new Request("https://uat.pawspace.in/api/crm", { headers }));
  assert.match(await response.text(), /\+?919845012345/, "an admin still sees the real number");
});

test("W2B-C07: the conversation thread list masks the customer phone", async () => {
  const { sqlite, db, headers } = await staffWorld("associate2@pawspace.test", "associate");
  const conversations = await import("../lib/conversation-governance.ts");
  await conversations.ensureConversationGovernance(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('CUST-V','blr','Meera Victim','+919845012345',?,?)").run(Date.now(), Date.now());
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES ('THREAD-V','CUST-V','open',NULL,?,?)").run(Date.now(), Date.now());

  const route = await import("../app/api/conversations/route.ts");
  const response = await route.GET(new Request("https://uat.pawspace.in/api/conversations", { headers }));
  assert.equal(response.status, 200, "an associate may still open the inbox");
  const payload = await response.text();
  assert.doesNotMatch(payload, /\+?919845012345/, `the raw phone must not be served: ${payload.slice(0, 300)}`);
});
