import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/razorpay-capture-atomic.ts", import.meta.url), "utf8");

test("Razorpay capture post-commit pins read-after-write authority checks to D1 primary", () => {
  assert.match(source, /withSession\?\.\("first-primary"\)/,
    "capture post-commit must use a first-primary D1 session after the atomic capture write");
  assert.match(source, /const readDb = firstPrimaryRead\(db\)/);

  assert.match(source, /const verifyDb = firstPrimaryRead\(db\)/,
    "atomic capture commit verification must read its own reconciliation write from primary");
  assert.match(source, /verifyDb\.prepare\("SELECT captured_amount,gateway_status,reconciliation_status FROM payment_reconciliation_records/,
    "atomic capture commit must verify captured reconciliation truth before returning success");
  assert.match(source, /readDb\.prepare\(`SELECT environment FROM payment_gateway_events/,
    "verified gateway evidence must be read from primary before confirmation");
  assert.match(source, /readDb\.prepare\("SELECT captured_amount FROM payment_reconciliation_records/,
    "fresh captured amount must be read from primary before releasing the booking");
  assert.match(source, /readDb\.prepare\("SELECT \* FROM financial_outbox/,
    "the just-claimed capture effects row must be read from primary");
});
