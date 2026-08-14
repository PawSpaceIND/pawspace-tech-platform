/**
 * FINDINGS 8 & 9 — FIXED. Converted to assert the SECURE result.
 *
 * FINDING 8 (P1 FINANCE): Maker/checker segregation is now identity-based on the authenticated actor,
 *   never a client-supplied body.actorRole field. The PATCH handler derives the actor via
 *   authorize(request,"finance.manage") and refuses an approve whose recorded created_by == the
 *   approver's email. Self-approval is rejected 403; a spoofed actorRole cannot bypass it. Approve is
 *   idempotent — a replayed approve does not double-post the balanced journal.
 *
 * FINDING 9 (P1/P2 FINANCE DATA): seed() is now gated on PAWSPACE_UAT_LOGIN==="on". With NO UAT/staging
 *   flag and an empty DB, GET/POST/PATCH insert ZERO named synthetic fixtures (the schema is still
 *   ensured so the handlers work against a real/empty D1).
 *
 * These tests authenticate for real: seeded app_users rows with role_code "finance" (which holds
 * finance.manage), resolved through forwarded-identity headers on a NON-localhost URL (so resolveActor
 * does not short-circuit to a development-preview superuser), with NO UAT env flag set.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// The shim reads globalThis.__FIN_DB__ for DB and globalThis.__FIN_ENV__ for every other env var.
// We deliberately leave __FIN_ENV__ = {} so PAWSPACE_UAT_LOGIN / NODE_ENV / anything are all undefined:
// that is the "non-UAT / production-bound" condition finding 9 requires.
installWorkersHooks("__FIN_DB__", "__FIN_ENV__");

const ROUTE_PATH = new URL("../app/api/finance-control/route.ts", import.meta.url).pathname;
const ROUTE_SRC = readFileSync(ROUTE_PATH, "utf8");

// Minimal faithful D1 shim over node:sqlite: prepare/bind/first/run/all + batch + exec, mirroring the
// pattern the repo's own suites use (tests/d1-in-clause-fanout.test.mjs).
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

const MAKER_A = "maker.a@pawspace.in";
const APPROVER_B = "approver.b@pawspace.in";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__FIN_DB__ = makeD1(sqlite);
  globalThis.__FIN_ENV__ = {}; // NO UAT/staging env flag of any kind
  // Two distinct finance staff. resolveActor's ensureSecurityTables creates app_users IF NOT EXISTS and
  // upserts the "finance" role definition (which carries finance.manage), so pre-seeding rows is enough
  // for both identities to authenticate through forwarded-identity headers.
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-a", MAKER_A, "Maker A", "finance", "active");
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-b", APPROVER_B, "Approver B", "finance", "active");
  return sqlite;
}

const route = await import("../app/api/finance-control/route.ts");

// Real finance identities via forwarded-identity headers on a NON-localhost host.
const URL_BASE = "https://finance.pawspace.in/api/finance-control";
const as = (email, init = {}) => new Request(URL_BASE, { ...init, headers: { ...(init.headers || {}), "oai-authenticated-user-email": email } });
async function createExpense(email, overrides = {}) {
  const res = await route.POST(as(email, {
    method: "POST",
    body: JSON.stringify({ entity: "expense", expenseDate: "2026-08-10", merchant: "Maker Checker Co", category: "Travel & fuel", amount: 5000, gstAmount: 762, ...overrides }),
  }));
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function approve(email, id, reason, extra = {}) {
  const res = await route.PATCH(as(email, {
    method: "PATCH",
    body: JSON.stringify({ entity: "expense", id, action: "approve", reason, ...extra }),
  }));
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
const journalCount = (sqlite, id) => sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries WHERE source_id=?").get(id).c;

// ---------------------------------------------------------------------------------------------------
// FINDING 8 — maker == approver self-approval is possible; actor identity not server-derived
// ---------------------------------------------------------------------------------------------------

test("FINDING 8(a) FIXED: maker A creates, a DIFFERENT finance user B approves -> 200 and one balanced journal pair; created_by is the server-derived maker", async () => {
  const sqlite = freshDb();

  const created = await createExpense(MAKER_A, { merchant: "Self Approve Test", claimant: "Same Person" });
  assert.equal(created.status, 201, `maker A create should succeed: ${JSON.stringify(created.body)}`);
  const expenseId = created.body.data.id;
  assert.ok(expenseId, "created expense id");
  assert.equal(journalCount(sqlite, expenseId), 0, "no journal lines before approval");

  // A DIFFERENT finance user approves it -> allowed, one balanced pair posted.
  const approved = await approve(APPROVER_B, expenseId, "approving as a different finance checker");
  assert.equal(approved.status, 200, `approver B should be allowed: ${JSON.stringify(approved.body)}`);
  assert.equal(approved.body.data.status, "approved", "expense advances to status=approved by a real checker");
  assert.equal(journalCount(sqlite, expenseId), 2, "one balanced pair (2 lines) posted");

  // Identity is server-derived: created_by records the authenticated maker, not a client string.
  const row = sqlite.prepare("SELECT created_by FROM finance_expenses WHERE id=?").get(expenseId);
  assert.equal(row.created_by, MAKER_A, "created_by records the authenticated maker");
  console.log("FINDING 8(a) EVIDENCE: maker A -> approver B approve succeeded ->", JSON.stringify(approved.body.data));
});

test("FINDING 8(a') FIXED: the maker approving their OWN expense (omitting actorRole) is now REJECTED 403 on identity", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A, { merchant: "Self Approve Test" });
  const expenseId = created.body.data.id;

  // The SAME person now tries to approve it, omitting actorRole entirely. Server-derived identity
  // catches this: the recorded created_by == the approver's email.
  const selfApprove = await approve(MAKER_A, expenseId, "approving my own expense with no actorRole");
  assert.equal(selfApprove.status, 403, "SELF-APPROVAL IS NOW REFUSED — approval returned 403");
  assert.match(selfApprove.body.error, /Maker cannot approve their own transaction/);
  assert.equal(journalCount(sqlite, expenseId), 0, "a refused self-approval posts nothing");
  const row = sqlite.prepare("SELECT status FROM finance_expenses WHERE id=?").get(expenseId);
  assert.equal(row.status, "submitted", "self-approval did not advance the status");
  console.log("FINDING 8(a') EVIDENCE: self-approval (no actorRole) -> 403 on identity");
});

test("FINDING 8(a'') FIXED: spoofing actorRole='checker' can no longer bypass segregation — the maker is still refused 403 on identity", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A, { merchant: "Spoof Role" });
  const expenseId = created.body.data.id;

  // The maker lies about their role. Identity still says A is the creator -> still refused.
  const res = await approve(MAKER_A, expenseId, "spoofing checker role", { actorRole: "checker" });
  assert.equal(res.status, 403, "a client actorRole field cannot authorize or gate anything");
  assert.match(res.body.error, /Maker cannot approve their own transaction/);
  assert.equal(journalCount(sqlite, expenseId), 0, "no journal posted on the refused spoof");
  console.log("FINDING 8(a'') EVIDENCE: actorRole='checker' spoof still 403 (identity-based)");
});

test("FINDING 8(b) FIXED: the handler NOW derives the actor server-side (authorize/finance.manage), gates on the recorded creator, and audits the real caller (never 'finance_uat')", () => {
  // The mutation handler derives a server-side actor and no longer trusts a client role field.
  assert.match(ROUTE_SRC, /authorize\(request,"finance\.manage"\)/, "POST/PATCH authorize(request,'finance.manage') — server-derived identity");
  // Segregation is identity-based on the recorded creator vs the authenticated approver:
  assert.match(ROUTE_SRC, /row\.created_by&&String\(row\.created_by\)===actor\.email/, "approve is refused when the recorded creator == the authenticated approver");
  assert.match(ROUTE_SRC, /Maker cannot approve their own transaction/, "identity-based self-approval refusal");
  // The client actorRole field is gone as a guard, and the audit actor is no longer hardcoded:
  assert.doesNotMatch(ROUTE_SRC, /body\.actorRole==="maker"/, "the client body.actorRole guard is removed");
  assert.doesNotMatch(ROUTE_SRC, /'finance_uat'/, "audit actor_id is no longer the hardcoded 'finance_uat' constant");
  console.log("FINDING 8(b) EVIDENCE: authorize(finance.manage) + created_by===actor.email guard; no actorRole guard; no finance_uat constant");
});

test("FINDING 8(c) FIXED: approve is idempotent — a replayed identical approve does NOT double-post the journal (stays 2)", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A, { merchant: "Replay Test", amount: 7000 });
  const expenseId = created.body.data.id;

  const r1 = await approve(APPROVER_B, expenseId, "first approval of replay");
  assert.equal(r1.status, 200);
  const after1 = journalCount(sqlite, expenseId);
  assert.equal(after1, 2, "first approve posted one balanced pair (2 lines)");

  // Replay the EXACT same approve. The status guard on re-approve prevents a second posting.
  const r2 = await approve(APPROVER_B, expenseId, "first approval of replay");
  assert.notEqual(r2.status, 500, "the replay must not error out");
  const after2 = journalCount(sqlite, expenseId);
  assert.equal(after2, 2, "REPLAY did NOT double-post — still 2 lines for one expense");
  console.log(`FINDING 8(c) EVIDENCE: journal lines after 1st approve=${after1}, after identical replay=${after2} (not double-posted)`);
});

// ---------------------------------------------------------------------------------------------------
// FINDING 9 — seed() fires on GET/POST/PATCH with NO env guard, in non-UAT mode
// ---------------------------------------------------------------------------------------------------

const NAMED_VENDORS = ["ven_fuel", "ven_food", "ven_software"];
const NAMED_EXPENSES = ["exp_1001", "exp_1002"];
const NAMED_BILL = "bill_2001";
const NAMED_PERIOD = "2026-07";

const absent = (sqlite) => {
  const vendor = sqlite.prepare("SELECT COUNT(*) c FROM finance_vendors WHERE id IN ('ven_fuel','ven_food','ven_software')").get().c;
  const expense = sqlite.prepare("SELECT COUNT(*) c FROM finance_expenses WHERE id IN ('exp_1001','exp_1002')").get().c;
  const bill = sqlite.prepare("SELECT COUNT(*) c FROM finance_bills WHERE id='bill_2001'").get().c;
  const period = sqlite.prepare("SELECT COUNT(*) c FROM finance_close_periods WHERE period_code='2026-07'").get().c;
  return { vendor, expense, bill, period };
};

test("FINDING 9 FIXED: GET on an EMPTY db with NO UAT/staging env flag inserts ZERO synthetic fixtures", async () => {
  const sqlite = freshDb(); // __FIN_ENV__ = {}  => no PAWSPACE_UAT_LOGIN, no NODE_ENV, nothing
  assert.equal(globalThis.__FIN_ENV__.PAWSPACE_UAT_LOGIN, undefined, "no UAT login flag set");
  assert.equal(globalThis.__FIN_ENV__.NODE_ENV, undefined, "no NODE_ENV set");

  const res = await route.GET();
  assert.equal(res.status, 200, "GET still works against an empty/real DB (schema is ensured)");
  const { data } = await res.json();

  const vendorIds = data.vendors.map((v) => v.id);
  const expenseIds = data.expenses.map((e) => e.id);
  const billIds = data.bills.map((b) => b.id);
  const periodCodes = data.periods.map((p) => p.period_code);

  for (const v of NAMED_VENDORS) assert.ok(!vendorIds.includes(v), `synthetic vendor ${v} must NOT be inserted without the UAT flag`);
  for (const e of NAMED_EXPENSES) assert.ok(!expenseIds.includes(e), `synthetic expense ${e} must NOT be inserted`);
  assert.ok(!billIds.includes(NAMED_BILL), `synthetic bill ${NAMED_BILL} must NOT be inserted`);
  assert.ok(!periodCodes.includes(NAMED_PERIOD), `synthetic close period ${NAMED_PERIOD} must NOT be inserted`);

  const { vendor, expense, bill, period } = absent(sqlite);
  assert.equal(vendor + expense + bill + period, 0, "no named synthetic fixtures landed in a non-UAT db");
  console.log(`FINDING 9 EVIDENCE (GET, no env flag): vendors=${JSON.stringify(vendorIds)} expenses=${JSON.stringify(expenseIds)} bills=${JSON.stringify(billIds)} periods=${JSON.stringify(periodCodes)}`);
});

test("FINDING 9 FIXED: an authenticated POST seeds NO fixtures — only the row it creates", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A, { merchant: "Unrelated", amount: 100 });
  assert.equal(created.status, 201, "the authenticated maker's create succeeds");
  const { vendor, expense, bill, period } = absent(sqlite);
  assert.equal(vendor + bill + period, 0, "no synthetic vendor/bill/period fixtures from a POST");
  assert.equal(expense, 0, "no exp_1001/exp_1002 fixtures");
  const total = sqlite.prepare("SELECT COUNT(*) c FROM finance_expenses").get().c;
  assert.equal(total, 1, "exactly the one real row created, no synthetic expenses");
  console.log("FINDING 9 EVIDENCE (POST): no named synthetic vendors/expenses after a real POST");
});

test("FINDING 9 FIXED: a PATCH against a fresh non-UAT db seeds NO fixtures", async () => {
  const sqlite = freshDb();
  // Unknown id 404s — but the point is no seeding happened (seed() is gated off).
  const res = await route.PATCH(as(APPROVER_B, {
    method: "PATCH",
    body: JSON.stringify({ entity: "expense", id: "does_not_exist", action: "approve", reason: "trigger any seed path via patch" }),
  }));
  assert.equal(res.status, 404, "unknown id 404s");
  const { vendor, expense, bill, period } = absent(sqlite);
  assert.equal(vendor + expense + bill + period, 0, "PATCH seeded no named fixtures into a non-UAT db");
  console.log("FINDING 9 EVIDENCE (PATCH): no named synthetic expenses exp_1001/exp_1002 after a PATCH");
});

test("FINDING 9 FIXED: source proof — seed() is now GATED on PAWSPACE_UAT_LOGIN==='on'", () => {
  // seed() still ensures the schema, but the named-fixture inserts are behind the staging flag.
  assert.match(ROUTE_SRC, /async function seedEnabled\(\)\{[\s\S]*?PAWSPACE_UAT_LOGIN[\s\S]*?==="on"/, "seedEnabled() is gated on PAWSPACE_UAT_LOGIN==='on'");
  assert.match(ROUTE_SRC, /async function seed\(db:Db\)\{await ensureSchema\(db\);if\(!await seedEnabled\(\)\)return;/, "seed() ensures schema then bails out unless the staging flag is on");
  console.log("FINDING 9 EVIDENCE (source): seed() gated on PAWSPACE_UAT_LOGIN==='on'; ensures schema only otherwise");
});
