import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// Lane 1 critical cross-module proof. This deliberately drives the real Training
// cancellation domain against persisted SQLite/D1-compatible state. It covers the
// customer money-like credits that the existing Training hardening suite did not:
// wallet principal and PawPoints redeemed on a booking must come back exactly once
// when that booking is cancelled, while cash refund remains capped to captured cash.
installWorkersHooks("__LANE1_CANCEL_DB__", "__LANE1_CANCEL_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => {
      const row = sqlite.prepare(sql).get(...args);
      return row === undefined ? null : row;
    },
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes), rows_written: Number(info.changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

const { materializeTrainingProgramme } = await import("../lib/training-programme.ts");
const {
  saveTrainingCancellationPolicy,
  requestTrainingCancellation,
  approveTrainingCancellation,
} = await import("../lib/training-cancellation.ts");
const {
  creditWallet,
  redeemWalletForBooking,
  walletBalance,
} = await import("../lib/pawspace-wallet-governance.ts");
const {
  grantGoodwillPoints,
  redeemPoints,
  pawPointsBalance,
} = await import("../lib/paw-points-governance.ts");

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const CUSTOMER = "CUS-LANE1-CANCEL";
const BOOKING = "BK-LANE1-CANCEL";
const GROUP = "SG-LANE1-CANCEL";
const PROVIDER = "train_lane1";
const WALLET_SEED = 1000;
const POINTS_SEED = 400;

const sessionStart = (offset) => new Date(Date.UTC(2026, 8, 10 + offset, 5, 30)).toISOString();
const sessionEnd = (offset) => new Date(Date.UTC(2026, 8, 10 + offset, 6, 30)).toISOString();

function baseTables(sqlite) {
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL DEFAULT 'assigned',explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
}

function seedBooking(sqlite) {
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(CUSTOMER, "blr", "Lane One Customer", "+919000000111", NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[\"pet-lane1\"]','[\"pet-lane1\"]','blr','blr-east','dog_training','obedience-starter','Obedience Starter',?,?,?,?,'confirmed','customer_app',8000,'INR','{}','customer',?,?)")
    .run(BOOKING, `idem-${BOOKING}`, CUSTOMER, GROUP, PROVIDER, sessionStart(0), sessionEnd(3), NOW, NOW);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR','upi','deposit','captured','uat_sandbox',?,'{}',?,?)")
    .run(`PAY-${BOOKING}`, BOOKING, CUSTOMER, 8000, 3000, `pay-${BOOKING}`, NOW, NOW);
  for (let index = 0; index < 4; index++) {
    sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,'dog_training','blr','blr-east',?,'[\"pet-lane1\"]',?,?,1,?,NULL,'assigned','{}',?)")
      .run(`RES-${index + 1}`, GROUP, PROVIDER, CUSTOMER, sessionStart(index), sessionEnd(index), index + 1, NOW);
  }
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,'commission','dog_training',?,?,4,'assigned','{}',?,?)")
    .run("WO-LANE1-CANCEL", BOOKING, GROUP, PROVIDER, "Lane One Trainer", sessionStart(0), sessionEnd(3), NOW, NOW);
}

function count(sqlite, table, where = "1=1") {
  return Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get().n);
}

test("confirmed Training cancellation releases work/capacity, caps cash refund, restores wallet and PawPoints once, and replay is inert", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__LANE1_CANCEL_DB__ = db;
  globalThis.__LANE1_CANCEL_ENV__ = { DB: db, PAWSPACE_PAYMENT_ENV: "sandbox" };
  baseTables(sqlite);
  seedBooking(sqlite);
  // Deliberately NOT calling ensureTrainingCommercialTables here. approveTrainingCancellation reaches
  // the commercial quote link through ensureTrainingCancellationTables -> ensureTrainingFinanceTables,
  // and creating the table from the test instead is what hid the fact that production never did.

  await materializeTrainingProgramme(db, { bookingId: BOOKING, actorId: "system:lane1-test" });

  await creditWallet(db, {
    customerId: CUSTOMER,
    amount: WALLET_SEED,
    source: "goodwill",
    sourceId: "lane1-seed",
    idempotencyKey: "lane1-wallet-seed",
    note: "Lane 1 cancellation setup credit",
    actorId: "system:lane1-test",
  });
  await redeemWalletForBooking(db, {
    customerId: CUSTOMER,
    bookingId: BOOKING,
    walletAmount: WALLET_SEED,
    actorId: `customer:${CUSTOMER}`,
  });
  assert.equal(await walletBalance(db, CUSTOMER), 0, "setup must consume the seeded wallet principal");

  await grantGoodwillPoints(db, {
    customerId: CUSTOMER,
    points: POINTS_SEED,
    reason: "Lane 1 cancellation setup points",
    actorId: "system:lane1-test",
    idempotencyKey: "lane1-points-seed",
  });
  await redeemPoints(db, {
    customerId: CUSTOMER,
    points: POINTS_SEED,
    bookingId: BOOKING,
    actorId: `customer:${CUSTOMER}`,
  });
  assert.equal(await pawPointsBalance(db, CUSTOMER), 0, "setup must consume the seeded PawPoints");

  await saveTrainingCancellationPolicy(db, {
    cityId: "blr",
    feeType: "none",
    feeValue: 0,
    noShowTreatment: "refundable",
    effectiveFrom: "2026-08-01",
    reason: "Lane 1 full refund policy for untouched sessions",
    actorId: "ops:lane1-test",
  });
  const request = await requestTrainingCancellation(db, {
    bookingId: BOOKING,
    reason: "Customer relocation before any session starts",
    idempotencyKey: "lane1-cancel-request",
    actorId: `customer:${CUSTOMER}`,
  });
  assert.equal(request.calculation.capturedAmount, 3000);
  assert.equal(request.calculation.calculatedRefund, 3000, "cash refund is capped to captured cash, not booking face value or restored credits");

  const approved = await approveTrainingCancellation(db, {
    caseId: request.caseId,
    reason: "Finance approves untouched programme cancellation",
    actorId: "finance:lane1-test",
  });
  assert.equal(approved.approvedRefund, 3000);
  assert.equal(approved.liveRefund, false);

  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "cancelled");
  assert.equal(sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(BOOKING).status, "cancelled");
  assert.equal(count(sqlite, "training_sessions", "status='cancelled'"), 4);
  assert.equal(count(sqlite, "scheduling_reservations", "status='cancelled'"), 4, "all held capacity is released");
  assert.equal(count(sqlite, "training_refund_instructions"), 1);
  assert.equal(sqlite.prepare("SELECT amount FROM training_refund_instructions WHERE case_id=?").get(request.caseId).amount, 3000);

  assert.equal(await walletBalance(db, CUSTOMER), WALLET_SEED, "wallet principal is restored after cancellation");
  assert.equal(await pawPointsBalance(db, CUSTOMER), POINTS_SEED, "redeemed PawPoints are restored after cancellation");
  assert.equal(count(sqlite, "pawspace_wallet_ledger", `idempotency_key='wallet-cancellation-restore:${BOOKING}'`), 1);
  assert.equal(count(sqlite, "paw_points_ledger", `idempotency_key='restore:cancelled-booking:${BOOKING}'`), 1);

  const snapshot = {
    wallet: await walletBalance(db, CUSTOMER),
    points: await pawPointsBalance(db, CUSTOMER),
    refunds: count(sqlite, "training_refund_instructions"),
    walletRestores: count(sqlite, "pawspace_wallet_ledger", `idempotency_key='wallet-cancellation-restore:${BOOKING}'`),
    pointRestores: count(sqlite, "paw_points_ledger", `idempotency_key='restore:cancelled-booking:${BOOKING}'`),
  };
  await assert.rejects(
    approveTrainingCancellation(db, {
      caseId: request.caseId,
      reason: "Repeated approval must be inert",
      actorId: "finance:lane1-retry",
    }),
    (error) => error instanceof Response && error.status === 409,
  );
  assert.deepEqual({
    wallet: await walletBalance(db, CUSTOMER),
    points: await pawPointsBalance(db, CUSTOMER),
    refunds: count(sqlite, "training_refund_instructions"),
    walletRestores: count(sqlite, "pawspace_wallet_ledger", `idempotency_key='wallet-cancellation-restore:${BOOKING}'`),
    pointRestores: count(sqlite, "paw_points_ledger", `idempotency_key='restore:cancelled-booking:${BOOKING}'`),
  }, snapshot, "a repeated cancellation/refund approval changes nothing");

  assert.equal(count(sqlite, "training_sessions", "status NOT IN ('completed','no_show','cancelled')"), 0, "no active Training session is orphaned");
  assert.equal(count(sqlite, "scheduling_reservations", "status NOT IN ('cancelled')"), 0, "no reservation remains active");
  assert.equal(count(sqlite, "provider_work_orders", "status!='cancelled'"), 0, "no provider work remains assigned");
});
