/**
 * JOURNEY C — a supported Boarding cancellation must produce a genuine, non-zero, SANDBOX-ONLY refund.
 *
 * Why a dedicated fixture was needed. Neither pre-existing boarding booking can prove this:
 *   UATD-BK-BOARD-1 — funded (Rs3600 captured) but its stay is status 'in_progress' AND
 *                     check_in_status 'complete', which are exactly the two halves of the
 *                     approve_cancel guard in lib/boarding-finance-governance.ts. It 409s before any
 *                     refund is computed.
 *   UATD-BK-BOARD-2 — clears that guard, but its payment is status 'created', and
 *                     lib/collected-funds.ts is explicit that 'created' means nothing was collected.
 *                     Refunds are capped by collected funds, so any amount > 0 is refused and an
 *                     amount of 0 writes no ledger row at all (refundId = amount>0 ? uuid : null).
 *                     A "passing" test there would be vacuous by construction.
 * BOARD-2 was deliberately NOT edited: the staging seed is INSERT OR IGNORE and BOARD-2 already
 * exists there, so changing its row would silently no-op on reseed. UATD-BK-BOARD-3 is a new id set.
 *
 * Rs2400 is derived from the seed's own economics, not invented: 3600/3 nights and 2400/2 nights
 * both give Rs1200/night, so a 2-night stay is Rs2400.
 *
 * These tests drive the REAL mutateBoardingFinance path over a real transactional D1 shim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__JC_DB__", "__JC_ENV__");

const BOOKING = "UATD-BK-BOARD-3", STAY = "UATD-STAY-3", CUS = "UATD-CUS-2";
const HOST = "host_sana", GROUP = "UATD-GRP-UATD-BK-BOARD-3", AMOUNT = 2400;
const REQUESTER = "ops.requester@pawspace.in", APPROVER = "ops.approver@pawspace.in";

const finance = await import("../lib/boarding-finance-governance.ts");

/**
 * @param paymentOverride lets the non-vacuity check re-seed the SAME fixture with an unfunded
 *   payment, proving the non-zero-refund assertions are load-bearing rather than incidental.
 */
async function seed(paymentOverride = { status: "captured", amount_due_now: AMOUNT }) {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__JC_DB__ = db;
  globalThis.__JC_ENV__ = {};
  await finance.ensureBoardingFinanceTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT NOT NULL,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");

  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,status,total_amount,currency,created_at,updated_at) VALUES (?,?,'blr','blr-east','boarding','boarding','Home Boarding 2 nights',?,?,'confirmed',?,'INR',0,0)")
    .run(BOOKING, CUS, GROUP, HOST, AMOUNT);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'INR','upi','prepaid',?,'uat_sandbox',?,0,0)")
    .run(`${BOOKING}-PAY`, BOOKING, CUS, AMOUNT, paymentOverride.amount_due_now, paymentOverride.status, `uatd-pay-${BOOKING}`);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,status,created_at) VALUES (?,?,?,'boarding','blr','blr-east',?,'[]','2026-08-26T10:00:00.000Z','2026-08-28T11:00:00.000Z',1,1,'assigned',0)")
    .run(`${BOOKING}-RES`, GROUP, HOST, CUS);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,status,created_at,updated_at) VALUES (?,?,?,'assigned',0,0)")
    .run(`${BOOKING}-WO`, BOOKING, HOST);
  // The stay: NOT in_progress, check_in_status pending - the two halves of the approve_cancel guard.
  sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,customer_id,host_provider_id,city_id,zone_id,package_code,check_in_at,check_out_at,billed_units,pet_count,status,care_plan_status,check_in_status,check_out_status,extension_status,created_at,updated_at) VALUES (?,?,?,?,'blr','blr-east','boarding','2026-08-26T10:00:00.000Z','2026-08-28T11:00:00.000Z',2,1,'awaiting_host_acceptance','required','pending','pending','none',0,0)")
    .run(STAY, BOOKING, CUS, HOST);
  return sqlite;
}

const money = (sqlite) => {
  const c = (t) => {
    const e = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    return e ? sqlite.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c : 0;
  };
  return {
    refundLedger: c("boarding_refund_ledger"),
    journal: c("finance_journal_entries"),
    wallet: c("pawspace_wallet_ledger"),
    payments: sqlite.prepare("SELECT id,status,amount,amount_due_now FROM booking_payments").all(),
  };
};

const request = (actorId, key) => finance.mutateBoardingFinance(globalThis.__JC_DB__, { bookingId: BOOKING, action: "request_cancel", actorId, idempotencyKey: key, reason: "Journey C verification" });
const approve = (actorId, key, amount) => finance.mutateBoardingFinance(globalThis.__JC_DB__, { bookingId: BOOKING, action: "approve_cancel", actorId, idempotencyKey: key, approvedRefundAmount: amount, reason: "Journey C verification" });

// 1 - preconditions: genuinely cancellable AND genuinely funded.
test("PRECONDITION: the fixture is cancellable and collected funds are greater than zero", async () => {
  const sqlite = await seed();
  const stay = sqlite.prepare("SELECT status,check_in_status FROM boarding_stays WHERE id=?").get(STAY);
  assert.notEqual(stay.status, "in_progress", "stay is NOT in_progress (first half of the guard)");
  assert.equal(stay.check_in_status, "pending", "check-in is pending (second half of the guard)");
  const booking = sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING);
  assert.ok(!["cancelled", "completed"].includes(booking.status), "booking is non-terminal");
  const pay = sqlite.prepare("SELECT status,amount,amount_due_now,gateway FROM booking_payments WHERE booking_id=?").get(BOOKING);
  assert.equal(pay.status, "captured", "payment is captured - so collected > 0");
  assert.ok(pay.amount > 0 && pay.amount_due_now > 0, "amount and amount_due_now are both > 0");
  assert.equal(pay.gateway, "uat_sandbox", "sandbox only - no production payment rail");
  assert.equal(sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(GROUP).status, "assigned", "reservation is active before cancellation");
});

// 2,3,4,5,7 - the real path end to end.
test("JOURNEY C: request then approve by a different actor yields exactly one non-zero sandbox refund", async () => {
  const sqlite = await seed();
  const opened = await request(REQUESTER, "jc-req-1");
  assert.equal(opened.status, "policy_review_required", "cancellation opens for policy review");
  assert.equal(opened.bookingPreserved, true, "the booking is preserved at request time");

  const approved = await approve(APPROVER, "jc-app-1", AMOUNT);
  assert.ok(approved, "approval by a DIFFERENT actor succeeds");

  const refunds = sqlite.prepare("SELECT id,booking_id,amount,currency,status,policy_source FROM boarding_refund_ledger WHERE booking_id=?").all(BOOKING);
  assert.equal(refunds.length, 1, "EXACTLY ONE refund ledger record");
  assert.equal(refunds[0].amount, AMOUNT, `non-zero refund of exactly Rs${AMOUNT}`);
  assert.ok(refunds[0].amount > 0, "the refund is genuinely non-zero - not a vacuous pass");
  assert.equal(refunds[0].status, "sandbox_pending", "SANDBOX ONLY - never a live payment-rail refund");
  assert.equal(refunds[0].currency, "INR");
});

// 6 - downstream state.
test("JOURNEY C: booking, stay and reservation reach their correct cancelled/released state", async () => {
  const sqlite = await seed();
  await request(REQUESTER, "jc-req-2");
  await approve(APPROVER, "jc-app-2", AMOUNT);

  const booking = sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING);
  const stay = sqlite.prepare("SELECT status FROM boarding_stays WHERE id=?").get(STAY);
  const reservation = sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(GROUP);
  const cancellation = sqlite.prepare("SELECT status,approved_refund_amount FROM boarding_cancellation_requests WHERE booking_id=?").get(BOOKING);

  assert.equal(cancellation.status, "approved", "the cancellation request is approved");
  assert.equal(cancellation.approved_refund_amount, AMOUNT, "at the approved amount");
  assert.equal(booking.status, "cancelled", "the booking is cancelled");
  assert.equal(stay.status, "cancelled", "the stay is cancelled");
  assert.equal(reservation.status, "cancelled", "the reservation no longer holds capacity");
});

// 8 - journals: assert what this path actually does rather than assuming it writes any.
test("JOURNEY C: journal entries are neither duplicated nor left unbalanced by this path", async () => {
  const sqlite = await seed();
  const before = money(sqlite).journal;
  await request(REQUESTER, "jc-req-3");
  await approve(APPROVER, "jc-app-3", AMOUNT);
  const after = money(sqlite).journal;
  // lib/boarding-finance-governance.ts contains zero references to finance_journal_entries, so this
  // path posts no journal. Asserting that explicitly keeps the claim honest: if a future change starts
  // posting journals here, this test forces the balance/duplication question to be answered.
  assert.equal(after, before, "this path posts no journal entries, so none can be duplicated or unbalanced");
});

// 9 - replay.
test("JOURNEY C: replaying the approval is idempotent - no second refund, no second release", async () => {
  const sqlite = await seed();
  await request(REQUESTER, "jc-req-4");
  await approve(APPROVER, "jc-app-4", AMOUNT);
  const afterFirst = money(sqlite);

  const replay = await approve(APPROVER, "jc-app-4", AMOUNT);
  assert.equal(replay.duplicatePrevented, true, "the replay is recognised as a duplicate");
  const afterReplay = money(sqlite);

  assert.equal(afterReplay.refundLedger, afterFirst.refundLedger, "still exactly one refund ledger row");
  assert.equal(afterReplay.refundLedger, 1, "and it is one, not zero");
  assert.equal(afterReplay.journal, afterFirst.journal, "no extra journal rows");
  assert.deepEqual(afterReplay.payments, afterFirst.payments, "no further payment mutation");
});

// 10 - segregation of duties.
test("JOURNEY C: the requester cannot approve their own refund, and that refusal moves no money", async () => {
  const sqlite = await seed();
  await request(REQUESTER, "jc-req-5");
  const before = money(sqlite);

  await assert.rejects(
    () => approve(REQUESTER, "jc-app-5", AMOUNT),
    (error) => {
      assert.equal(error.status, 409, "segregation of duties is refused with a client conflict");
      return true;
    },
  );

  const after = money(sqlite);
  assert.equal(after.refundLedger, before.refundLedger, "ZERO money mutation");
  assert.equal(after.refundLedger, 0, "and no refund row exists at all");
  assert.equal(after.journal, before.journal, "zero journal mutation");
  assert.equal(after.wallet, before.wallet, "zero wallet mutation");
  assert.deepEqual(after.payments, before.payments, "zero payment mutation");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "confirmed", "the booking is NOT cancelled by a refused approval");
});

// NON-VACUITY - the load-bearing check.
test("NON-VACUITY: with the payment unfunded, the non-zero refund becomes impossible", async () => {
  // Same fixture, only the payment reverted to the BOARD-2-style unfunded shape.
  const sqlite = await seed({ status: "created", amount_due_now: 0 });
  await request(REQUESTER, "jc-req-6");

  await assert.rejects(
    () => approve(APPROVER, "jc-app-6", AMOUNT),
    (error) => {
      assert.equal(error.status, 409, "an unfunded booking cannot approve a non-zero refund");
      return true;
    },
    "if this ever succeeds, the Journey C refund assertions are not actually load-bearing",
  );
  assert.equal(money(sqlite).refundLedger, 0, "and no refund ledger row is written");
});
