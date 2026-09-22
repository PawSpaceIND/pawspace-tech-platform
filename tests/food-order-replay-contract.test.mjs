import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { customerSessionCookie, freshSqlite, makeD1, nextKey } from "./helpers/taxi-harness.mjs";
installWorkersHooks("__FOOD_REPLAY_DB__");

// CUST-L-D21: a double-tap on "Reserve canonical UAT order" hit the idempotent-replay branch of
// POST /api/food-orders. That branch answered {orderId,status,petIds,duplicatePrevented} only, missing
// totalAmount/inventoryMode/lineId/reservationId/paymentId/... which the confirmation screen renders
// unconditionally (order.totalAmount.toLocaleString(...) etc). The client rendered the replay body as
// a fresh order and threw "Cannot read properties of undefined (reading 'toLocaleString')", which sent
// the route's error boundary up over the whole screen.

const OPS_ORIGIN = "https://ops.pawspace.example";
const foodUrl = (path) => `${OPS_ORIGIN}${path}`;
const CUSTOMER_ID = "CUST-FOOD-REPLAY-1";
const PET_ID = "PET-FOOD-REPLAY-1";
const SKU = "food-uat-dog-adult-2kg";

function seedCustomerAndPet(sqlite) {
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,'Indie','verified',NULL,?,?)")
    .run(PET_ID, CUSTOMER_ID, "Rocky", "dog", now, now);
}

async function world() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__FOOD_REPLAY_DB__ = db;
  seedCustomerAndPet(sqlite);
  const owner = await customerSessionCookie(db, { principalKey: "+919800000456", customerId: CUSTOMER_ID });
  return { sqlite, db, cookie: owner.cookie };
}

test("a double-tap on Reserve replays the SAME order contract as the first response (CUST-L-D21)", async () => {
  const { db, cookie } = await world();
  const governance = await import("../lib/food-governance.ts");
  const quote = await governance.createFoodQuote(db, {
    sku: SKU, quantity: 1, zoneId: "blr-east", paymentMode: "sandbox_deferred",
    customerId: CUSTOMER_ID, petIds: [PET_ID],
  });
  const route = await import("../app/api/food-orders/route.ts");
  const idempotencyKey = nextKey("food-double-tap");
  const post = () => route.POST(new Request(foodUrl("/api/food-orders"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: foodUrl("") },
    body: JSON.stringify({
      idempotencyKey, quoteId: quote.quoteId,
      customer: { id: CUSTOMER_ID, name: "Replay Customer", primaryPhone: "9800000456" },
      cityId: "blr", zoneId: "blr-east",
    }),
  }));

  const first = await post();
  const firstRaw = await first.text();
  assert.equal(first.status, 201, firstRaw);
  const { data: fresh } = JSON.parse(firstRaw);
  assert.equal(fresh.duplicatePrevented, false);

  const second = await post();
  const secondRaw = await second.text();
  assert.equal(second.status, 200, secondRaw);
  const { data: replay } = JSON.parse(secondRaw);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.orderId, fresh.orderId);

  // The exact field the browser crash read: order.totalAmount.toLocaleString(...).
  assert.equal(typeof replay.totalAmount, "number");
  assert.ok(Number.isFinite(replay.totalAmount), `totalAmount must be a finite number: ${JSON.stringify(replay)}`);
  assert.equal(replay.totalAmount, fresh.totalAmount);

  // The replay must be the SAME contract as the first response, not a thinner subset of it.
  assert.deepEqual(Object.keys(replay).sort(), Object.keys(fresh).sort());
  for (const field of ["lineId", "reservationId", "paymentId"]) {
    assert.equal(typeof replay[field], "string");
    assert.ok(replay[field].length > 0, `${field} must be populated on replay too`);
  }
  assert.equal(replay.inventoryMode, fresh.inventoryMode);
  assert.equal(replay.deliveryStatus, fresh.deliveryStatus);
  assert.equal(replay.productionInventoryVerified, false);
  assert.equal(replay.liveMoney, false);
  assert.deepEqual(replay.petIds, fresh.petIds);
});

test("the canonical Food page guards against a double submit and never crashes on the replay body", () => {
  const source = fs.readFileSync(new URL("../app/food/canonical-food-page.tsx", import.meta.url), "utf8");
  // A ref-based reentrancy guard, not just the (React-batched, stale-at-call-time) orderLoading state,
  // so two click handlers firing before the disabled attribute commits still send one request.
  assert.match(source, /orderInFlightRef/, "orderNow() must guard reentrancy with a ref, not only state");
  assert.match(source, /if\(!quote\|\|orderInFlightRef\.current\)return;/, "the guard must be checked synchronously at call time");
  // Defence in depth on the render side: even a thinner order body must not crash the confirmation.
  assert.match(source, /Number\(order\.totalAmount\?\?0\)\.toLocaleString/, "totalAmount must render safely even if absent");
});
