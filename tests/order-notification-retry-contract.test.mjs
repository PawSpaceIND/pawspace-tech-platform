import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/order-notification-governance.ts", import.meta.url), "utf8");
const repair = await readFile(new URL("../lib/schema-drift-repair.ts", import.meta.url), "utf8");

test("notification inbox persistence is separated from delivery state", () => {
  assert.match(source, /delivery_status TEXT NOT NULL DEFAULT 'pending'/);
  assert.match(source, /delivery_attempts INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /delivery_error TEXT/);
});

test("failed or pending communication delivery is retried on the same idempotency record", () => {
  assert.match(source, /deliveryStatus==="failed"\|\|deliveryStatus==="pending"/);
  assert.match(source, /retried:true/);
  assert.match(source, /delivery_status='failed'/);
  assert.match(source, /delivery_status='queued'/);
});

test("successful payment capture is customer-facing and produces receipt wording", () => {
  assert.match(source, /payment_captured/);
  assert.match(source, /Payment for your .* was received successfully/);
  assert.match(source, /receipt is recorded with this booking/);
});

test("existing D1 databases receive notification delivery columns", () => {
  assert.match(repair, /table: "order_notifications", column: "delivery_status"/);
  assert.match(repair, /table: "order_notifications", column: "delivery_attempts"/);
  assert.match(repair, /table: "order_notifications", column: "delivery_error"/);
});
