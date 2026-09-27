import test from "node:test";
import assert from "node:assert/strict";
import { checkSchedules } from "../e2e/master/suites/_60-transactions-audit-helpers.mjs";

test("cancelled unpaid Taxi is a valid terminal schedule state", () => {
  const fact = {
    service: "pet_taxi",
    paymentId: "PAY-SYNTHETIC",
    b: {
      payment_amount: 868.25,
      amount_due_now: 434.13,
      payment_mode: "split_50_50",
      booking_status: "cancelled",
      payment_status: "cancelled",
    },
    taxi: {
      total_amount: 868.25,
      booking_fee_amount: 434.13,
      balance_amount: 434.12,
      status: "cancelled",
    },
    captures: [],
    capturedSum: 0,
    sandboxCaptured: false,
    saved: { balancePaid: false },
  };
  assert.deepEqual(checkSchedules(fact), []);
});
