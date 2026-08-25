/**
 * PawSpace Total Journey Audit, Wave 2 Batch B — incentive engines paying on work that never happened.
 *
 * Both defects are the same shape and both have a sibling in this repo that already carries the missing
 * predicate, so neither correction decides anything new about incentive policy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_W2BI_DB__", "__PTJA_W2BI_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_W2BI_DB__ = db;
  globalThis.__PTJA_W2BI_ENV__ = {};
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,city_id TEXT,provider_id TEXT,status TEXT,total_amount REAL,scheduled_start TEXT,scheduled_end TEXT,created_at INTEGER,updated_at INTEGER)");
  return { sqlite, db };
}

const booking = (sqlite, id, { service = "grooming", status = "completed", amount = 20000, start = "2026-08-15T04:00:00.000Z", provider = "PRV-HEAD-1" } = {}) =>
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,city_id,provider_id,status,total_amount,scheduled_start,scheduled_end,created_at,updated_at) VALUES (?,'CUS-1',?,'blr',?,?,?,?,?,?,?)")
    .run(id, service, provider, status, amount, start, start, Date.UTC(2026, 7, 15), Date.UTC(2026, 7, 15));

// =====================================================================================================
// PTJA-W2B-P02 — sales incentive pays on CANCELLED bookings
//
// attributedValueForDay and computeMonthlySalesIncentive sum canonical_bookings joined through
// sales_attributed_bookings with NO status predicate. Both sibling engines do filter:
// lib/trainer-incentive-engine.ts and lib/grooming-incentive-engine.ts each carry AND status='completed'.
//
// MEASURED: a Rs 20,000 grooming booking was attributed to EMP-SALES-1 and then CANCELLED by the
// customer. compute_daily_sales still returned {achievedValue:20000, tierTarget:20000, incentive:1000} -
// a cancelled booking is exactly the grooming_outbound daily tier-1 target, so it paid Rs 1,000 earned
// on nothing. The monthly view was byte-identical before and after the cancellation.
//
// Attribution is one-way by design - attributeBookingToSalesEmployee refuses reattribution and there is
// no de-attribution path - so a booking cancelled after attribution credits the employee permanently.
// Monthly tiers are step functions, so cancelled value can be what carries an employee over a tier line.
//
// The correction excludes cancelled and draft bookings only. It deliberately does NOT narrow to
// 'completed' like the sibling engines: when a SALE is earned - at confirmation or at delivery - is a
// commercial decision, and requiring completion could withhold incentive that is legitimately due today.
// A cancelled booking is not a sale under any reading.
// =====================================================================================================

async function salesWorld(bookingStatus) {
  const { sqlite, db } = world();
  const sales = await import("../lib/sales-incentive-engine.ts");
  booking(sqlite, "BK-15-CONF", { status: bookingStatus, amount: 20000 });
  sqlite.exec("CREATE TABLE IF NOT EXISTS sales_attributed_bookings (booking_id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,attributed_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO sales_attributed_bookings (booking_id,employee_id,attributed_at) VALUES ('BK-15-CONF','EMP-SALES-1',?)").run(Date.UTC(2026, 7, 15));
  await sales.ensureSalesIncentiveTables(db);
  sqlite.prepare("INSERT INTO sales_employee_base (id,employee_id,base_vertical,effective_from,reason,actor_id,created_at) VALUES ('SB-1','EMP-SALES-1','grooming_outbound','2026-01-01','probe','ops',?)").run(Date.UTC(2026, 0, 1));
  return { sqlite, db, sales };
}

test("W2B-P02: a cancelled booking pays no sales incentive", async () => {
  const { db, sales } = await salesWorld("cancelled");
  const daily = await sales.computeDailySalesIncentive(db, { employeeId: "EMP-SALES-1", date: "2026-08-15", actorId: "ops" })
    .catch((error) => ({ error: String(error?.message ?? error) }));
  assert.ok(!daily.error, `the engine must run: ${JSON.stringify(daily)}`);
  assert.equal(Number(daily.achievedValue), 0,
    `a cancelled booking contributes nothing to attributed value: ${JSON.stringify(daily)}`);
  assert.equal(Number(daily.incentive), 0, "so no incentive is earned on it");
});

test("W2B-P02: a live booking still pays exactly as before", async () => {
  // Non-vacuity. Zeroing every attribution would satisfy the case above and stop sales incentive.
  const { db, sales } = await salesWorld("confirmed");
  const daily = await sales.computeDailySalesIncentive(db, { employeeId: "EMP-SALES-1", date: "2026-08-15", actorId: "ops" });
  assert.equal(Number(daily.achievedValue), 20000, `a confirmed sale still counts: ${JSON.stringify(daily)}`);
  assert.ok(Number(daily.incentive) > 0, "and still earns its tier incentive");
});

// =====================================================================================================
// PTJA-W2B-P04 — the groomer monthly incentive counts upgrades on CANCELLED and NON-GROOMING bookings
//
// computeGroomerMonthlyIncentive reads
//   SELECT COUNT(*),SUM(upgrade_value) FROM booking_upgrades WHERE provider_id=?
//     AND booking_id IN (SELECT id FROM canonical_bookings WHERE date(scheduled_start) BETWEEN ? AND ?)
// The subquery filters on DATE ONLY. It carries neither service_code='grooming' nor status='completed',
// while dailyOrdersForGroomer() a few lines above carries BOTH.
//
// MEASURED for August 2026, head groomer PRV-HEAD-1, monthly floor Rs 100,000:
//   BK-G1        grooming, completed,  Rs 99,000  <- the only real earned revenue
//   BK-CANCELLED grooming, cancelled,  Rs 50,000  + one upgrade of Rs 2,000
//   BK-T0..T19   dog_training, cancelled, Rs 0    + twenty upgrades of Rs 100 each
// The report returned upgradeCount 21, upgradeValue 4000, monthTotal 103000, eligible true,
// crossedTarget true, eligibleForRanking true, headTotal 1500, helperTotal 750. The correct answer on
// that data is eligible false and zero payable: real completed grooming revenue is Rs 99,000, below the
// floor, and there are ZERO upgrades on any completed grooming booking.
//
// The downstream effect is larger than the Rs 2,250: eligibleForRanking admits the groomer into
// rankGroomersForMonth, whose winner table pays up to Rs 5,000 head plus Rs 3,000 helper - and admitting
// a phantom entrant demotes every genuine groomer by one rank.
//
// The correction copies the predicate the adjacent query already applies. Nothing new is decided.
// =====================================================================================================

async function groomerWorld() {
  const { sqlite, db } = world();
  const grooming = await import("../lib/grooming-incentive-engine.ts");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_upgrades (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,upgrade_value REAL NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)");
  await grooming.ensureGroomingIncentiveTables(db);
  sqlite.prepare("INSERT INTO groomer_incentive_brackets (id,head_groomer_id,bracket,helper_id,effective_from,reason,actor_id,created_at) VALUES ('GB-1','PRV-HEAD-1','team','HLP-1','2026-01-01','probe','ops',?)").run(Date.UTC(2026, 0, 1));
  booking(sqlite, "BK-G1", { service: "grooming", status: "completed", amount: 99000, start: "2026-08-05T04:00:00.000Z" });
  booking(sqlite, "BK-CANCELLED", { service: "grooming", status: "cancelled", amount: 50000, start: "2026-08-06T04:00:00.000Z" });
  sqlite.prepare("INSERT INTO booking_upgrades (id,booking_id,provider_id,upgrade_value,created_at) VALUES ('UPG-1','BK-CANCELLED','PRV-HEAD-1',2000,?)").run(Date.UTC(2026, 7, 6));
  for (let index = 0; index < 20; index += 1) {
    booking(sqlite, `BK-T${index}`, { service: "dog_training", status: "cancelled", amount: 0, start: "2026-08-07T04:00:00.000Z" });
    sqlite.prepare("INSERT INTO booking_upgrades (id,booking_id,provider_id,upgrade_value,created_at) VALUES (?,?,'PRV-HEAD-1',100,?)").run(`UPG-T${index}`, `BK-T${index}`, Date.UTC(2026, 7, 7));
  }
  return { sqlite, db, grooming };
}

test("W2B-P04: upgrades on cancelled or non-grooming bookings do not count", async () => {
  const { db, grooming } = await groomerWorld();
  const result = await grooming.computeGroomerMonthlyIncentive(db, { headGroomerId: "PRV-HEAD-1", monthStart: "2026-08-01", actorId: "ops" })
    .catch((error) => ({ error: String(error?.message ?? error) }));
  assert.ok(!result.error, `the engine must run: ${JSON.stringify(result)}`);
  assert.equal(Number(result.upgradeValue), 0,
    `no upgrade sits on a completed grooming booking: ${JSON.stringify({ upgradeCount: result.upgradeCount, upgradeValue: result.upgradeValue })}`);
  assert.equal(Number(result.upgradeCount), 0, "and none is counted");
  assert.equal(Number(result.monthTotal), 99000, "so the month total is the real earned revenue alone");
  assert.equal(result.eligible, false, "which is below the Rs 100,000 floor");
});

test("W2B-P04: an upgrade on a completed grooming booking still counts", async () => {
  // Non-vacuity. Dropping every upgrade would satisfy the case above and delete the upgrade bonus.
  const { sqlite, db, grooming } = await groomerWorld();
  booking(sqlite, "BK-G2", { service: "grooming", status: "completed", amount: 2000, start: "2026-08-08T04:00:00.000Z" });
  sqlite.prepare("INSERT INTO booking_upgrades (id,booking_id,provider_id,upgrade_value,created_at) VALUES ('UPG-REAL','BK-G2','PRV-HEAD-1',1500,?)").run(Date.UTC(2026, 7, 8));

  const result = await grooming.computeGroomerMonthlyIncentive(db, { headGroomerId: "PRV-HEAD-1", monthStart: "2026-08-01", actorId: "ops" });
  assert.equal(Number(result.upgradeValue), 1500, `a genuine upgrade still counts: ${JSON.stringify(result)}`);
  assert.equal(Number(result.upgradeCount), 1, "exactly once");
});
