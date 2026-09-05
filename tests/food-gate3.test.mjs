import test from "node:test";
import assert from "node:assert/strict";
import {
  freshFoodWorld,
  createFoodOrderFixture,
  fulfilTo,
  mutateFoodFulfilment,
  mutateFoodFinance,
  expectResponse,
} from "./helpers/food-gate-harness.mjs";

test("Food Gate 3 executes delivery payment capture and refuses payment-reference reuse", async () => {
  const world = freshFoodWorld();
  const first = await createFoodOrderFixture(world, { idempotencyKey: "gate3-paid-1" });
  await fulfilTo(world, first, "delivered");
  const paid = await mutateFoodFinance(world.db, {
    orderId: first.orderId,
    action: "record_order_payment",
    actorId: "finance@example.in",
    idempotencyKey: "gate3-payment-1",
    paymentReference: "PAYREF-GATE3-001",
  });
  assert.equal(paid.status, "sandbox_paid");
  assert.equal(paid.liveMoney, false);
  const payment = world.sqlite.prepare("SELECT status,reference FROM food_order_payment_events WHERE order_id=?").get(first.orderId);
  assert.deepEqual(payment, { status: "sandbox_paid", reference: "PAYREF-GATE3-001" });

  const second = await createFoodOrderFixture(world, { idempotencyKey: "gate3-paid-2" });
  await fulfilTo(world, second, "delivered");
  await expectResponse(mutateFoodFinance(world.db, {
    orderId: second.orderId,
    action: "record_order_payment",
    actorId: "finance@example.in",
    idempotencyKey: "gate3-payment-2",
    paymentReference: "PAYREF-GATE3-001",
  }), 409, /payment reference was already used/i);
});

test("Food Gate 3 cancellation is request-only, segregated and releases only reserved inventory", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { quantity: 2, idempotencyKey: "gate3-cancel-order" });
  const requested = await mutateFoodFinance(world.db, {
    orderId: fixture.orderId,
    action: "request_cancel",
    actorId: "customer@example.in",
    idempotencyKey: "gate3-request-cancel",
    reason: "Customer requested cancellation",
  });
  assert.equal(requested.status, "policy_review_required");
  assert.equal(requested.orderPreserved, true);
  assert.equal(world.sqlite.prepare("SELECT status FROM food_orders WHERE id=?").get(fixture.orderId).status, "uat_reserved");

  await expectResponse(mutateFoodFinance(world.db, {
    orderId: fixture.orderId,
    action: "approve_cancel",
    actorId: "customer@example.in",
    idempotencyKey: "gate3-self-approve",
    reason: "Self approval must fail",
    approvedRefundAmount: 0,
  }), 409, /Segregation of duties/i);

  const approved = await mutateFoodFinance(world.db, {
    orderId: fixture.orderId,
    action: "approve_cancel",
    actorId: "finance@example.in",
    idempotencyKey: "gate3-finance-approve",
    reason: "Approved under cancellation review",
    approvedRefundAmount: 0,
  });
  assert.equal(approved.status, "cancelled");
  assert.equal(approved.inventoryReservationReleased, true);
  const inventory = world.sqlite.prepare("SELECT reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").get(fixture.sku, fixture.zoneId);
  assert.equal(inventory.reserved_units, 0);
  assert.equal(world.sqlite.prepare("SELECT status FROM food_inventory_reservations WHERE order_id=?").get(fixture.orderId).status, "released");
});

test("Food Gate 3 blocks packed-order cancellation and refuses refund amounts above paid money", async () => {
  const world = freshFoodWorld();
  const packed = await createFoodOrderFixture(world, { idempotencyKey: "gate3-packed" });
  await fulfilTo(world, packed, "packed");
  await expectResponse(mutateFoodFinance(world.db, {
    orderId: packed.orderId,
    action: "request_cancel",
    actorId: "customer@example.in",
    idempotencyKey: "gate3-packed-cancel",
    reason: "Cancel after pack",
  }), 409, /Operations fulfilment review/i);

  const fresh = await createFoodOrderFixture(world, { idempotencyKey: "gate3-unpaid-refund" });
  await mutateFoodFinance(world.db, {
    orderId: fresh.orderId,
    action: "request_cancel",
    actorId: "customer@example.in",
    idempotencyKey: "gate3-unpaid-request",
    reason: "Cancellation before delivery",
  });
  await expectResponse(mutateFoodFinance(world.db, {
    orderId: fresh.orderId,
    action: "approve_cancel",
    actorId: "finance@example.in",
    idempotencyKey: "gate3-too-much-refund",
    reason: "Refund exceeds collected funds",
    approvedRefundAmount: 1,
  }), 409, /cannot exceed sandbox-paid order value/i);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) count FROM food_refund_ledger WHERE order_id=?").get(fresh.orderId).count, 0);
});

test("Food Gate 3 reconciliation and supplier settlement expose configured-vs-pending finance truth", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { idempotencyKey: "gate3-reconcile" });
  await fulfilTo(world, fixture, "delivered");
  const unpaid = await mutateFoodFinance(world.db, {
    orderId: fixture.orderId,
    action: "reconcile",
    actorId: "finance@example.in",
    idempotencyKey: "gate3-reconcile-unpaid",
  });
  assert.equal(unpaid.status, "attention_required");
  assert.equal(unpaid.unpaidTotal, fixture.quote.totalAmount);
  assert.equal(unpaid.paidTotal, 0);

  await mutateFoodFinance(world.db, {
    orderId: fixture.orderId,
    action: "record_order_payment",
    actorId: "finance@example.in",
    idempotencyKey: "gate3-pay-for-settlement",
    paymentReference: "PAYREF-GATE3-SETTLE",
  });
  const settlement = await mutateFoodFinance(world.db, {
    orderId: fixture.orderId,
    action: "prepare_supplier_settlement",
    actorId: "finance@example.in",
    idempotencyKey: "gate3-settlement",
  });
  assert.equal(settlement.status, "not_ready");
  assert.equal(settlement.cogs, "configuration_required");
  assert.equal(settlement.supplierSettlementPolicy, "rule_pending");
  assert.equal(settlement.tax, "configuration_required");
  assert.equal(settlement.settlement, "not_instructed");

  const reconciled = await mutateFoodFinance(world.db, {
    orderId: fixture.orderId,
    action: "reconcile",
    actorId: "finance@example.in",
    idempotencyKey: "gate3-reconcile-paid",
  });
  assert.equal(reconciled.paidTotal, fixture.quote.totalAmount);
  assert.equal(reconciled.unpaidTotal, 0);
  assert.equal(reconciled.netPaidTotal, fixture.quote.totalAmount);
  assert.equal(reconciled.status, "attention_required", "COGS/tax/settlement remain deliberately unconfigured");
});
