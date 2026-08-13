import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// /control's landing screen used to render invented governance numbers: "Audited
// areas 14", "Verified requirements 84", "P0 release blockers 5", five
// hand-written "needs attention" rows and six assurance bars sitting at 86-97%.
// Nothing touched the database, so nothing could be wrong and nothing could be
// checked. These tests run the real builder over a real database and pin three
// properties: every number is derivable from the seeds, every posture score is a
// ratio of two counted numbers, and a table that does not exist yields null
// rather than a plausible percentage.
//
// The table DDL is taken from the module that OWNS each table, never re-typed
// here: a suite that declares its own columns will happily agree with a query
// that names columns the real database does not have.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
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

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); } };
}
/** Create only the tables named, using the DDL written by the module that owns them. */
function applyOwnedDdl(sqlite, path, wanted) {
  const source = read(path);
  const created = new Set();
  for (const match of source.matchAll(/(["'`])(CREATE (?:TABLE|INDEX|UNIQUE INDEX)[\s\S]*?)\1/g)) {
    const sql = match[2];
    const name = /CREATE (?:TABLE|INDEX|UNIQUE INDEX)(?: IF NOT EXISTS)? ([a-z_]+)/i.exec(sql)?.[1];
    if (!name) continue;
    const table = /CREATE TABLE/i.test(sql) ? name : /ON ([a-z_]+)/i.exec(sql)?.[1];
    if (!wanted.includes(table)) continue;
    try { sqlite.exec(sql); if (/CREATE TABLE/i.test(sql)) created.add(name); } catch { /* index whose table this suite skipped */ }
  }
  return created;
}

const { buildControlTower } = await import("../lib/control-tower.ts");
const { caseTypes, caseSeverities, REQUIRED_CASE_POLICY_COUNT } = await import("../lib/case-sla-defaults.ts");

const ASOF = Date.UTC(2026, 7, 13, 6, 0, 0); // 13 August 2026, 11:30 IST
const DAY = "2026-08-13";

/** A database with only the tables listed, built from their owners' own DDL. */
function fresh(tables = []) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const owners = {
    unified_cases: "lib/unified-case-center.ts",
    case_policies: "lib/unified-case-center.ts",
    ops_work_queue_tasks: "lib/ops-work-queue.ts",
    payment_reconciliation_exceptions: "lib/grooming-payment-reconciliation.ts",
    statutory_filings: "lib/statutory-compliance.ts",
    staff_alerts: "lib/staff-alert-center.ts",
    provider_onboarding_applications: "lib/provider-onboarding-transactional.ts",
    security_audit_events: "lib/server-auth.ts",
    bot_call_dispositions: "lib/bot-call-disposition.ts",
  };
  const created = new Set();
  for (const [table, owner] of Object.entries(owners)) {
    if (!tables.includes(table)) continue;
    for (const name of applyOwnedDdl(sqlite, owner, [table])) created.add(name);
  }
  for (const table of tables) assert.ok(created.has(table), `no owner module declared DDL for ${table}`);
  return { sqlite, db };
}

test("an empty platform reports zeros and 'not connected', never a plausible percentage", async () => {
  const { db } = fresh();
  const tower = await buildControlTower(db, { asOf: ASOF });
  assert.equal(tower.date, DAY);
  assert.equal(tower.timezone, "Asia/Kolkata");
  for (const key of ["cases", "opsQueue", "paymentReconciliation", "statutory", "alerts", "providerOnboarding", "botCallClaims", "auditTrail"]) {
    assert.equal(tower.sourceStatus[key], "not_connected", `${key} has no table, so it must report not_connected`);
  }
  // The screen must never claim a requirements count - there is no register in the database.
  assert.equal(tower.sourceStatus.requirementsRegister, "not_connected");
  for (const area of tower.posture) {
    if (area.code === "case_sla_coverage") continue; // the pair list is code, not a table
    assert.equal(area.score, null, `${area.code} has no source, so its score must be null, not a number`);
  }
  assert.deepEqual(tower.recentChanges, []);
});

test("case signals are counted from real cases, and SLA coverage is measured against every pair", async () => {
  const { sqlite, db } = fresh(["unified_cases", "case_policies"]);
  const insertCase = (id, status, dueAt) => sqlite.prepare(
    "INSERT INTO unified_cases (id,idempotency_key,case_type,severity,status,title,description,source_type,source_id,owner_team,resolution_due_at,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, `ik-${id}`, "customer_complaint", "high", status, "t", "d", "test", id, "cx", dueAt, "uat", ASOF, "uat", ASOF);
  insertCase("C-BREACH", "open", ASOF - 60_000);       // past its resolution due time
  insertCase("C-INSIDE", "in_progress", ASOF + 60_000); // still inside SLA
  insertCase("C-DONE", "resolved", ASOF - 60_000);      // resolved cases are not open, breached or not

  sqlite.prepare("INSERT INTO case_policies (id,name,status,version,case_type,severity,first_response_minutes,resolution_minutes,manager_escalation_minutes,effective_from,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("P1", "complaint high", "active_uat", 1, "customer_complaint", "high", 30, 480, 60, ASOF - 86_400_000, "uat", ASOF, "uat", ASOF);

  const tower = await buildControlTower(db, { asOf: ASOF });
  const breach = tower.signals.find(item => item.code === "cases_past_sla");
  assert.equal(breach.count, 1, "only the open, past-due case counts");
  assert.equal(breach.severity, "critical");

  const coverage = tower.signals.find(item => item.code === "sla_coverage");
  assert.equal(coverage.count, REQUIRED_CASE_POLICY_COUNT - 1, "one pair is covered, the rest are gaps");
  assert.equal(REQUIRED_CASE_POLICY_COUNT, caseTypes.length * caseSeverities.length);

  const adherence = tower.posture.find(area => area.code === "case_sla_adherence");
  assert.equal(adherence.total, 2, "two cases are open");
  assert.equal(adherence.good, 1);
  assert.equal(adherence.score, 50, "the score is exactly good/total, and both are published");
});

test("money, filing and onboarding signals count only what is genuinely outstanding", async () => {
  const { sqlite, db } = fresh(["payment_reconciliation_exceptions", "statutory_filings", "provider_onboarding_applications"]);
  const exception = (id, status) => sqlite.prepare(
    "INSERT INTO payment_reconciliation_exceptions (id,exception_type,severity,status,created_at) VALUES (?,?,?,?,?)")
    .run(id, "unmatched", "high", status, ASOF);
  exception("X1", "open");
  exception("X2", "open");
  exception("X3", "resolved");

  const filing = (code, status, dueDate) => sqlite.prepare(
    "INSERT INTO statutory_filings (id,obligation_code,period,due_date,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(`F-${code}`, code, "2026-07", dueDate, status, ASOF, ASOF);
  filing("GSTR1", "pending", "2026-08-11");  // overdue
  filing("GSTR3B", "pending", "2026-08-20"); // due later, not overdue
  filing("TDS", "filed", "2026-08-07");      // filed

  const application = (id, decision) => sqlite.prepare(
    "INSERT INTO provider_onboarding_applications (id,vertical_key,country_code,status,locale_code,basic_info_json,human_decision,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, "grooming", "IN", "in_review", "en-IN", "{}", decision, "uat", ASOF, ASOF);
  application("A1", null);
  application("A2", "approved");

  const tower = await buildControlTower(db, { asOf: ASOF });
  assert.equal(tower.signals.find(item => item.code === "payment_exceptions").count, 2, "resolved exceptions are not outstanding");
  assert.equal(tower.signals.find(item => item.code === "statutory_overdue").count, 1, "only the filing past its due date is overdue");
  assert.equal(tower.signals.find(item => item.code === "onboarding_waiting").count, 1);

  const filingPosture = tower.posture.find(area => area.code === "statutory_filing");
  assert.equal(filingPosture.good, 1);
  assert.equal(filingPosture.total, 3);
  assert.equal(filingPosture.score, 33);

  // The headline is the sum of the signals, so it can never drift from the list below it.
  assert.equal(tower.headline.openItems, tower.signals.reduce((sum, item) => sum + item.count, 0));
  assert.equal(tower.headline.needsAttention, tower.signals.filter(item => item.severity === "critical").length);
  assert.equal(tower.headline.signalsTracked, tower.headline.needsAttention + tower.headline.signalsClear);
});

test("a table with no rows scores nothing, not 100%", async () => {
  // The table exists but is empty: 0 of 0 must NOT render as a perfect score. This is the exact
  // overstatement the screen was rebuilt to remove, in a new costume.
  const { db } = fresh(["payment_reconciliation_exceptions"]);
  const tower = await buildControlTower(db, { asOf: ASOF });
  const area = tower.posture.find(item => item.code === "payment_reconciliation");
  assert.equal(area.total, 0, "the table exists and is empty");
  assert.equal(area.score, null, "nothing recorded means nothing measured, not 100%");
  assert.equal(tower.sourceStatus.paymentReconciliation, "payment_reconciliation_exceptions", "the source IS connected - it is simply empty");

  // The screen tells the two apart: total===null is a missing table, total===0 is an empty one.
  const page = read("app/control/page.tsx");
  assert.match(page, /area\.total === null \? "not connected" : area\.total === 0 \? "nothing recorded yet"/);
  assert.match(page, /area\.total === null \? "n\/c" : area\.total === 0 \? "—"/);
});

test("the audit trail reads the columns security_audit_events actually has", async () => {
  const { sqlite, db } = fresh(["security_audit_events"]);
  sqlite.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("AE1", "founder@pawspace.in", "founder", "pricing.publish", "pricing_rule", "PR-9", "completed", "{}", ASOF);
  const tower = await buildControlTower(db, { asOf: ASOF });
  assert.equal(tower.sourceStatus.auditTrail, "security_audit_events");
  assert.deepEqual(tower.recentChanges, [{ at: ASOF, actor: "founder@pawspace.in", action: "pricing.publish", entity: "pricing_rule:PR-9", outcome: "completed" }]);
  // Guard against the drift that has bitten this codebase before: the query must name the columns
  // the owning module declares, not invented ones.
  const source = read("lib/control-tower.ts");
  const owner = read("lib/server-auth.ts");
  for (const column of ["actor_email", "action", "resource_type", "resource_id", "outcome", "created_at"]) {
    assert.ok(owner.includes(column), `${column} must exist in the owning module's DDL`);
  }
  assert.doesNotMatch(source, /entity_type|entity_id/, "security_audit_events has no entity_* columns");
});

test("bot-call conversion claims surface until a human reconciles them", async () => {
  const { sqlite, db } = fresh(["bot_call_dispositions"]);
  const disposition = (id, status) => sqlite.prepare(
    "INSERT INTO bot_call_dispositions (id,idempotency_key,lead_id,contact_id,phone,channel,bot_provider,primary_tag,tags_json,crm_outcome,reconciliation_status,recorded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, `ik-${id}`, "LEAD-1", "CON-1", "+919999999999", "call", "haptik_voice", "paid", '["paid"]', "Interested", status, "bot", ASOF);
  disposition("D1", "pending_reconciliation");
  disposition("D2", "pending_reconciliation");
  disposition("D3", "reconciled");
  disposition("D4", "not_required");

  const tower = await buildControlTower(db, { asOf: ASOF });
  const claims = tower.signals.find(item => item.code === "bot_claims");
  assert.equal(claims.count, 2, "only claims still awaiting a human count");
  assert.equal(claims.severity, "critical");
});

test("the /control screen renders the live tower and labels what is still sample data", () => {
  const page = read("app/control/page.tsx");
  // The invented headline figures are gone.
  assert.doesNotMatch(page, /"Audited areas"/, "the invented audited-areas figure is gone");
  assert.doesNotMatch(page, /"Verified requirements"/);
  assert.doesNotMatch(page, /"P0 release blockers"/);
  assert.doesNotMatch(page, /\["Identity & access", 94\]/, "the invented assurance percentages are gone");
  assert.doesNotMatch(page, /Accounts access review overdue/, "the hand-written owner signals are gone");
  // It now fetches, and every posture bar publishes the ratio behind its score.
  assert.match(page, /fetch\("\/api\/control-tower"/);
  assert.match(page, /tower\?\.signals\.map/);
  assert.match(page, /tower\?\.posture\.map/);
  assert.match(page, /`\$\{area\.good\} of \$\{area\.total\}`/, "each bar publishes the ratio behind its score");
  // Views still on sample rows say so, and the authored register is not passed off as measurement.
  assert.match(page, /PROTOTYPE_CONTROL_VIEWS/);
  assert.match(page, /AUTHORED_REGISTER_VIEWS/);
  assert.match(page, /still shows built-in example rows/);
  // Nav badges carried invented queue lengths.
  const navBlock = page.slice(page.indexOf("const nav:"), page.indexOf("const roles ="));
  assert.doesNotMatch(navBlock, /count:\s*\d+/);
  // Gateway + route contract.
  assert.match(read("lib/api-gateway.ts"), /url\.pathname==="\/api\/control-tower"\)return "audit\.view"/);
  assert.match(read("app/api/control-tower/route.ts"), /authorize\(request,"audit\.view"\)/);
});
