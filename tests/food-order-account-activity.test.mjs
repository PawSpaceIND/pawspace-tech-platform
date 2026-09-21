import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { customerSessionCookie, freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";
installWorkersHooks("__FOOD_ACTIVITY_DB__");

// CUST-L-D22: Fresh Food orders live in their own food_orders/food_order_lines tables, never in
// canonical_bookings, so readCustomerAccount()/GET /api/customer-account never surfaced them and
// /v2/activity had no Food entry at all. After a confirmation crash (CUST-L-D21) a customer had no
// in-app way back to an order they had already paid inventory against.

const OPS_ORIGIN = "https://ops.pawspace.example";
const CUSTOMER_A = "CUST-FOOD-ACTIVITY-1";
const CUSTOMER_B = "CUST-FOOD-ACTIVITY-2";
const PET_ID = "PET-FOOD-ACTIVITY-1";
const SKU = "food-uat-dog-adult-2kg";

async function seedWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__FOOD_ACTIVITY_DB__ = db;
  const account = await import("../lib/customer-account.ts");
  await account.ensureCustomerAccountTables(db);
  const now = Date.now();
  for (const customerId of [CUSTOMER_A, CUSTOMER_B]) {
    await db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(customerId, "blr", "UAT Customer", "+919800000111", "customer_app", "{}", now, now).run();
  }
  await db.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,vaccination_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(PET_ID, CUSTOMER_A, "Rocky", "dog", "verified", now, now).run();
  return { sqlite, db };
}

test("real execution: a Fresh Food order surfaces in the owning customer's canonical account only", async () => {
  const { db } = await seedWorld();
  const governance = await import("../lib/food-governance.ts");
  const quote = await governance.createFoodQuote(db, {
    sku: SKU, quantity: 2, zoneId: "blr-east", paymentMode: "sandbox_deferred",
    customerId: CUSTOMER_A, petIds: [PET_ID],
  });
  const order = await governance.createFoodOrder(db, {
    idempotencyKey: "food-activity-1", quoteId: quote.quoteId, customerId: CUSTOMER_A,
    cityId: "blr", zoneId: "blr-east", actorId: CUSTOMER_A,
  });

  const { readCustomerAccount } = await import("../lib/customer-account.ts");
  const ownerAccount = await readCustomerAccount(db, CUSTOMER_A);
  assert.equal(ownerAccount.foodOrders.length, 1);
  const entry = ownerAccount.foodOrders[0];
  assert.equal(entry.id, order.orderId);
  assert.match(entry.itemName, /Adult Dog Food/);
  assert.equal(entry.quantity, 2);
  assert.equal(entry.status, "uat_reserved");
  assert.equal(entry.deliveryStatus, "fulfilment_review_required");
  assert.equal(entry.totalAmount, quote.totalAmount);
  assert.equal(entry.currency, "INR");
  assert.ok(Number.isFinite(entry.createdAt) && entry.createdAt > 0);

  // A different customer never sees another customer's Food order.
  const strangerAccount = await readCustomerAccount(db, CUSTOMER_B);
  assert.deepEqual(strangerAccount.foodOrders, []);
});

test("a customer account with no Food orders yet gets an empty projection, not an error", async () => {
  const { db } = await seedWorld();
  const { readCustomerAccount } = await import("../lib/customer-account.ts");
  const account = await readCustomerAccount(db, CUSTOMER_A);
  assert.deepEqual(account.foodOrders, []);
});

test("real execution: GET /api/customer-account surfaces the signed-in customer's Food orders", async () => {
  const { db } = await seedWorld();
  const governance = await import("../lib/food-governance.ts");
  const quote = await governance.createFoodQuote(db, {
    sku: SKU, quantity: 1, zoneId: "blr-east", paymentMode: "sandbox_deferred",
    customerId: CUSTOMER_A, petIds: [PET_ID],
  });
  const order = await governance.createFoodOrder(db, {
    idempotencyKey: "food-activity-2", quoteId: quote.quoteId, customerId: CUSTOMER_A,
    cityId: "blr", zoneId: "blr-east", actorId: CUSTOMER_A,
  });
  const owner = await customerSessionCookie(db, { principalKey: "+919800000222", customerId: CUSTOMER_A });
  const route = await import("../app/api/customer-account/route.ts");
  const response = await route.GET(new Request(`${OPS_ORIGIN}/api/customer-account`, { headers: { cookie: owner.cookie } }));
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const { data } = JSON.parse(raw);
  assert.equal(data.foodOrders.length, 1);
  assert.equal(data.foodOrders[0].id, order.orderId);
});

test("the V2 Activity page renders Fresh Food orders with a link to /v2/food/manage", () => {
  const source = fs.readFileSync(new URL("../app/v2/activity/page.tsx", import.meta.url), "utf8");
  assert.match(source, /account\?\.foodOrders/, "the page must read foodOrders off the customer account");
  assert.match(source, /\/v2\/food\/manage\?orderId=\$\{encodeURIComponent\(x\.id\)\}/, "each Food order must link to its manage page");
});
