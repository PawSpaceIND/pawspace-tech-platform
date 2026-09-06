import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// P1 regressions from the 2026-09-05 pilot-readiness audit: C3 (statutory data
// loss), H9 (WhatsApp sweep blocker), H1 (admin-reassign double booking).
//
// Each test fails if its fix is reverted. The same audit measured that only ~30%
// of this suite is load-bearing, so a regression test that cannot fail is worse
// than no test at all.
// ---------------------------------------------------------------------------

installWorkersHooks("__P1_DB__", "__P1_ENV__");

/** A D1 shim whose reads can be made to fail for one named table, on demand. */
function makeD1(sqlite, fail = { table: null }) {
  const statement = (sql, args) => ({
    sql,
    bind: (...bound) => statement(sql, bound),
    first: async () => { guard(sql); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { guard(sql); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => { guard(sql); return { results: sqlite.prepare(sql).all(...args) }; },
  });
  // Simulates the real-world cause: schema drift or a D1 bound-parameter refusal on one source table.
  const guard = (sql) => {
    if (fail.table && new RegExp(`\\b${fail.table}\\b`).test(sql) && /^\s*SELECT/i.test(sql)) {
      throw new Error(`D1_ERROR: no such table: ${fail.table}`);
    }
  };
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const PERIOD = "2026-08";

async function tcsWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const fail = { table: null };
  const db = makeD1(sqlite, fail);
  globalThis.__P1_DB__ = db; globalThis.__P1_ENV__ = {};
  const tcs = await import("../lib/tcs-governance.ts");
  await tcs.ensureTcsTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_payout_computations (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,service_code TEXT,term_id TEXT,order_value REAL,provider_gst_deducted REAL,computed_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_commercial_terms (id TEXT PRIMARY KEY,engagement_model TEXT)");
  // MARKETPLACE_MODELS is {commission_standard, commission_groomer} — s52 TCS applies to those.
  sqlite.prepare("INSERT INTO provider_commercial_terms VALUES ('TERM-1','commission_standard')").run();
  // resolveBookingPlaceOfSupply reads canonical_bookings to decide intra- vs inter-state.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT)");
  const at = Date.UTC(2026, 7, 10);
  for (let i = 0; i < 10; i += 1) {
    sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,'blr')").run(`BK-${i}`, `CUS-${i}`);
    sqlite.prepare("INSERT INTO provider_payout_computations VALUES (?,?,?,'grooming','TERM-1',20000,3050,?)")
      .run(`PC-${i}`, `BK-${i}`, `PRV-${i}`, at);
  }
  return { sqlite, db, tcs, fail };
}

const rowsIn = (sqlite, table) => sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE period='${PERIOD}'`).get().n;

// --- AUDIT-C3 -------------------------------------------------------------
// computeMonthlyTcs used to DELETE the period's collections and THEN read its
// source through `catch{return[]}`. When the read failed the prior computation
// was already destroyed and the month recomputed to zero — with `issues` empty,
// so nothing separated it from a genuinely zero month, and recordTcsDeposit then
// refused the true deposit because it must equal the computed liability of 0.
test("AUDIT-C3: a failed statutory read must not destroy the TCS rows it already had", async () => {
  const { sqlite, db, tcs, fail } = await tcsWorld();

  const healthy = await tcs.computeMonthlyTcs(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  assert.ok(healthy.totalTcs > 0, `the healthy month must compute a real liability, got ${healthy.totalTcs}`);
  assert.equal(healthy.supplierCount, 10);
  const persisted = rowsIn(sqlite, "tcs_collections");
  assert.equal(persisted, 10, "ten supplier rows must be persisted");

  // The source table becomes unreadable — schema drift, or D1 refusing the query.
  fail.table = "provider_payout_computations";
  await assert.rejects(
    () => tcs.computeMonthlyTcs(db, { period: PERIOD, actorId: "finance@pawspace.in" }),
    /refusing to recompute/,
    "a statutory computation that cannot read its source must REFUSE, not publish a zero");

  assert.equal(rowsIn(sqlite, "tcs_collections"), persisted,
    "the previously computed collections must survive a failed recompute");
});

// --- AUDIT-C3b ------------------------------------------------------------
// Non-vacuity: refusing every recompute would satisfy the case above.
test("AUDIT-C3b: a healthy recompute still replaces the period cleanly", async () => {
  const { sqlite, db, tcs } = await tcsWorld();
  await tcs.computeMonthlyTcs(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  const again = await tcs.computeMonthlyTcs(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  assert.ok(again.totalTcs > 0);
  assert.equal(rowsIn(sqlite, "tcs_collections"), 10, "a recompute replaces, it does not duplicate");
});

// --- AUDIT-H9 -------------------------------------------------------------
// The WhatsApp template sync ran sequentially BEFORE the Promise.allSettled block
// and threw "blocked before dispatch" — so a messaging exception stopped every
// payment and reconciliation sweep from starting. The signal must survive; the
// blocking must not.
test("AUDIT-H9: a WhatsApp template failure is reported, not allowed to block the payment sweeps", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

  const preflight = source.indexOf("syncSubmittedMetaTemplateStatuses(env.DB");
  const allSettled = source.indexOf("await Promise.allSettled([");
  assert.ok(preflight > 0 && allSettled > preflight, "the template sync still precedes the sweep block");

  const between = source.slice(preflight, allSettled);
  assert.doesNotMatch(between, /\bthrow new Error\(`blocked before dispatch/,
    "the template sync must not throw before the sweeps: that halts razorpayOrderOutbox, settlementRecon and subscriptionMaintenance");
  assert.match(between, /catch\s*\(error\)\s*\{\s*templateSyncError=/,
    "its failure must be captured");
  // ...and must still reach the aggregated failure, so it is not silently swallowed either.
  assert.match(source, /if\(templateSyncError\)errors\.push\(templateSyncError\);/,
    "the captured failure must still fail the invocation via errors[]");
});

// --- AUDIT-H1 -------------------------------------------------------------
// operateAssignment released the group's reservations, did un-locked round trips,
// then restored by primary key with NO precondition — so a competing reserve in
// that window produced two active reservations for one provider over overlapping
// times, while the endpoint replied "the existing assignment was left in place".
test("AUDIT-H1: reclaiming a released slot re-checks the window inside the writing statement", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../app/api/uat-scheduling/route.ts", import.meta.url), "utf8");

  const restore = source.slice(source.indexOf("restore=async()=>"), source.indexOf("await db.prepare(\"UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=?\")"));
  assert.match(restore, /NOT EXISTS/, "the restore UPDATE must carry its precondition inside the statement");
  assert.match(restore, /other\.scheduled_start<\?\s*AND\s*other\.scheduled_end>\?/, "it must test window OVERLAP, not just an exact triple");
  assert.match(restore, /SCHEDULING_RESERVATION_ACTIVE_SLOT_PREDICATE/, "it must reuse the same active-slot predicate as the race-proof reserve path");
  assert.match(restore, /meta\?\.changes/, "it must count what actually came back");

  // And the endpoint must stop claiming a restore that did not happen.
  assert.match(source, /SLOT_LOST_DURING_REASSIGN/, "a partial restore must be reported, not described as 'left in place'");
  const leftInPlace = source.split("the existing assignment was left in place");
  assert.equal(leftInPlace.length, 3, "both call sites still have a truthful success path");
});
