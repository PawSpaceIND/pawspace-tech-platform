import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BACKFIN_DB__", "__BACKFIN_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const MAKER = "maker@pawspace.in";
const CHECKER_A = "checker.a@pawspace.in";
const CHECKER_B = "checker.b@pawspace.in";
const URL = "https://finance.pawspace.in/api/finance-control";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__BACKFIN_DB__ = makeD1(sqlite);
  globalThis.__BACKFIN_ENV__ = {};
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)");
  for (const [id, email] of [["maker", MAKER], ["checker-a", CHECKER_A], ["checker-b", CHECKER_B]]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run(id, email, id, "finance", "active");
  }
  return sqlite;
}

const route = await import("../app/api/finance-control/route.ts");
const as = (email, method, body) => new Request(URL, {
  method,
  headers: { "oai-authenticated-user-email": email, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function createExpense(email = MAKER) {
  const response = await route.POST(as(email, "POST", { entity: "expense", expenseDate: "2026-08-10", merchant: "Backend Audit Co", category: "Travel & fuel", amount: 5000, gstAmount: 762 }));
  return { status: response.status, body: await response.json() };
}

async function approve(email, id, reason = "independent finance approval") {
  const response = await route.PATCH(as(email, "PATCH", { entity: "expense", id, action: "approve", reason }));
  return { status: response.status, body: await response.json() };
}

test("non-UAT finance access never inserts synthetic fixtures", async () => {
  const sqlite = freshDb();
  const response = await route.GET(as(CHECKER_A, "GET"));
  assert.equal(response.status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM finance_vendors WHERE id IN ('ven_fuel','ven_food','ven_software')").get().c, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM finance_expenses WHERE id IN ('exp_1001','exp_1002')").get().c, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM finance_bills WHERE id='bill_2001'").get().c, 0);
});

test("authenticated creator is persisted and cannot approve their own expense", async () => {
  const sqlite = freshDb();
  const created = await createExpense();
  assert.equal(created.status, 201);
  const expenseId = created.body.data.id;
  assert.equal(sqlite.prepare("SELECT created_by FROM finance_expenses WHERE id=?").get(expenseId).created_by, MAKER);
  const self = await approve(MAKER, expenseId, "maker attempting self approval");
  assert.equal(self.status, 403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries WHERE source_id=?").get(expenseId).c, 0);
});

test("different finance checker approves exactly one balanced journal pair", async () => {
  const sqlite = freshDb();
  const created = await createExpense();
  const expenseId = created.body.data.id;
  const approved = await approve(CHECKER_A, expenseId);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const rows = sqlite.prepare("SELECT debit,credit FROM finance_journal_entries WHERE source_id=?").all(expenseId);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.debit), 0), rows.reduce((sum, row) => sum + Number(row.credit), 0));
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_posting_claims WHERE source_type='expense' AND source_id=?").get(expenseId).c, 1);
});

test("replaying approval never writes a second journal pair", async () => {
  const sqlite = freshDb();
  const created = await createExpense();
  const expenseId = created.body.data.id;
  assert.equal((await approve(CHECKER_A, expenseId)).status, 200);
  const replay = await approve(CHECKER_A, expenseId, "repeat approval should be harmless");
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries WHERE source_id=?").get(expenseId).c, 2);
});

test("two concurrent independent approvers produce only one journal claim and one journal pair", async () => {
  const sqlite = freshDb();
  const created = await createExpense();
  const expenseId = created.body.data.id;
  const results = await Promise.all([
    approve(CHECKER_A, expenseId, "checker A concurrent approval"),
    approve(CHECKER_B, expenseId, "checker B concurrent approval"),
  ]);
  assert.ok(results.some((r) => r.status === 200), JSON.stringify(results));
  assert.ok(results.every((r) => r.status === 200 || r.status === 409), JSON.stringify(results));
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries WHERE source_id=?").get(expenseId).c, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_posting_claims WHERE source_type='expense' AND source_id=?").get(expenseId).c, 1);
});

test("pay cannot bypass approval and random actions no longer silently mutate status", async () => {
  const sqlite = freshDb();
  const created = await createExpense();
  const expenseId = created.body.data.id;
  const pay = await route.PATCH(as(CHECKER_A, "PATCH", { entity: "expense", id: expenseId, action: "pay", reason: "attempt payment before approval" }));
  assert.equal(pay.status, 409);
  const random = await route.PATCH(as(CHECKER_A, "PATCH", { entity: "expense", id: expenseId, action: "mystery", reason: "unsupported state mutation" }));
  assert.equal(random.status, 400);
  assert.equal(sqlite.prepare("SELECT status FROM finance_expenses WHERE id=?").get(expenseId).status, "submitted");
});
