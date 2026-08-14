import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// =============================================================================
// PHASE 2 REPRODUCTION — D9 (P2): finance-control approve is only *sequentially* idempotent.
// `app/api/finance-control/route.ts:45` uses `group=id("journal")` (random per call) and decides
// `shouldPost` from a STALE SELECT before an unconditional `UPDATE ... WHERE id=?` — no transaction,
// no `WHERE status NOT IN('approved','paid')`, no deterministic (PK-collision-safe) journal key. Two
// concurrent approves of the same `submitted` row can both post a balanced pair → double GL.
// The shared `lib/finance-accounts.ts postJournal` uses a DETERMINISTIC key (safe) — not used here.
//
// CONFIRMED (deterministic): the structural gap (random key + stale-read TOCTOU, no atomic claim).
// CONFIRMED (executed, this runtime): unlike a serialised race, Promise.all of two approve() calls DOES
// interleave here — the two async SELECTs both resolve on the stale 'submitted' row before either UPDATE,
// so BOTH post. Observed a stable 4 journal lines (two balanced pairs) across repeated runs — a genuine
// double-post. (On a runtime that serialised to 2, the structural CONFIRMED evidence still stands.)
// Run against the PRE-FIX SHA ca09d06.
// =============================================================================
installWorkersHooks("__FIND9_DB__", "__FIND9_ENV__");

function makeD1(sqlite) {
  const s = (sql, args) => ({
    bind: (...b) => s(sql, b),
    first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => s(sql, []), batch: async (l) => { const o = []; for (const it of l) o.push(await it.run()); return o; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const MAKER_A = "maker.a@pawspace.in";
const APPROVER_C = "approver.c@pawspace.in";
function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__FIND9_DB__ = makeD1(sqlite);
  globalThis.__FIND9_ENV__ = {}; // no PAWSPACE_UAT_LOGIN — production-bound, no fixtures
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-a", MAKER_A, "Maker A", "finance", "active");
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-c", APPROVER_C, "Approver C", "finance", "active");
  return sqlite;
}
const URL_BASE = "https://finance.pawspace.in/api/finance-control";
const as = (email, init = {}) => new Request(URL_BASE, { ...init, headers: { ...(init.headers || {}), "oai-authenticated-user-email": email } });
const route = await import("../app/api/finance-control/route.ts");
async function createExpense(email) {
  const res = await route.POST(as(email, { method: "POST", body: JSON.stringify({ entity: "expense", expenseDate: "2026-08-10", merchant: "Race Co", category: "Travel & fuel", amount: 5000, gstAmount: 762 }) }));
  return (await res.json().catch(() => null))?.data?.id;
}
const approve = (email, id) => route.PATCH(as(email, { method: "PATCH", body: JSON.stringify({ entity: "expense", id, action: "approve", reason: "concurrent approve probe" }) }));
const journalLines = (sqlite, id) => sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries WHERE source_id=?").get(id).c;

// ---- CONFIRMED (source): random journal key + stale-read TOCTOU, no atomic claim, not the deterministic poster ----
test("D9 REPRODUCED (source) — approve posts via a RANDOM journal group id with no atomic status-claim", () => {
  const src = read("app/api/finance-control/route.ts");
  assert.match(src, /group=id\("journal"\)/, "journal group id is random per call (id(...)), so a duplicate post cannot collide on a deterministic PK");
  assert.match(src, /shouldPost=body\.action==="approve"&&row\.status!=="approved"&&row\.status!=="paid"/, "shouldPost is computed from a prior SELECT snapshot (row.status)");
  // The write that flips status is unconditional (WHERE id=?), NOT an atomic claim gating the post.
  assert.match(src, /UPDATE finance_expenses SET status=\?,updated_at=\? WHERE id=\?/, "status UPDATE is unconditional WHERE id=?");
  assert.doesNotMatch(src, /status NOT IN\s*\(/, "no `WHERE status NOT IN('approved','paid')` atomic claim guards the post");
  assert.doesNotMatch(src, /finance-accounts/, "does not route through the shared deterministic postJournal");
  // Contrast: the shared poster IS deterministic / PK-collision-safe.
  assert.match(read("lib/finance-accounts.ts"), /JRN-|groupKey|source/i, "lib/finance-accounts.ts postJournal derives a deterministic journal id");
});

// ---- SECURE INVARIANT (post-fix gate): approve must be concurrency-safe by construction ----
test("D9 SECURE INVARIANT (post-fix gate) — approve must use an atomic status-claim OR a deterministic journal key", () => {
  const src = read("app/api/finance-control/route.ts");
  const hasAtomicClaim = /UPDATE finance_(expenses|bills) SET status='approved'[^;]*status NOT IN|WHERE id=\?[^;]*AND status NOT IN\s*\('approved','paid'\)/.test(src);
  const hasDeterministicKey = /group=`?(expense|bill|journal)[-_]\$\{|group=`journal-\$\{|sourceType.*sourceId.*journal/.test(src) || /const group=`[^`]*\$\{sourceId\}/.test(src);
  // Expected after remediation: one of these guarantees one-post-per-approval under concurrency.
  // FAILS on ca09d06 (random key + stale-read), passes once the approve is made atomic/deterministic.
  assert.ok(hasAtomicClaim || hasDeterministicKey,
    "SECURE INVARIANT VIOLATED on ca09d06 — approve has neither an atomic status-claim nor a deterministic journal key");
});

// ---- Execution (honest observation): node:sqlite serialises, so the sequential guard likely holds ----
test("D9 execution — sequential replay is already guarded on ca09d06 (finding #8): a re-approve posts no 2nd pair", async () => {
  const sqlite = freshDb();
  const id = await createExpense(MAKER_A);
  assert.ok(id, "expense created");
  await approve(APPROVER_C, id);
  await approve(APPROVER_C, id); // sequential replay
  assert.equal(journalLines(sqlite, id), 2, "sequential replay stays at one balanced pair (the #8 fix)");
});

test("D9 REPRODUCED (executed) — concurrent approves interleave and DOUBLE-POST the journal", async () => {
  const sqlite = freshDb();
  const id = await createExpense(MAKER_A);
  const results = await Promise.all([approve(APPROVER_C, id), approve(APPROVER_C, id)]);
  const statuses = results.map((r) => r.status);
  const lines = journalLines(sqlite, id);
  // Observed here: both approves return 200 and 4 journal lines are posted (two balanced pairs) for ONE
  // logical approval — a genuine double-post, stable across runs. Non-flaky guard (>=2, even) documents
  // the reality; the >2 assertion is the executed reproduction on this runtime.
  console.error(`[D9] concurrent approves -> HTTP ${JSON.stringify(statuses)}, journal lines = ${lines} (2=serialised, 4=double-post)`);
  assert.ok(lines >= 2 && lines % 2 === 0, "journal posts in balanced pairs");
  assert.ok(lines > 2, `EXECUTED double-post reproduced: one approval produced ${lines} journal lines (expected a single pair of 2)`);
});
