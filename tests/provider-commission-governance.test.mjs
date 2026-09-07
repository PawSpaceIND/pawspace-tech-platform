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
test("commission requires confirmation plus two approvals by three distinct actors",()=>{assert.match(governance,/awaiting_approval_1/);assert.match(governance,/awaiting_approval_2/);assert.match(governance,/Level 1 approval must be completed by a different approver than the commission confirmer/);assert.match(governance,/Level 2 approval must be completed by a different approver/);assert.match(governance,/Level 2 approval must be completed by a different approver than the commission confirmer/);assert.match(route,/approve_order_commission_level_1/);assert.match(route,/approve_order_commission_level_2/);});
test("RazorpayX payout orchestration remains sandbox guarded",()=>{assert.match(governance,/rail.*razorpayx/);assert.match(governance,/environment.*sandbox/);assert.match(governance,/liveMoney:false/);assert.match(route,/rail:\"razorpayx\"/);assert.match(route,/environment:\"sandbox\"/);assert.match(ui,/RazorpayX is orchestrated in sandbox\/UAT only/);});
test("provider finance writes remain protected by finance manage permission",()=>{assert.match(route,/authorize\(request,\"finance\.manage\"\)/);assert.match(route,/securityAudit/);});

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
const CHECKER_2 = "finance.checker2@pawspace.in";

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
  assert.equal(dash.policy.makerCheckerSeparation, true);
  assert.equal(dash.policy.allApprovalActorsDistinct, true);
});

test("EXECUTED: approving a commission that was never confirmed is refused", async () => {
  const { db, mod } = await commissionWorld();
  const result = await mod.approveOrderCommission(db, {
    bookingId: "BK-NEVER-CONFIRMED", level: 1, actor: MAKER, idempotencyKey: "exec-unconfirmed-1",
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  assert.equal(result.ok, false, "an unconfirmed order must not be approvable");
});

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

async function seedCommissionOrder(world, bookingId) {
  const { sqlite, db, mod } = world;
  seedCompletedCommissionBooking(sqlite, bookingId);
  await mod.saveProviderCompensationProfile(db, {
    providerId: "PRV-SOD", engagementModel: "commission", commissionMode: "percent",
    commissionValue: 20, reason: "segregation-of-duties fixture", actor: "finance.admin@pawspace.in",
  });
  await mod.syncCompletedCommissionOrders(db);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_order_commissions WHERE booking_id=?").get(bookingId).n, 1);
}

test("EXECUTED: commission confirmation, L1 and L2 require three distinct actors", async () => {
  const world = await commissionWorld();
  const { sqlite, db, mod } = world;
  const bookingId = "BK-SOD-REAL";
  await seedCommissionOrder(world, bookingId);
  await mod.confirmOrderCommission(db, { bookingId, actor: MAKER });
  assert.equal(sqlite.prepare("SELECT status FROM provider_order_commissions WHERE booking_id=?").get(bookingId).status, "awaiting_approval_1");

  await assert.rejects(() => mod.approveOrderCommission(db, { bookingId, level: 1, actor: MAKER }), /different approver than the commission confirmer/);
  assert.equal(sqlite.prepare("SELECT status FROM provider_order_commissions WHERE booking_id=?").get(bookingId).status, "awaiting_approval_1", "maker rejection must not advance state");

  await mod.approveOrderCommission(db, { bookingId, level: 1, actor: CHECKER });
  assert.equal(sqlite.prepare("SELECT status FROM provider_order_commissions WHERE booking_id=?").get(bookingId).status, "awaiting_approval_2");
  await assert.rejects(() => mod.approveOrderCommission(db, { bookingId, level: 2, actor: CHECKER }), /different approver/);
  await assert.rejects(() => mod.approveOrderCommission(db, { bookingId, level: 2, actor: MAKER }), /different approver than the commission confirmer/);

  const done = await mod.approveOrderCommission(db, { bookingId, level: 2, actor: CHECKER_2, idempotencyKey: "exec-sod-final" });
  assert.equal(done.status, "payout_queued_sandbox");
  assert.equal(done.environment, "sandbox");
  assert.equal(done.liveMoney, false);
  const row = sqlite.prepare("SELECT confirmed_by,approval_level_1_by,approval_level_2_by FROM provider_order_commissions WHERE booking_id=?").get(bookingId);
  assert.equal(new Set([row.confirmed_by.toLowerCase(), row.approval_level_1_by.toLowerCase(), row.approval_level_2_by.toLowerCase()]).size, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_order_payouts WHERE booking_id=? AND environment='sandbox'").get(bookingId).n, 1);
});

test("EXECUTED: payout idempotency key cannot be reused across bookings", async () => {
  const first = await commissionWorld();
  await seedCommissionOrder(first, "BK-IDEM-1");
  await first.mod.confirmOrderCommission(first.db, { bookingId: "BK-IDEM-1", actor: MAKER });
  await first.mod.approveOrderCommission(first.db, { bookingId: "BK-IDEM-1", level: 1, actor: CHECKER });
  await first.mod.approveOrderCommission(first.db, { bookingId: "BK-IDEM-1", level: 2, actor: CHECKER_2, idempotencyKey: "shared-idem" });
  await seedCommissionOrder(first, "BK-IDEM-2");
  await first.mod.confirmOrderCommission(first.db, { bookingId: "BK-IDEM-2", actor: MAKER });
  await first.mod.approveOrderCommission(first.db, { bookingId: "BK-IDEM-2", level: 1, actor: CHECKER });
  await assert.rejects(() => first.mod.approveOrderCommission(first.db, { bookingId: "BK-IDEM-2", level: 2, actor: CHECKER_2, idempotencyKey: "shared-idem" }), /different booking/);
});

test("EXECUTED: non-vacuity - the module does not simply refuse everything", async () => {
  const { db, mod } = await commissionWorld();
  const sync = await mod.syncCompletedCommissionOrders(db)
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error?.message ?? error) }));
  assert.equal(sync.ok, true, `a legitimate sync must succeed, got ${JSON.stringify(sync).slice(0, 160)}`);
  const dash = await mod.getProviderCommissionDashboard(db, {});
  assert.ok(Object.keys(dash).length > 0, "the dashboard must return a real shape");
});
