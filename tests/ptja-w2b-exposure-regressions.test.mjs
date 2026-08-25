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
