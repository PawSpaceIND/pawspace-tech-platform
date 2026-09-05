/**
 * Fresh Food Gate 3 — EXECUTED. Sandbox payment recording, request-only cancellation with
 * segregation of duties, inventory release on approval, the refund ledger, supplier settlement
 * readiness and reconciliation.
 *
 * WHAT THIS FILE USED TO BE. Eight tests, every assertion a regex over the source of
 * `lib/food-finance-governance.ts`, the route and two workspace pages. "Food supplier settlement
 * never invents COGS supplier amount or tax" asserted that DDL default strings appeared in the file
 * — defaults the INSERT always overrides, and no evidence that anything is left unset.
 *
 * Each test below drives the real `mutateFoodFinance` against a real SQLite-backed D1, over an order
 * carried through the real Gate 1 and Gate 2 functions, and asserts on the money rows it wrote.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { FOOD_SKUS, freshSqlite, makeD1, nextKey, refusal, seedFoodOrder } from "./helpers/food-harness.mjs";

installWorkersHooks("__FOOD_G3_DB__", "__FOOD_G3_ENV__");

const fulfilment = await import("../lib/food-fulfilment-governance.ts");
const finance = await import("../lib/food-finance-governance.ts");

const STAFF = "ops.fulfilment@pawspace.test";
const FINANCE_STAFF = "finance.checker@pawspace.test";
const CUSTOMER = "CUST-FOOD-1";
const LOT = "FLOT-DOG-A-01";
const ZONE = "blr-east";

async function foodWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__FOOD_G3_DB__ = db;
  globalThis.__FOOD_G3_ENV__ = {};
  const order = await seedFoodOrder(db, sqlite, options);
  await finance.ensureFoodFinanceTables(db);
  return { sqlite, db, order };
}

const fulfil = (db, order, action, extra = {}) => fulfilment.mutateFoodFulfilment(db, {
  orderId: order.orderId, action, actorId: STAFF, idempotencyKey: nextKey(), ...extra,
});

const money = (db, order, action, extra = {}) => finance.mutateFoodFinance(db, {
  orderId: order.orderId, action, actorId: FINANCE_STAFF, idempotencyKey: nextKey(), ...extra,
});

/** Carry an order through the real fulfilment lifecycle to delivered, where money becomes due. */
async function deliver(db, order) {
  await fulfil(db, order, "accept_order");
  await fulfil(db, order, "pick_order", { lotId: LOT });
  await fulfil(db, order, "pack_order");
  await fulfil(db, order, "dispatch_order", { dispatchReference: "UATDISP-333333" });
  return fulfil(db, order, "confirm_delivery", { handoverMethod: "customer" });
}

const stock = (db, sku = FOOD_SKUS.dogAdult.sku) =>
  db.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").bind(sku, ZONE).first();

// ---------------------------------------------------------------------------------------------
test("Fresh Food keeps a delivered order payment-due until a sandbox payment is recorded", async () => {
  const { db, order } = await foodWorld();
  await deliver(db, order);

  const due = await db.prepare("SELECT status,reference FROM food_order_payment_events WHERE order_id=?").bind(order.orderId).first();
  assert.equal(due.status, "due");
  assert.equal(due.reference, null);

  const noReference = await refusal(money(db, order, "record_order_payment", {}));
  assert.equal(noReference?.status, 400);
  assert.match(noReference.message, /Sandbox Food payment reference is required/);

  const paid = await money(db, order, "record_order_payment", { paymentReference: "SBX-FOOD-1" });
  assert.equal(paid.status, "sandbox_paid");
  assert.equal(paid.amount, order.totalAmount);
  assert.equal(paid.liveMoney, false);

  const after = await db.prepare("SELECT status,reference FROM food_order_payment_events WHERE order_id=?").bind(order.orderId).first();
  assert.equal(after.status, "sandbox_paid");
  assert.equal(after.reference, "SBX-FOOD-1");

  // The order-level payment record follows the delivery ledger, and still claims no live money.
  const aggregate = await db.prepare("SELECT status,detail_json FROM food_order_payments WHERE order_id=?").bind(order.orderId).first();
  assert.equal(aggregate.status, "paid");
  assert.deepEqual(JSON.parse(aggregate.detail_json), {
    source: "food_delivery_ledger", sandboxReference: "SBX-FOOD-1", liveMoney: false,
    productionPaymentPolicy: "pending",
  });

  // A different reference on an already-paid order is a duplicate, not a second payment.
  const twice = await money(db, order, "record_order_payment", { paymentReference: "SBX-FOOD-2" });
  assert.equal(twice.duplicatePayment, true);
  assert.equal(twice.reference, "SBX-FOOD-1", "the original reference stands");

  // An undelivered order has nothing to pay for.
  const undelivered = await foodWorld({ customerId: "CUST-FOOD-2", petId: "PET-FOOD-2" });
  const nothingDue = await refusal(money(undelivered.db, undelivered.order, "record_order_payment", { paymentReference: "SBX-EARLY" }));
  assert.equal(nothingDue?.status, 404);
  assert.match(nothingDue.message, /Delivered Food payment-due event not found/);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food sandbox payment references cannot be replayed across orders", async () => {
  const { db, sqlite, order } = await foodWorld();
  await deliver(db, order);
  await money(db, order, "record_order_payment", { paymentReference: "SBX-SHARED" });

  const second = await seedFoodOrder(db, sqlite, { customerId: "CUST-FOOD-2", petId: "PET-FOOD-2" });
  await deliver(db, second);
  const replayed = await refusal(money(db, second, "record_order_payment", { paymentReference: "SBX-SHARED" }));
  assert.equal(replayed?.status, 409);
  assert.match(replayed.message, /sandbox payment reference was already used/);
  assert.equal(
    (await db.prepare("SELECT status FROM food_order_payment_events WHERE order_id=?").bind(second.orderId).first()).status,
    "due",
    "a refused replay leaves the second order unpaid",
  );

  // A payment event in any state other than due or sandbox_paid is not payable. No action writes such
  // a state today, so the row is put there directly -- the guard exists precisely for states this
  // module does not itself produce.
  await db.prepare("UPDATE food_order_payment_events SET status='void' WHERE order_id=?").bind(second.orderId).run();
  const notPayable = await refusal(money(db, second, "record_order_payment", { paymentReference: "SBX-VOID" }));
  assert.equal(notPayable?.status, 409);
  assert.match(notPayable.message, /payment event is not payable/);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food cancellation is request-only and packed orders go through Operations first", async () => {
  const { db, order } = await foodWorld();

  const thin = await refusal(finance.mutateFoodFinance(db, {
    orderId: order.orderId, action: "request_cancel", actorId: CUSTOMER, idempotencyKey: nextKey(), reason: "x",
  }));
  assert.equal(thin?.status, 400);
  assert.match(thin.message, /A Food finance reason is required/);

  const requested = await finance.mutateFoodFinance(db, {
    orderId: order.orderId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Ordered the wrong pack size",
  });
  assert.equal(requested.status, "policy_review_required");
  assert.equal(requested.refundPolicy, "configuration_required", "no refund is computed at request time");
  assert.equal(requested.orderPreserved, true);
  assert.equal(requested.approvedRefundAmount, undefined);

  const duplicate = await refusal(finance.mutateFoodFinance(db, {
    orderId: order.orderId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Asking again",
  }));
  assert.equal(duplicate?.status, 409);
  assert.match(duplicate.message, /already pending or approved/);

  // Once the order is PACKED the goods are committed, and cancellation belongs to Operations.
  const packed = await foodWorld({ customerId: "CUST-FOOD-2", petId: "PET-FOOD-2" });
  await fulfil(packed.db, packed.order, "accept_order");
  await fulfil(packed.db, packed.order, "pick_order", { lotId: LOT });
  await fulfil(packed.db, packed.order, "pack_order");
  const tooLate = await refusal(finance.mutateFoodFinance(packed.db, {
    orderId: packed.order.orderId, action: "request_cancel", actorId: "CUST-FOOD-2",
    idempotencyKey: nextKey(), reason: "Changed my mind after packing",
  }));
  assert.equal(tooLate?.status, 409);
  assert.match(tooLate.message, /must use Operations fulfilment review before cancellation/);

  const financeToo = await refusal(money(packed.db, packed.order, "approve_cancel", {
    reason: "Finance overriding the packed state", approvedRefundAmount: 0,
  }));
  assert.equal(financeToo?.status, 409);
  assert.match(financeToo.message, /must be operationally resolved before Finance cancellation/);

  // A delivered order is closed to cancellation entirely.
  const delivered = await foodWorld({ customerId: "CUST-FOOD-3", petId: "PET-FOOD-3" });
  await deliver(delivered.db, delivered.order);
  const closed = await refusal(finance.mutateFoodFinance(delivered.db, {
    orderId: delivered.order.orderId, action: "request_cancel", actorId: "CUST-FOOD-3",
    idempotencyKey: nextKey(), reason: "It arrived and I do not want it",
  }));
  assert.equal(closed?.status, 409);
  assert.match(closed.message, /Closed Food orders cannot accept cancellation requests/);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food cancellation approval is a second pair of hands and releases reserved stock", async () => {
  const { db, order } = await foodWorld({ quantity: 2 });
  await finance.mutateFoodFinance(db, {
    orderId: order.orderId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Ordered the wrong pack size",
  });

  const selfApproved = await refusal(finance.mutateFoodFinance(db, {
    orderId: order.orderId, action: "approve_cancel", actorId: CUSTOMER, idempotencyKey: nextKey(),
    reason: "Approving my own request", approvedRefundAmount: 0,
  }));
  assert.equal(selfApproved?.status, 409);
  assert.match(selfApproved.message, /the cancellation requester cannot approve their own refund/);

  // Nothing was paid, so no refund can be approved either.
  const overRefund = await refusal(money(db, order, "approve_cancel", { reason: "Refund it all", approvedRefundAmount: 100 }));
  assert.equal(overRefund?.status, 409);
  assert.match(overRefund.message, /must be explicit and cannot exceed sandbox-paid order value/);

  const implicit = await refusal(money(db, order, "approve_cancel", { reason: "Approved by Finance" }));
  assert.equal(implicit?.status, 409);
  assert.match(implicit.message, /must be explicit/);

  assert.equal(Number((await stock(db)).reserved_units), 2, "no refused approval released stock");

  const approved = await money(db, order, "approve_cancel", { reason: "Approved by Finance", approvedRefundAmount: 0 });
  assert.equal(approved.status, "cancelled");
  assert.equal(approved.refundId, null);
  assert.equal(approved.refundStatus, "not_required", "a zero refund writes no ledger row");
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM food_refund_ledger WHERE order_id=?").bind(order.orderId).first()).n),
    0,
  );

  // The reserved stock goes back on the shelf, and only the still-reserved units.
  assert.equal(approved.inventoryReservationReleased, true, "the result says so, and the rows agree");
  const released = await stock(db);
  assert.equal(Number(released.reserved_units), 0, "cancelling an unpacked order releases its reservation");
  assert.equal(Number(released.available_units), 30, "and does not consume anything on the way out");
  assert.equal(
    (await db.prepare("SELECT status FROM food_inventory_reservations WHERE order_id=?").bind(order.orderId).first()).status,
    "released",
  );
  assert.equal((await db.prepare("SELECT status FROM food_orders WHERE id=?").bind(order.orderId).first()).status, "cancelled");

  const again = await refusal(money(db, order, "approve_cancel", { reason: "Once more", approvedRefundAmount: 0 }));
  assert.equal(again?.status, 409);
  assert.match(again.message, /cannot be cancelled again/);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food cancellation releases only still-reserved inventory", async () => {
  // A CONSUMED reservation is stock that has left the shelf. Cancelling must not put it back.
  const { db, order } = await foodWorld({ quantity: 2 });
  await fulfil(db, order, "accept_order");
  await fulfil(db, order, "pick_order", { lotId: LOT });
  await fulfil(db, order, "pack_order");
  const afterPack = await stock(db);
  assert.equal(Number(afterPack.available_units), 28);
  assert.equal(Number(afterPack.reserved_units), 0);

  // Packed orders route through Operations, so drive the case that reaches Finance: an order rolled
  // back to a cancellable fulfilment state while its reservation stays consumed.
  await db.prepare("UPDATE food_order_fulfilment SET status='accepted' WHERE order_id=?").bind(order.orderId).run();
  await db.prepare("UPDATE food_orders SET status='accepted' WHERE id=?").bind(order.orderId).run();
  await finance.mutateFoodFinance(db, {
    orderId: order.orderId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Operations rolled this back",
  });
  await money(db, order, "approve_cancel", { reason: "Approved by Finance", approvedRefundAmount: 0 });

  /*
   * EQUIVALENT MUTATION, recorded rather than hidden. releaseReservedInventoryStatements() bails out
   * when the reservation is not 'reserved'. Deleting that status check changes nothing observable:
   * the units statement is `reserved_units=MAX(0,reserved_units-?)` and reserved is already 0, and
   * the row statement carries its own `AND status='reserved'` predicate, so both become no-ops. The
   * guard is belt and braces over two statements that are individually safe. The assertions below
   * pin the OUTCOME, which is the property that matters.
   */
  const afterCancel = await stock(db);
  assert.equal(Number(afterCancel.available_units), 28, "consumed stock is not resurrected by a cancellation");
  assert.equal(Number(afterCancel.reserved_units), 0, "and the reserved count is not driven negative");
  assert.equal(
    (await db.prepare("SELECT status FROM food_inventory_reservations WHERE order_id=?").bind(order.orderId).first()).status,
    "consumed",
    "a consumed reservation stays consumed",
  );
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food refund ledger is sandbox-only and replay resistant", async () => {
  const { db, order } = await foodWorld();
  await deliver(db, order);
  await money(db, order, "record_order_payment", { paymentReference: "SBX-R-1" });

  // A delivered order cannot be cancelled, so the refund path is exercised through an order that was
  // paid and then rolled back by Operations -- which is exactly when a refund is owed.
  await db.prepare("UPDATE food_orders SET status='accepted' WHERE id=?").bind(order.orderId).run();
  await db.prepare("UPDATE food_order_fulfilment SET status='accepted' WHERE order_id=?").bind(order.orderId).run();
  await finance.mutateFoodFinance(db, {
    orderId: order.orderId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Delivered damaged, Operations rolled it back",
  });

  const tooMuch = await refusal(money(db, order, "approve_cancel", {
    reason: "Refund more than was paid", approvedRefundAmount: order.totalAmount + 1,
  }));
  assert.equal(tooMuch?.status, 409);
  assert.match(tooMuch.message, /cannot exceed sandbox-paid order value/);

  const approved = await money(db, order, "approve_cancel", { reason: "Approved by Finance", approvedRefundAmount: 300 });
  assert.equal(approved.approvedRefundAmount, 300);
  assert.equal(approved.refundStatus, "sandbox_pending", "approval opens a ledger entry, it does not move money");

  const ledger = await db.prepare("SELECT amount,status,reference,policy_source FROM food_refund_ledger WHERE order_id=?").bind(order.orderId).first();
  assert.equal(Number(ledger.amount), 300);
  assert.equal(ledger.status, "sandbox_pending");
  assert.equal(ledger.reference, null, "no gateway reference is invented at approval");
  assert.equal(ledger.policy_source, "explicit_finance_approval");

  const noReference = await refusal(money(db, order, "record_refund", {}));
  assert.equal(noReference?.status, 400);
  assert.match(noReference.message, /Sandbox Food refund reference is required/);

  const recorded = await money(db, order, "record_refund", { refundReference: "SBX-FOOD-REFUND-1" });
  assert.equal(recorded.status, "sandbox_recorded");
  assert.equal(recorded.amount, 300);

  const none = await refusal(money(db, order, "record_refund", { refundReference: "SBX-FOOD-REFUND-2" }));
  assert.equal(none?.status, 409);
  assert.match(none.message, /No Food sandbox refund is pending/);

  // A reference already spent elsewhere cannot be reused.
  await db.prepare("INSERT INTO food_refund_ledger (id,order_id,cancellation_request_id,amount,currency,status,reference,policy_source,created_by,created_at,updated_at) VALUES ('FRF-B',?,NULL,50,'INR','sandbox_pending',NULL,'explicit_finance_approval',?,?,?)")
    .bind(order.orderId, FINANCE_STAFF, Date.now(), Date.now()).run();
  const reused = await refusal(money(db, order, "record_refund", { refundReference: "SBX-FOOD-REFUND-1" }));
  assert.equal(reused?.status, 409);
  assert.match(reused.message, /refund reference was already used/);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food supplier settlement invents no COGS, supplier amount or tax", async () => {
  const { db, order } = await foodWorld();

  const early = await refusal(money(db, order, "prepare_supplier_settlement", {}));
  assert.equal(early?.status, 409);
  assert.match(early.message, /only after canonical UAT Food delivery/);

  await deliver(db, order);
  const unpaid = await refusal(money(db, order, "prepare_supplier_settlement", {}));
  assert.equal(unpaid?.status, 409);
  assert.match(unpaid.message, /must be sandbox-paid before supplier settlement readiness/);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM food_supplier_settlement_ledger WHERE order_id=?").bind(order.orderId).first()).n),
    0,
    "a refused settlement writes no ledger row",
  );

  await money(db, order, "record_order_payment", { paymentReference: "SBX-S-1" });
  const prepared = await money(db, order, "prepare_supplier_settlement", {});
  assert.equal(prepared.status, "not_ready", "settlement readiness is not approval");
  assert.equal(prepared.grossPaidValue, order.totalAmount);
  assert.equal(prepared.cogs, "configuration_required");
  assert.equal(prepared.supplierSettlementPolicy, "rule_pending");
  assert.equal(prepared.tax, "configuration_required");
  assert.equal(prepared.settlement, "not_instructed");

  const row = await db.prepare("SELECT * FROM food_supplier_settlement_ledger WHERE order_id=?").bind(order.orderId).first();
  assert.equal(Number(row.gross_paid_value), order.totalAmount);
  assert.equal(row.cogs_status, "configuration_required");
  assert.equal(row.supplier_settlement_policy, "rule_pending");
  assert.equal(row.tax_status, "configuration_required");
  assert.equal(row.approval_status, "not_ready");
  assert.equal(row.settlement_status, "not_instructed");
  // The only figure recorded is money that actually moved in the sandbox; nothing downstream is guessed.
  assert.equal(row.cogs_amount ?? null, null);
  assert.equal(row.supplier_settlement_amount ?? null, null);
  assert.equal(row.approved_by ?? null, null);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food reconciliation exposes due, paid, refund, net, COGS and tax truth", async () => {
  const { db, order } = await foodWorld();
  await deliver(db, order);

  const unpaid = await money(db, order, "reconcile", {});
  assert.equal(unpaid.status, "attention_required", "an unpaid delivered order is never reported as balanced");
  assert.equal(unpaid.deliveryDueTotal, order.totalAmount);
  assert.equal(unpaid.paidTotal, 0);
  assert.equal(unpaid.unpaidTotal, order.totalAmount);
  assert.equal(unpaid.refundTotal, 0);
  assert.equal(unpaid.netPaidTotal, 0);
  assert.equal(unpaid.cogsState, "configuration_required");
  assert.equal(unpaid.taxState, "configuration_required");
  assert.equal(unpaid.supplierSettlementState, "attention_required", "a delivered order with no settlement needs attention");

  await money(db, order, "record_order_payment", { paymentReference: "SBX-RC-1" });
  await money(db, order, "prepare_supplier_settlement", {});
  const settled = await money(db, order, "reconcile", {});
  assert.equal(settled.paidTotal, order.totalAmount);
  assert.equal(settled.unpaidTotal, 0);
  assert.equal(settled.netPaidTotal, order.totalAmount);
  assert.equal(settled.supplierSettlementState, "not_ready");
  assert.equal(settled.status, "attention_required", "unconfigured COGS and tax still need attention");

  const stored = await db.prepare("SELECT order_total,delivery_due_total,paid_total,unpaid_total,net_paid_total,supplier_settlement_amount,detail_json,checked_by FROM food_finance_reconciliation WHERE order_id=? ORDER BY created_at DESC LIMIT 1").bind(order.orderId).first();
  assert.equal(Number(stored.order_total), order.totalAmount);
  assert.equal(Number(stored.paid_total), order.totalAmount);
  assert.equal(Number(stored.unpaid_total), 0);
  assert.equal(Number(stored.net_paid_total), order.totalAmount);
  assert.equal(stored.supplier_settlement_amount, null, "reconciliation reports no supplier amount because none exists");
  assert.equal(stored.checked_by, FINANCE_STAFF);
  assert.equal(JSON.parse(stored.detail_json).sandboxOnly, true);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food reconciliation counts settled refunds only, and finance keys are replay safe", async () => {
  const { db, order } = await foodWorld();
  await deliver(db, order);
  await money(db, order, "record_order_payment", { paymentReference: "SBX-N-1" });
  await db.prepare("UPDATE food_orders SET status='accepted' WHERE id=?").bind(order.orderId).run();
  await db.prepare("UPDATE food_order_fulfilment SET status='accepted' WHERE order_id=?").bind(order.orderId).run();
  await finance.mutateFoodFinance(db, {
    orderId: order.orderId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Rolled back by Operations",
  });
  await money(db, order, "approve_cancel", { reason: "Approved", approvedRefundAmount: 199 });

  const beforeRecord = await money(db, order, "reconcile", {});
  assert.equal(beforeRecord.refundTotal, 0, "an approved but unrecorded refund is not yet money out");
  assert.equal(beforeRecord.netPaidTotal, order.totalAmount);

  await money(db, order, "record_refund", { refundReference: "SBX-N-REFUND" });
  const afterRecord = await money(db, order, "reconcile", {});
  assert.equal(afterRecord.refundTotal, 199);
  assert.equal(afterRecord.netPaidTotal, order.totalAmount - 199);

  const key = nextKey();
  const once = await finance.mutateFoodFinance(db, {
    orderId: order.orderId, action: "reconcile", actorId: FINANCE_STAFF, idempotencyKey: key,
  });
  const twice = await finance.mutateFoodFinance(db, {
    orderId: order.orderId, action: "reconcile", actorId: FINANCE_STAFF, idempotencyKey: key,
  });
  assert.equal(twice.duplicatePrevented, true);
  assert.equal(twice.reconciliationId, once.reconciliationId, "a replay returns the same reconciliation");

  const unsupported = await refusal(money(db, order, "audit_everything", {}));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Food finance action/);

  const missing = await refusal(finance.mutateFoodFinance(db, {
    orderId: "PS-UAT-FOOD-NOPE", action: "reconcile", actorId: FINANCE_STAFF, idempotencyKey: nextKey(),
  }));
  assert.equal(missing?.status, 404);
  assert.match(missing.message, /Canonical Food order not found/);
});
