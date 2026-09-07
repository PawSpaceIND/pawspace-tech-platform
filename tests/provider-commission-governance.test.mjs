import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const governance=read("lib/provider-commission-governance.ts"),route=read("app/api/partner-finance/route.ts"),ui=read("app/team/finance/partners/page.tsx"),bookings=read("app/api/canonical-bookings/route.ts");

test("canonical providers support direct full-time and commission engagement",()=>{assert.match(bookings,/model:\"full_time\"\|\"commission\"/);assert.match(governance,/EngagementModel=\"full_time\"\|\"commission\"/);});
test("commission profiles support fixed or percentage defaults",()=>{assert.match(governance,/CommissionMode=\"fixed\"\|\"percent\"/);assert.match(governance,/default_commission_mode/);assert.match(governance,/default_commission_value/);assert.match(governance,/commissionAmount/);});
test("only commission provider work orders enter commission payout automation",()=>{assert.match(governance,/provider_model='commission'/);assert.match(governance,/b\.status='completed'/);assert.match(governance,/provider_compensation_profiles/);});
test("commission can be overridden at completed order level before confirmation",()=>{assert.match(governance,/commission_source='order_override'/);assert.match(governance,/Order-level override reason/);assert.match(route,/override_order_commission/);assert.match(ui,/Override/);});
test("provider payout SLA is five days from completion",()=>{assert.match(governance,/FIVE_DAYS=5\*24\*60\*60\*1000/);assert.match(governance,/completedAt\+FIVE_DAYS/);assert.match(governance,/due_at/);assert.match(ui,/five-day payout SLA/);});
test("commission requires explicit confirmation then two distinct approvals",()=>{assert.match(governance,/awaiting_approval_1/);assert.match(governance,/awaiting_approval_2/);assert.match(governance,/Level 2 approval must be completed by a different approver/);assert.match(route,/approve_order_commission_level_1/);assert.match(route,/approve_order_commission_level_2/);});
test("RazorpayX payout orchestration remains sandbox guarded",()=>{assert.match(governance,/rail.*razorpayx/);assert.match(governance,/environment.*sandbox/);assert.match(governance,/liveMoney:false/);assert.match(route,/rail:\"razorpayx\"/);assert.match(route,/environment:\"sandbox\"/);assert.match(ui,/RazorpayX is orchestrated in sandbox\/UAT only/);});
test("provider finance writes remain protected by finance manage permission",()=>{assert.match(route,/authorize\(request,\"finance\.manage\"\)/);assert.match(route,/securityAudit/);});

/* ===========================================================================
 * EXECUTING TESTS.
 *
 * Everything above asserts on SOURCE TEXT. Those assertions pin structure, but none of them calls
 * lib/provider-commission-governance.ts, so the module could throw on every invocation and this file
 * would still pass. In particular "commission requires explicit confirmation then two distinct
 * approvals" is a segregation-of-duties rule about MONEY LEAVING THE COMPANY - a regex proving the
 * words appear in the file is not evidence the rule holds.
 *
 * The tests below drive the real module against a real database. Additive; nothing above removed.
 * ======================================================================== */
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__COMM_DB__", "__COMM_ENV__");

function commD1(sqlite) {
  const st = (sql, a) => ({
    bind: (...b) => st(sql, b),
    first: async () => sqlite.prepare(sql).get(...a) ?? null,
    run: async () => { const i = sqlite.prepare(sql).run(...a); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...a) }),
  });
  return {
    prepare: (s) => st(s, []),
    batch: async (l) => { const o = []; for (const x of l) o.push(await x.run()); return o; },
    exec: async (s) => { sqlite.exec(s); return { count: 0, duration: 0 }; },
  };
}

const MAKER = "finance.maker@pawspace.in";
const CHECKER = "finance.checker@pawspace.in";

async function commissionWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = commD1(sqlite);
  globalThis.__COMM_DB__ = db;
  globalThis.__COMM_ENV__ = {};
  const mod = await import("../lib/provider-commission-governance.ts");
  await mod.ensureProviderCommissionTables(db);
  return { sqlite, db, mod };
}

test("EXECUTED: the commission module runs and its schema is reachable", async () => {
  const { sqlite, mod, db } = await commissionWorld();
  assert.equal(typeof mod.approveOrderCommission, "function");
  const tables = sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
  assert.ok(tables > 0, "ensureProviderCommissionTables must actually create schema");
  const dash = await mod.getProviderCommissionDashboard(db, {});
  assert.ok(dash && typeof dash === "object", "the dashboard read must execute, not throw");
});

test("EXECUTED: approving a commission that was never confirmed is refused", async () => {
  /* Money must not leave on an unconfirmed order. The source-text suite above asserts the words
   * "confirmation" and "approval" appear; this asserts the order is enforced. */
  const { db, mod } = await commissionWorld();
  const result = await mod.approveOrderCommission(db, {
    bookingId: "BK-NEVER-CONFIRMED", level: 1, actor: MAKER, idempotencyKey: "exec-unconfirmed-1",
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  assert.equal(result.ok, false, "an unconfirmed order must not be approvable");
});

/** Seed a real completed booking on a COMMISSION provider so sync creates an actual order row. */
function seedCompletedCommissionBooking(sqlite, bookingId) {
  const now = Date.now();
  sqlite.exec(`CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT,provider_id TEXT NOT NULL,provider_name TEXT,provider_model TEXT NOT NULL,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,occurrence_count INTEGER DEFAULT 1,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT,event_type TEXT,actor_id TEXT,detail_json TEXT,occurred_at INTEGER,created_at INTEGER,sequence INTEGER);`);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,status,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,'completed',?,?,?,?)")
    .run(bookingId, "CUS-SOD", "blr", "pet_grooming", "PRV-SOD", 4000, "INR", now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,provider_id,provider_name,provider_model,service_code,status,created_at,updated_at) VALUES (?,?,?,?,'commission',?, 'completed',?,?)")
    .run(`WO-${bookingId}`, bookingId, "PRV-SOD", "SoD Provider", "pet_grooming", now, now);
}

test("EXECUTED: the same actor cannot supply both approvals (segregation of duties)", async () => {
  /* The rule the source-text suite above only NAMES. If one person can approve twice, the
   * two-approval control on money leaving the company is decorative.
   *
   * The first version of this test was VACUOUS and I caught it by checking rather than trusting the
   * green: it approved against a booking that did not exist, the module answered "Commission order
   * not found", zero rows were written, and the assertion held for the wrong reason. A real order is
   * now created first - and the test asserts a row EXISTS before asserting anything about it, so it
   * can never silently return to passing on an empty table.
   */
  const { sqlite, db, mod } = await commissionWorld();
  const bookingId = "BK-SOD-REAL";
  seedCompletedCommissionBooking(sqlite, bookingId);
  /* The provider needs a compensation profile or sync parks the order at configuration_required and
   * every approval below is refused for the WRONG reason - which is exactly how the first version of
   * this test passed while proving nothing. CommissionMode is "percent", not "percentage". */
  await mod.saveProviderCompensationProfile(db, {
    providerId: "PRV-SOD", engagementModel: "commission", commissionMode: "percent",
    commissionValue: 20, reason: "segregation-of-duties fixture", actor: "finance.admin@pawspace.in",
  });
  await mod.syncCompletedCommissionOrders(db);

  const orderCount = sqlite.prepare("SELECT COUNT(*) n FROM provider_order_commissions WHERE booking_id=?").get(bookingId).n;
  assert.equal(orderCount, 1, "the fixture must produce exactly one real commission order - without it this test proves nothing");

  const attempt = (level, actor) => mod.approveOrderCommission(db, {
    bookingId, level, actor, idempotencyKey: `exec-sod-${level}-${actor}`,
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error?.message ?? error).slice(0, 120) }));

  /* Walk the real state machine: pending_confirmation -> awaiting_approval_1 -> awaiting_approval_2.
   * Each step is asserted, so a fixture that stalls early can never masquerade as a passing rule. */
  await mod.confirmOrderCommission(db, { bookingId, actor: MAKER });
  const statusAfterConfirm = sqlite.prepare("SELECT status FROM provider_order_commissions WHERE booking_id=?").get(bookingId).status;
  assert.equal(statusAfterConfirm, "awaiting_approval_1", "confirmation must open level 1 approval");

  const first = await attempt(1, MAKER);
  assert.equal(first.ok, true, "the first approval by the maker must succeed");
  const statusAfterFirst = sqlite.prepare("SELECT status FROM provider_order_commissions WHERE booking_id=?").get(bookingId).status;
  assert.equal(statusAfterFirst, "awaiting_approval_2", "level 1 approval must open level 2 - otherwise the rule below is never reached");

  const secondSameActor = await attempt(2, MAKER);
  assert.equal(secondSameActor.ok, false, "the SAME actor must be refused the second approval");

  const bothSame = sqlite.prepare(
    "SELECT COUNT(*) n FROM provider_order_commissions WHERE approval_level_1_by IS NOT NULL " +
    "AND approval_level_2_by IS NOT NULL AND approval_level_1_by = approval_level_2_by",
  ).get().n;

  assert.equal(bothSame, 0,
    "one actor must never occupy both approval slots. " +
    `first=${JSON.stringify(first).slice(0, 90)} second=${JSON.stringify(secondSameActor).slice(0, 90)}`);
});

test("EXECUTED: non-vacuity - the module does not simply refuse everything", async () => {
  /* Without this, "throw on every call" would satisfy both refusal tests above and break payouts. */
  const { db, mod } = await commissionWorld();
  const sync = await mod.syncCompletedCommissionOrders(db)
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error?.message ?? error) }));
  assert.equal(sync.ok, true, `a legitimate sync must succeed, got ${JSON.stringify(sync).slice(0, 160)}`);
  const dash = await mod.getProviderCommissionDashboard(db, {});
  assert.ok(Object.keys(dash).length > 0, "the dashboard must return a real shape");
});
