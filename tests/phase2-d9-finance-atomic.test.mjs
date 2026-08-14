/**
 * PHASE 2 — D9 (P2): finance-control approval atomicity (app/api/finance-control/route.ts).
 *
 * BEFORE: the PATCH approve path SELECTed the row status, computed
 *   shouldPost = action==="approve" && row.status!=="approved" && row.status!=="paid"
 * and then issued an UNCONDITIONAL `UPDATE finance_expenses SET status=? WHERE id=?` before posting the
 * journal. That is a read-then-write TOCTOU: two concurrent approves both pass the SELECT while the row is
 * still "submitted", both write, and both call postBalancedJournal — whose group key is a fresh random
 * id("journal") each call, so nothing dedupes and TWO balanced pairs (4 lines) land for one expense.
 *
 * AFTER: the approve is a SINGLE conditional UPDATE carrying the status precondition —
 *   UPDATE finance_expenses SET status='approved' WHERE id=? AND status NOT IN ('approved','paid')
 * and shouldPost is derived from the affected-row count (meta.changes===1). Only the writer that actually
 * claimed the row posts; a replayed/loser approve changes nothing and posts nothing. Maker≠approver
 * identity, created_by handling, real-actor audit and the response shape are all unchanged.
 *
 * HONESTY ABOUT node:sqlite. node:sqlite is synchronous/serialized and cannot produce true OS-level
 * parallelism. The concurrency test below forces the exact INTERLEAVE two Workers would produce by parking
 * the first approve's UPDATE in a barrier shim until the second has finished its SELECT — the same
 * technique the repo's refund-approval-race suite uses. The structural guarantee (single conditional
 * UPDATE + meta.changes gate) is what closes the window; the barrier only makes the ordering deterministic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__FIN_DB__", "__FIN_ENV__");

const ROUTE_PATH = new URL("../app/api/finance-control/route.ts", import.meta.url).pathname;
const ROUTE_SRC = readFileSync(ROUTE_PATH, "utf8");

const MAKER_A = "maker.a@pawspace.in";
const APPROVER_B = "approver.b@pawspace.in";
const APPROVER_C = "approver.c@pawspace.in";

// Faithful D1 shim over node:sqlite, returning meta.changes on run() (the route derives shouldPost from it).
function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
      run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const out = []; for (const s of statements) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

// Barrier variant: parks the FIRST run() whose SQL matches the approve UPDATE, releasing on demand — the
// deterministic stand-in for two Workers whose SELECTs both observed "submitted" before either UPDATE ran.
function racingD1(sqlite, matcher) {
  let claims = 0, parked = false, overlapped = false, release;
  const gate = new Promise((r) => { release = r; });
  const matches = (sql) => matcher.test(String(sql || ""));
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { await null; const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
      run: async () => {
        if (matches(sql)) {
          claims += 1;
          if (claims === 1) { parked = true; await gate; parked = false; }
          else if (parked) overlapped = true;
        }
        await null;
        const i = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(i.changes) } };
      },
      all: async () => { await null; return { results: sqlite.prepare(sql).all(...args) }; },
    };
  }
  return {
    db: {
      prepare: (sql) => statement(sql, []),
      batch: async (statements) => { const out = []; for (const s of statements) out.push(await s.run()); return out; },
      exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    },
    release: () => release(),
    overlapped: () => overlapped,
  };
}

function seedUsers(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)");
  const ins = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)");
  ins.run("u-a", MAKER_A, "Maker A", "finance", "active");
  ins.run("u-b", APPROVER_B, "Approver B", "finance", "active");
  ins.run("u-c", APPROVER_C, "Approver C", "finance", "active");
}

const route = await import("../app/api/finance-control/route.ts");
const URL_BASE = "https://finance.pawspace.in/api/finance-control";
const as = (email, init = {}) => new Request(URL_BASE, { ...init, headers: { ...(init.headers || {}), "oai-authenticated-user-email": email } });

async function createExpense(email, overrides = {}) {
  const res = await route.POST(as(email, { method: "POST", body: JSON.stringify({ entity: "expense", expenseDate: "2026-08-10", merchant: "D9 Co", category: "Travel & fuel", amount: 5000, gstAmount: 762, ...overrides }) }));
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function approve(dbHooksAlreadySet, email, id, reason) {
  const res = await route.PATCH(as(email, { method: "PATCH", body: JSON.stringify({ entity: "expense", id, action: "approve", reason }) }));
  return { status: res.status, body: await res.json().catch(() => null) };
}
const journalLines = (sqlite, id) => sqlite.prepare("SELECT debit,credit FROM finance_journal_entries WHERE source_id=?").all(id);

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__FIN_DB__ = makeD1(sqlite);
  globalThis.__FIN_ENV__ = {};
  seedUsers(sqlite);
  return sqlite;
}

// ---------------------------------------------------------------------------------------------------

test("D9(a): a valid checker approval posts EXACTLY ONE balanced journal pair (2 lines, debits==credits)", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A, { merchant: "Valid Approve", amount: 8400 });
  assert.equal(created.status, 201, `create should succeed: ${JSON.stringify(created.body)}`);
  const id = created.body.data.id;
  assert.equal(journalLines(sqlite, id).length, 0, "no journal before approval");

  const approved = await approve(true, APPROVER_B, id, "approved by a distinct finance checker");
  assert.equal(approved.status, 200, `approver B allowed: ${JSON.stringify(approved.body)}`);
  assert.equal(approved.body.data.status, "approved", "response shape preserved: status=approved");
  const lines = journalLines(sqlite, id);
  assert.equal(lines.length, 2, "exactly one balanced pair (2 lines) posted");
  const debits = lines.reduce((s, l) => s + Number(l.debit), 0), credits = lines.reduce((s, l) => s + Number(l.credit), 0);
  assert.equal(debits, credits, "the posted pair balances");
  assert.equal(debits, 8400, "the pair posts the expense amount");
  console.error(`D9(a) EVIDENCE: one approve -> ${lines.length} journal lines, debits=${debits} credits=${credits}`);
});

test("D9(b): sequential idempotency preserved — a replayed approve makes ZERO changes and posts NO second pair (stays 2)", async () => {
  const sqlite = freshDb();
  const id = (await createExpense(MAKER_A, { merchant: "Replay", amount: 7000 })).body.data.id;
  const r1 = await approve(true, APPROVER_B, id, "first approval");
  assert.equal(r1.status, 200);
  assert.equal(journalLines(sqlite, id).length, 2, "first approve posts one pair");
  const r2 = await approve(true, APPROVER_B, id, "replayed approval");
  assert.notEqual(r2.status, 500, "replay must not error");
  assert.equal(r2.body.data.status, "approved", "replay still reports approved (idempotent response)");
  assert.equal(journalLines(sqlite, id).length, 2, "replay of an already-approved row posts nothing new — still 2 lines");
  console.error("D9(b) EVIDENCE: replay of an already-approved row left journal lines at 2");
});

test("D9(c): self-approval still 403 and posts nothing (maker≠approver identity check intact)", async () => {
  const sqlite = freshDb();
  const id = (await createExpense(MAKER_A, { merchant: "Self" })).body.data.id;
  const self = await approve(true, MAKER_A, id, "approving my own expense");
  assert.equal(self.status, 403, "self-approval refused 403");
  assert.match(self.body.error, /Maker cannot approve their own transaction/);
  assert.equal(journalLines(sqlite, id).length, 0, "a refused self-approval posts nothing");
  assert.equal(sqlite.prepare("SELECT status FROM finance_expenses WHERE id=?").get(id).status, "submitted", "status not advanced");
});

test("D9(d): two INTERLEAVED approves post exactly ONE pair — the conditional UPDATE + changes-gate closes the TOCTOU", async () => {
  // node:sqlite serialization limitation: this cannot run two OS threads. The barrier forces the exact
  // interleave the bug needs — both approvers' SELECTs observe "submitted" before either UPDATE commits.
  // Under the pre-fix unconditional UPDATE both would post (4 lines); the conditional UPDATE lets only the
  // row-claiming writer post (2 lines). That structural guarantee is what the assertion below verifies.
  const sqlite = freshDb();
  const id = (await createExpense(MAKER_A, { merchant: "Race", amount: 6000 })).body.data.id;

  const racing = racingD1(sqlite, /UPDATE finance_expenses SET status='approved'/);
  globalThis.__FIN_DB__ = racing.db;
  const p1 = route.PATCH(as(APPROVER_B, { method: "PATCH", body: JSON.stringify({ entity: "expense", id, action: "approve", reason: "checker B approving" }) }));
  const p2 = route.PATCH(as(APPROVER_C, { method: "PATCH", body: JSON.stringify({ entity: "expense", id, action: "approve", reason: "checker C approving" }) }));
  for (let tick = 0; tick < 400; tick += 1) await null; // both reach the approve UPDATE; the first parks
  const overlapped = racing.overlapped();
  racing.release();
  const [res1, res2] = await Promise.all([p1, p2]);
  const statuses = [res1.status, res2.status];
  const lines = journalLines(sqlite, id);
  console.error(`D9(d) EVIDENCE: overlapped=${overlapped} httpStatuses=${JSON.stringify(statuses)} journalLines=${lines.length}`);
  assert.equal(overlapped, true, "the interleave actually happened — otherwise nothing is proven");
  assert.equal(lines.length, 2, "exactly ONE balanced pair posted despite two interleaved approves (TOCTOU closed)");
  const debits = lines.reduce((s, l) => s + Number(l.debit), 0), credits = lines.reduce((s, l) => s + Number(l.credit), 0);
  assert.equal(debits, credits, "the single posted pair balances");
  assert.equal(debits, 6000, "and posts the amount exactly once");
});

test("D9(e): source proof — the approve path is a SINGLE conditional UPDATE gated by meta.changes (expense AND bill)", () => {
  // The atomic claim carries the status precondition in its WHERE and derives shouldPost from meta.changes.
  assert.match(ROUTE_SRC, /UPDATE finance_expenses SET status='approved',updated_at=\? WHERE id=\? AND status NOT IN \('approved','paid'\)/, "expense approve is a conditional UPDATE with the status precondition");
  assert.match(ROUTE_SRC, /UPDATE finance_bills SET status='approved',updated_at=\? WHERE id=\? AND status NOT IN \('approved','paid'\)/, "bill approve is a conditional UPDATE with the status precondition");
  assert.match(ROUTE_SRC, /shouldPost=Number\(claim\?\.meta\?\.changes\|\|0\)===1/, "shouldPost is derived from the affected-row count");
  // The pre-fix read-then-unconditional-write shape is gone.
  assert.doesNotMatch(ROUTE_SRC, /const shouldPost=body\.action==="approve"&&row\.status!=="approved"&&row\.status!=="paid"/, "the read-then-write TOCTOU shape is removed");
  // Existing invariants still present: maker≠approver identity, server-derived actor, audit of real caller.
  assert.match(ROUTE_SRC, /row\.created_by&&String\(row\.created_by\)===actor\.email/, "maker≠approver identity check retained");
  assert.match(ROUTE_SRC, /authorize\(request,"finance\.manage"\)/, "server-derived actor retained");
  console.error("D9(e) EVIDENCE: single conditional UPDATE + meta.changes gate for expense & bill; old TOCTOU shape absent");
});

test("D9(f): a valid bill approval posts exactly one balanced pair", async () => {
  const sqlite = freshDb();
  sqlite.exec("CREATE TABLE IF NOT EXISTS finance_vendors_seed (x)"); // no-op guard; vendors optional for approve
  const created = await route.POST(as(MAKER_A, { method: "POST", body: JSON.stringify({ entity: "bill", vendorId: "ven_x", billNumber: "BILL-1", billDate: "2026-08-10", totalAmount: 56640, taxableAmount: 48000, gstAmount: 8640 }) }));
  assert.equal(created.status, 201, `bill create: ${await created.clone().text()}`);
  const id = (await created.json()).data.id;
  const approved = await route.PATCH(as(APPROVER_B, { method: "PATCH", body: JSON.stringify({ entity: "bill", id, action: "approve", reason: "bill checker approval" }) }));
  assert.equal(approved.status, 200, `bill approve: ${await approved.clone().text()}`);
  const lines = journalLines(sqlite, id);
  assert.equal(lines.length, 2, "one balanced pair for the bill");
  assert.equal(lines.reduce((s, l) => s + Number(l.debit), 0), lines.reduce((s, l) => s + Number(l.credit), 0), "bill pair balances");
});
