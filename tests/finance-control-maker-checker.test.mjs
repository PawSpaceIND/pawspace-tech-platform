import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// Regression for findings 8 & 9 in app/api/finance-control/route.ts.
//
// Finding 8: maker/checker segregation must be identity-based on the authenticated actor, not on a
//   client-supplied body.actorRole field, and an approve must be idempotent (a replay must not double
//   post the balanced journal).
// Finding 9: the synthetic seed fixtures must only land when the staging UAT flag is set. With no flag
//   and an empty DB, ordinary GET/POST/PATCH must insert ZERO named fixtures.
//
// This suite authenticates for real: seeded app_users rows with role_code "finance" (which holds
// finance.manage), resolved through forwarded-identity headers (oai-authenticated-user-email). It uses a
// NON-localhost URL so resolveActor does not short-circuit to a development-preview superuser, and it
// sets NO UAT env flag so the staging sign-in path never authenticates and no fixtures are seeded.
// ---------------------------------------------------------------------------
installWorkersHooks("__FINCC_DB__", "__FINCC_ENV__");

function makeD1(sqlite) {
  // Uses the transactional D1 shim (BEGIN/COMMIT/ROLLBACK) from helpers/d1.mjs so a
  // failing batch() rolls back, exactly as Cloudflare D1 does.
  return createD1(sqlite);
}

const MAKER_A = "maker.a@pawspace.in";
const APPROVER_B = "approver.b@pawspace.in";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__FINCC_DB__ = makeD1(sqlite);
  globalThis.__FINCC_ENV__ = {}; // NO PAWSPACE_UAT_LOGIN — non-UAT / production-bound.
  // Two distinct finance staff. resolveActor's ensureSecurityTables creates this table IF NOT EXISTS and
  // upserts the "finance" role definition (which carries finance.manage), so pre-seeding rows here is
  // enough for both identities to authenticate.
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-a", MAKER_A, "Maker A", "finance", "active");
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-b", APPROVER_B, "Approver B", "finance", "active");
  return sqlite;
}

const route = await import("../app/api/finance-control/route.ts");

const URL_BASE = "https://finance.pawspace.in/api/finance-control";
const as = (email, init = {}) => new Request(URL_BASE, { ...init, headers: { ...(init.headers || {}), "oai-authenticated-user-email": email } });
const anon = (init = {}) => new Request(URL_BASE, init);

async function createExpense(email, overrides = {}) {
  const res = await route.POST(as(email, {
    method: "POST",
    body: JSON.stringify({ entity: "expense", expenseDate: "2026-08-10", merchant: "Maker Checker Co", category: "Travel & fuel", amount: 5000, gstAmount: 762, ...overrides }),
  }));
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function approve(email, id, reason) {
  const res = await route.PATCH(as(email, {
    method: "PATCH",
    body: JSON.stringify({ entity: "expense", id, action: "approve", reason }),
  }));
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
const journalCount = (sqlite, id) => sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries WHERE source_id=?").get(id).c;

// ---------------------------------------------------------------------------
// Finding 8 — identity-based maker/checker + idempotent approve.
// ---------------------------------------------------------------------------

test("(a) maker A creates, a DIFFERENT finance user B approves -> success and one balanced journal pair", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A);
  assert.equal(created.status, 201, `maker A create should succeed: ${JSON.stringify(created.body)}`);
  const expenseId = created.body.data.id;

  const before = journalCount(sqlite, expenseId);
  assert.equal(before, 0, "no journal lines before approval");

  const approved = await approve(APPROVER_B, expenseId, "approving as a different finance checker");
  assert.equal(approved.status, 200, `approver B should be allowed: ${JSON.stringify(approved.body)}`);
  assert.equal(approved.body.data.status, "approved");
  assert.equal(journalCount(sqlite, expenseId), 2, "one balanced pair (2 lines) posted");

  // The recorded creator is the authenticated maker, not a client string.
  const row = sqlite.prepare("SELECT created_by FROM finance_expenses WHERE id=?").get(expenseId);
  assert.equal(row.created_by, MAKER_A, "created_by records the authenticated maker");
});

test("(b) maker A approving their OWN item -> 403, identity-based, no journal posted", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A);
  const expenseId = created.body.data.id;

  const selfApprove = await approve(MAKER_A, expenseId, "trying to approve my own expense");
  assert.equal(selfApprove.status, 403, "self-approval must be refused on identity, not on a client field");
  assert.match(selfApprove.body.error, /Maker cannot approve their own transaction/);
  assert.equal(journalCount(sqlite, expenseId), 0, "a refused self-approval posts nothing");

  // The row is still open for a legitimate checker.
  const row = sqlite.prepare("SELECT status FROM finance_expenses WHERE id=?").get(expenseId);
  assert.equal(row.status, "submitted", "self-approval did not advance the status");
});

test("(c) replaying B's identical approve does NOT duplicate the journal", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A);
  const expenseId = created.body.data.id;

  const r1 = await approve(APPROVER_B, expenseId, "first approval by checker B");
  assert.equal(r1.status, 200);
  const after1 = journalCount(sqlite, expenseId);
  assert.equal(after1, 2, "first approve posts one balanced pair");

  // Exact replay of B's approve.
  const r2 = await approve(APPROVER_B, expenseId, "first approval by checker B");
  const after2 = journalCount(sqlite, expenseId);
  assert.equal(after2, 2, `replay must NOT double-post — expected 2 lines, got ${after2}`);
  assert.notEqual(r2.status, 500, "the replay must not error out");
});

test("(b') a client body.actorRole field can no longer authorize or gate anything", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A);
  const expenseId = created.body.data.id;

  // Maker A spoofs actorRole='checker'. Identity still says A is the creator -> still refused.
  const res = await route.PATCH(as(MAKER_A, {
    method: "PATCH",
    body: JSON.stringify({ entity: "expense", id: expenseId, action: "approve", reason: "spoofing checker role", actorRole: "checker" }),
  }));
  assert.equal(res.status, 403, "spoofing actorRole cannot bypass identity-based segregation");
  assert.equal(journalCount(sqlite, expenseId), 0);
});

test("audit rows record the real authenticated actor, never a hardcoded constant", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A);
  const expenseId = created.body.data.id;
  await approve(APPROVER_B, expenseId, "approved by checker B for audit");

  const actors = sqlite.prepare("SELECT DISTINCT actor_id FROM finance_audit_events ORDER BY actor_id").all().map((r) => r.actor_id);
  assert.ok(actors.includes(MAKER_A), "creation audited under the maker");
  assert.ok(actors.includes(APPROVER_B), "approval audited under the approver");
  assert.ok(!actors.includes("finance_uat"), "no hardcoded finance_uat actor");
});

test("unauthenticated POST/PATCH are refused (401) — identity is server-derived", async () => {
  freshDb();
  const post = await route.POST(anon({ method: "POST", body: JSON.stringify({ entity: "expense", expenseDate: "2026-08-10", merchant: "X", category: "Travel & fuel", amount: 10 }) }));
  assert.equal(post.status, 401, "no forwarded identity -> 401");
  const patch = await route.PATCH(anon({ method: "PATCH", body: JSON.stringify({ entity: "expense", id: "whatever", action: "approve", reason: "no identity here" }) }));
  assert.equal(patch.status, 401);
});

// ---------------------------------------------------------------------------
// Finding 9 — no synthetic fixtures without the staging UAT flag.
// ---------------------------------------------------------------------------

const absent = (sqlite) => {
  const vendor = sqlite.prepare("SELECT COUNT(*) c FROM finance_vendors WHERE id IN ('ven_fuel','ven_food','ven_software')").get().c;
  const expense = sqlite.prepare("SELECT COUNT(*) c FROM finance_expenses WHERE id IN ('exp_1001','exp_1002')").get().c;
  const bill = sqlite.prepare("SELECT COUNT(*) c FROM finance_bills WHERE id='bill_2001'").get().c;
  const period = sqlite.prepare("SELECT COUNT(*) c FROM finance_close_periods WHERE period_code='2026-07'").get().c;
  return { vendor, expense, bill, period };
};

test("GET on an empty DB with no UAT flag inserts ZERO synthetic fixtures", async () => {
  const sqlite = freshDb();
  // GET is gated on finance.view (which the seeded finance role holds), so it presents a real finance
  // identity — the Finding-9 assertion (no fixtures on an empty DB) is unchanged.
  const res = await route.GET(as(APPROVER_B));
  assert.equal(res.status, 200, "GET still works against an empty/real DB");
  const { vendor, expense, bill, period } = absent(sqlite);
  assert.equal(vendor, 0, "no ven_fuel/ven_food/ven_software");
  assert.equal(expense, 0, "no exp_1001/exp_1002");
  assert.equal(bill, 0, "no bill_2001");
  assert.equal(period, 0, "no 2026-07 close period");
});

test("a normal POST (as an authenticated maker) seeds no fixtures — only the row it creates", async () => {
  const sqlite = freshDb();
  const created = await createExpense(MAKER_A, { merchant: "Sole Real Row" });
  assert.equal(created.status, 201);
  const { vendor, expense, bill, period } = absent(sqlite);
  assert.equal(vendor + bill + period, 0, "no synthetic vendor/bill/period fixtures from a POST");
  // exp_1001/exp_1002 absent; the one real expense uses a generated id, not a fixture id.
  assert.equal(expense, 0, "no exp_1001/exp_1002 fixtures");
  const total = sqlite.prepare("SELECT COUNT(*) c FROM finance_expenses").get().c;
  assert.equal(total, 1, "exactly the one real row created");
});

test("a PATCH against an empty DB seeds no fixtures", async () => {
  const sqlite = freshDb();
  const res = await route.PATCH(as(APPROVER_B, { method: "PATCH", body: JSON.stringify({ entity: "expense", id: "does_not_exist", action: "approve", reason: "trigger any seed path via patch" }) }));
  assert.equal(res.status, 404, "unknown id 404s — but the point is no seeding happened");
  const { vendor, expense, bill, period } = absent(sqlite);
  assert.equal(vendor + expense + bill + period, 0, "PATCH seeded no named fixtures");
});
