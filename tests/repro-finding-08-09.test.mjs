/**
 * REPRODUCTION (EXACT main @ 1240359) — do not fix, evidence only.
 *
 * FINDING 8 (P1 FINANCE): Maker/checker segregation is client-controlled. The PATCH mutation handler in
 *   app/api/finance-control/route.ts refuses approval ONLY when the caller sends the literal
 *   body.actorRole==="maker". Actor identity is never server-derived (no resolveActor/authorize), so the
 *   creator of a transaction can approve it by omitting/altering actorRole -> self-approval.
 *
 * FINDING 9 (P1/P2 FINANCE DATA): GET/POST/PATCH each call seed(db), inserting named synthetic
 *   vendors/expenses/bills/close-period fixtures into whichever D1 the route uses, with NO env guard.
 *   Runs here with NO UAT/staging flag set and the fixtures still land.
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

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__FIN_DB__ = makeD1(sqlite);
  globalThis.__FIN_ENV__ = {}; // NO UAT/staging env flag of any kind
  return sqlite;
}

const route = await import("../app/api/finance-control/route.ts");

// ---------------------------------------------------------------------------------------------------
// FINDING 8 — maker == approver self-approval is possible; actor identity not server-derived
// ---------------------------------------------------------------------------------------------------

test("FINDING 8(a): creator can approve their own expense by OMITTING body.actorRole (self-approval succeeds)", async () => {
  freshDb();

  // Actor "maker" creates an expense via POST. POST takes NO server-derived actor at all; the creator
  // is whoever calls it. There is nothing recording who may later approve.
  const createRes = await route.POST(new Request("http://x/api/finance-control", {
    method: "POST",
    body: JSON.stringify({
      entity: "expense", expenseDate: "2026-08-10", merchant: "Self Approve Test",
      category: "Travel & fuel", amount: 5000, gstAmount: 762, claimant: "Same Person",
    }),
  }));
  assert.equal(createRes.status, 201, "expense create should succeed");
  const { data: created } = await createRes.json();
  const expenseId = created.id;
  assert.ok(expenseId, "created expense id");

  // The SAME person now approves it. We OMIT body.actorRole entirely. The server has no idea who is
  // calling and never derives it — so this must NOT be blocked by the maker/checker rule.
  const approveRes = await route.PATCH(new Request("http://x/api/finance-control", {
    method: "PATCH",
    body: JSON.stringify({
      entity: "expense", id: expenseId, action: "approve",
      reason: "approving my own expense with no actorRole",
      // actorRole intentionally OMITTED — server-derived identity would catch this; it does not.
    }),
  }));
  assert.equal(approveRes.status, 200, "SELF-APPROVAL SUCCEEDED — approval returned 200");
  const { data: approved } = await approveRes.json();
  assert.equal(approved.status, "approved", "expense self-approved to status=approved");

  console.log("FINDING 8(a) EVIDENCE: self-approval (no actorRole) ->", JSON.stringify(approved));
});

test("FINDING 8(a'): sending actorRole='checker' (any non-'maker' value) also self-approves", async () => {
  freshDb();
  const createRes = await route.POST(new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ entity: "expense", expenseDate: "2026-08-10", merchant: "Spoof Role", category: "Travel & fuel", amount: 1234 }),
  }));
  const { data: created } = await createRes.json();

  // The maker simply lies about their role. The handler only string-compares to "maker".
  const res = await route.PATCH(new Request("http://x", {
    method: "PATCH",
    body: JSON.stringify({ entity: "expense", id: created.id, action: "approve", reason: "spoofing role", actorRole: "checker" }),
  }));
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.status, "approved");
  console.log("FINDING 8(a') EVIDENCE: actorRole='checker' spoof approved ->", JSON.stringify(data));
});

test("FINDING 8(a''): the ONLY guard is body.actorRole==='maker' — sending it verbatim is the sole refusal path", async () => {
  freshDb();
  const createRes = await route.POST(new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ entity: "expense", expenseDate: "2026-08-10", merchant: "Honest Maker", category: "Travel & fuel", amount: 999 }),
  }));
  const { data: created } = await createRes.json();

  const res = await route.PATCH(new Request("http://x", {
    method: "PATCH",
    body: JSON.stringify({ entity: "expense", id: created.id, action: "approve", reason: "honest self-declare", actorRole: "maker" }),
  }));
  assert.equal(res.status, 403, "the literal string 'maker' is the ONLY thing that is refused — trivially avoidable");
  console.log("FINDING 8(a'') EVIDENCE: only literal actorRole='maker' is blocked -> status 403");
});

test("FINDING 8(b): PATCH handler never calls resolveActor/authorize — actor identity is not server-derived", () => {
  // Prove the mutation handler derives NO server-side actor. The audit row hardcodes actor_id='finance_uat'.
  assert.doesNotMatch(ROUTE_SRC, /resolveActor/, "no resolveActor anywhere in the route");
  assert.doesNotMatch(ROUTE_SRC, /\bauthorize\b/, "no authorize() call in the route");
  assert.doesNotMatch(ROUTE_SRC, /getSession|requireUser|currentUser|actorFrom|verifyToken|auth\(/, "no auth/session resolution");
  // The only role signal is the client-supplied field:
  assert.match(ROUTE_SRC, /body\.actorRole==="maker"/, "the sole segregation check is a string compare on client body.actorRole");
  // audit() hardcodes the actor — identity is a constant, not the caller:
  assert.match(ROUTE_SRC, /actor_id,reason,created_at\) VALUES[\s\S]*?'finance_uat'/, "audit actor_id is hardcoded 'finance_uat', never the real caller");
  console.log("FINDING 8(b) EVIDENCE: no resolveActor/authorize; only guard is body.actorRole==='maker'; audit actor_id hardcoded 'finance_uat'");
});

test("FINDING 8(c): approve is NON-idempotent — a replayed identical approve DOUBLE-POSTS the journal", async () => {
  const sqlite = freshDb();
  const createRes = await route.POST(new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ entity: "expense", expenseDate: "2026-08-10", merchant: "Replay Test", category: "Travel & fuel", amount: 7000 }),
  }));
  const { data: created } = await createRes.json();
  const approveBody = JSON.stringify({ entity: "expense", id: created.id, action: "approve", reason: "first approval of replay" });

  const r1 = await route.PATCH(new Request("http://x", { method: "PATCH", body: approveBody }));
  assert.equal(r1.status, 200);
  const after1 = sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries WHERE source_id=?").get(created.id).c;

  // Replay the EXACT same approve. No idempotency key, no status guard on re-approve.
  const r2 = await route.PATCH(new Request("http://x", { method: "PATCH", body: approveBody }));
  assert.equal(r2.status, 200, "the replay is accepted again");
  const after2 = sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries WHERE source_id=?").get(created.id).c;

  assert.equal(after1, 2, "first approve posted one balanced pair (2 lines)");
  assert.equal(after2, 4, "REPLAY double-posted the journal — now 4 lines for one expense");
  console.log(`FINDING 8(c) EVIDENCE: journal lines after 1st approve=${after1}, after identical replay=${after2} (double-posted)`);
});

// ---------------------------------------------------------------------------------------------------
// FINDING 9 — seed() fires on GET/POST/PATCH with NO env guard, in non-UAT mode
// ---------------------------------------------------------------------------------------------------

const NAMED_VENDORS = ["ven_fuel", "ven_food", "ven_software"];
const NAMED_EXPENSES = ["exp_1001", "exp_1002"];
const NAMED_BILL = "bill_2001";
const NAMED_PERIOD = "2026-07";

test("FINDING 9: GET on an EMPTY db with NO UAT/staging env flag still inserts the named synthetic fixtures", async () => {
  const sqlite = freshDb(); // __FIN_ENV__ = {}  => no PAWSPACE_UAT_LOGIN, no NODE_ENV, nothing
  assert.equal(globalThis.__FIN_ENV__.PAWSPACE_UAT_LOGIN, undefined, "no UAT login flag set");
  assert.equal(globalThis.__FIN_ENV__.NODE_ENV, undefined, "no NODE_ENV set");

  const res = await route.GET();
  assert.equal(res.status, 200);
  const { data } = await res.json();

  const vendorIds = data.vendors.map((v) => v.id).sort();
  const expenseIds = data.expenses.map((e) => e.id).sort();
  const billIds = data.bills.map((b) => b.id);
  const periodCodes = data.periods.map((p) => p.period_code);

  for (const v of NAMED_VENDORS) assert.ok(vendorIds.includes(v), `synthetic vendor ${v} inserted with no env guard`);
  for (const e of NAMED_EXPENSES) assert.ok(expenseIds.includes(e), `synthetic expense ${e} inserted with no env guard`);
  assert.ok(billIds.includes(NAMED_BILL), `synthetic bill ${NAMED_BILL} inserted`);
  assert.ok(periodCodes.includes(NAMED_PERIOD), `synthetic close period ${NAMED_PERIOD} inserted`);

  // Confirm named business strings landed too (not just ids).
  const shell = sqlite.prepare("SELECT name,gstin FROM finance_vendors WHERE id='ven_fuel'").get();
  assert.equal(shell.name, "Shell Fleet Services");
  assert.equal(shell.gstin, "29AAACS0001A1Z5");
  console.log(`FINDING 9 EVIDENCE (GET, no env flag): vendors=${JSON.stringify(vendorIds)} expenses=${JSON.stringify(expenseIds)} bills=${JSON.stringify(billIds)} periods=${JSON.stringify(periodCodes)}`);
});

test("FINDING 9: POST also seeds — fixtures present even when caller only creates one unrelated row", async () => {
  const sqlite = freshDb();
  await route.POST(new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ entity: "expense", expenseDate: "2026-08-10", merchant: "Unrelated", category: "Travel & fuel", amount: 100 }),
  }));
  const vendorCount = sqlite.prepare("SELECT COUNT(*) c FROM finance_vendors WHERE id IN ('ven_fuel','ven_food','ven_software')").get().c;
  assert.equal(vendorCount, 3, "POST->seed() injected all 3 named vendors into a non-UAT db");
  console.log("FINDING 9 EVIDENCE (POST): 3 named synthetic vendors present after a single unrelated POST");
});

test("FINDING 9: PATCH also seeds — fixtures present after a PATCH against a fresh non-UAT db", async () => {
  const sqlite = freshDb();
  // PATCH will 404 the unknown id, but seed(db) has already run before the entity branch.
  await route.PATCH(new Request("http://x", {
    method: "PATCH",
    body: JSON.stringify({ entity: "expense", id: "does_not_exist", action: "approve", reason: "trigger seed via patch" }),
  }));
  const expCount = sqlite.prepare("SELECT COUNT(*) c FROM finance_expenses WHERE id IN ('exp_1001','exp_1002')").get().c;
  assert.equal(expCount, 2, "PATCH->seed() injected the named synthetic expenses into a non-UAT db");
  console.log("FINDING 9 EVIDENCE (PATCH): named synthetic expenses exp_1001/exp_1002 present after a PATCH");
});

test("FINDING 9: source proof — GET/POST/PATCH each call seed(); NO env var gates it", () => {
  // Every entry point unconditionally seeds.
  assert.match(ROUTE_SRC, /export async function GET\(\)\{try\{const db=await database\(\);await seed\(db\);/, "GET calls seed()");
  assert.match(ROUTE_SRC, /export async function POST\(request:Request\)\{try\{const db=await database\(\);await seed\(db\);/, "POST calls seed()");
  assert.match(ROUTE_SRC, /export async function PATCH\(request:Request\)\{try\{const db=await database\(\);await seed\(db\);/, "PATCH calls seed()");
  // No environment gate anywhere near seeding / in the route at all.
  assert.doesNotMatch(ROUTE_SRC, /PAWSPACE_UAT_LOGIN/, "no PAWSPACE_UAT_LOGIN gate");
  assert.doesNotMatch(ROUTE_SRC, /NODE_ENV/, "no NODE_ENV gate");
  assert.doesNotMatch(ROUTE_SRC, /process\.env/, "no process.env gate");
  assert.doesNotMatch(ROUTE_SRC, /\bstaging\b|isUat|allowSeed|SEED_ENABLED/i, "no UAT/staging/seed toggle");
  // database() reads only env.DB — nothing else from env is consulted.
  assert.match(ROUTE_SRC, /async function database\(\)\{const \{env\}=await import\("cloudflare:workers"\);return env\.DB;\}/, "database() returns env.DB only; no env-based seed gate");
  console.log("FINDING 9 EVIDENCE (source): GET/POST/PATCH all call seed(db) unconditionally; zero env guard (no PAWSPACE_UAT_LOGIN/NODE_ENV/process.env/staging)");
});
