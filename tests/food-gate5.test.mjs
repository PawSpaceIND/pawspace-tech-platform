import test from "node:test";
import assert from "node:assert/strict";
import {
  freshFoodWorld,
  createFoodOrderFixture,
  mutateFoodFulfilment,
  mutateFoodProof,
  mutateFoodOps,
  getFoodOpsSnapshot,
  expectResponse,
} from "./helpers/food-gate-harness.mjs";

test("Food Gate 5 derives stock recovery from real order state and resumes only the same SKU", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { quantity: 2, idempotencyKey: "gate5-stock" });
  await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "report_stock_issue",
    actorId: "ops@example.in",
    idempotencyKey: "gate5-stock-report",
    reason: "Exact ordered SKU unavailable at pick station",
  });

  let snapshot = await getFoodOpsSnapshot(world.db);
  let order = snapshot.orders.find((row) => row.id === fixture.orderId);
  assert.ok(order.exceptionFlags.includes("stock_recovery_required"));
  assert.equal(order.priority, "high");

  world.sqlite.prepare("UPDATE food_inventory_uat SET available_units=reserved_units WHERE sku=? AND zone_id=?").run(fixture.sku, fixture.zoneId);
  await expectResponse(mutateFoodOps(world.db, {
    orderId: fixture.orderId,
    action: "resume_same_sku_stock",
    actorId: "ops@example.in",
    idempotencyKey: "gate5-resume-no-stock",
    reason: "Retry same SKU after stock check",
  }), 409, /exact ordered SKU still lacks enough UAT stock/i);

  world.sqlite.prepare("UPDATE food_inventory_uat SET available_units=30 WHERE sku=? AND zone_id=?").run(fixture.sku, fixture.zoneId);
  const resumed = await mutateFoodOps(world.db, {
    orderId: fixture.orderId,
    action: "resume_same_sku_stock",
    actorId: "ops@example.in",
    idempotencyKey: "gate5-resume-good",
    reason: "Exact ordered SKU replenished",
  });
  assert.equal(resumed.status, "accepted");
  assert.equal(resumed.orderId, fixture.orderId);
  assert.equal(resumed.sku, fixture.sku);
  assert.equal(resumed.unitPrice, fixture.quote.unitPrice);
  assert.equal(resumed.orderPreserved, true);
  assert.equal(resumed.substitutionAllowed, false);
  assert.equal(resumed.priceChangeAllowed, false);
  snapshot = await getFoodOpsSnapshot(world.db);
  order = snapshot.orders.find((row) => row.id === fixture.orderId);
  assert.ok(!order.exceptionFlags.includes("stock_recovery_required"));
});

test("Food Gate 5 derives quality and finance attention flags from persisted state", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { idempotencyKey: "gate5-flags" });
  await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "accept_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate5-flags-accept",
  });
  await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "pick_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate5-flags-pick",
    lotId: "FLOT-DOG-A-01",
  });
  await mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "report_quality_incident",
    actorId: "ops@example.in",
    idempotencyKey: "gate5-critical-incident",
    severity: "critical",
    summary: "Critical package integrity concern",
    actionTaken: "Held item and escalated to Operations",
  });
  const snapshot = await getFoodOpsSnapshot(world.db);
  const order = snapshot.orders.find((row) => row.id === fixture.orderId);
  assert.ok(order.exceptionFlags.includes("critical_quality_incident"));
  assert.ok(order.exceptionFlags.includes("tax_pending"));
  assert.equal(order.priority, "critical");
  assert.equal(snapshot.metrics.needsAttention, 1);
  assert.equal(snapshot.metrics.openIncidents, 1);
  assert.ok(snapshot.metrics.financeReview >= 1, "tax_pending is a finance-review condition");
});

test("Food Gate 5 Operations notes require meaningful content and replay idempotently", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { idempotencyKey: "gate5-notes" });
  await expectResponse(mutateFoodOps(world.db, {
    orderId: fixture.orderId,
    action: "add_note",
    actorId: "ops@example.in",
    idempotencyKey: "gate5-short-note",
    note: "no",
  }), 400, /meaningful Operations note/i);

  const noted = await mutateFoodOps(world.db, {
    orderId: fixture.orderId,
    action: "add_note",
    actorId: "ops@example.in",
    idempotencyKey: "gate5-note",
    note: "Customer contacted; same-SKU fulfilment remains under review.",
  });
  assert.equal(noted.status, "noted");
  const replay = await mutateFoodOps(world.db, {
    orderId: fixture.orderId,
    action: "add_note",
    actorId: "ops@example.in",
    idempotencyKey: "gate5-note",
    note: "This different text must not create another row.",
  });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) count FROM food_ops_notes WHERE order_id=?").get(fixture.orderId).count, 1);
});

test("Food Gate 5 closure claim is UAT-only and does not invent production dependencies", async () => {
  const world = freshFoodWorld();
  await createFoodOrderFixture(world, { idempotencyKey: "gate5-readiness" });
  const snapshot = await getFoodOpsSnapshot(world.db);
  assert.equal(snapshot.readiness.engineeringGate, "gate_5_closed_uat_contract");
  assert.equal(snapshot.readiness.productionReady, false);
  assert.equal(snapshot.readiness.externalDependencies.productionCatalogue, "disconnected");
  assert.equal(snapshot.readiness.externalDependencies.productionInventory, "disconnected");
  assert.equal(snapshot.readiness.externalDependencies.productionLotTraceability, "disconnected");
  assert.equal(snapshot.readiness.externalDependencies.deliveryPartner, "disconnected");
  assert.equal(snapshot.readiness.externalDependencies.objectStorage, "disconnected");
  assert.equal(snapshot.readiness.externalDependencies.malwareScanner, "disconnected");
  assert.equal(snapshot.readiness.externalDependencies.payments, "sandbox_only");
  assert.equal(snapshot.readiness.externalDependencies.refunds, "sandbox_only");
  assert.equal(snapshot.readiness.externalDependencies.cogs, "configuration_required");
  assert.equal(snapshot.readiness.externalDependencies.supplierSettlement, "rule_pending");
  assert.equal(snapshot.readiness.externalDependencies.tax, "configuration_required");
});
