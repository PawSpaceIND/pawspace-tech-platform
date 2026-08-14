import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * A booking that was paid must be recorded as paid.
 *
 * The money state used to be inferred by matching the customer-facing payment sentence against two
 * exact strings ("Paid online", "Subscription credit"). Every sentence that read naturally missed:
 * Boarding and Sitting stays, Training programmes, and any Grooming booking with a coupon appended
 * all fell through to "due_after_service". Paid bookings were filed as unpaid and every finance
 * screen counted them that way - silently, because nothing errored.
 *
 * These tests fail if the inference ever comes back, and if any flow stops declaring its money state.
 */

/** The module is browser-only; give it just enough window to run under the test runner. */
function withBrowserStorage() {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  return () => { delete globalThis.window; delete globalThis.CustomEvent; };
}

const baseBooking = {
  customerId: "CUS-001", customerName: "UAT Customer", primary: "9999999999", secondary: "",
  pets: "Bruno", petCount: 1, service: "Boarding", packageName: "Luxury Stay", area: "Whitefield",
  slot: "10:00", duration: "3 nights", amount: 2097, provider: "Priya & Dev",
  providerModel: "Full-time", subscription: "None", creditsBefore: 0,
  crmOwner: "asha.rao@pawspace.in", crmNextAction: "Confirm check-in", reminder: "Queued",
};

test("a paid stay is recorded as paid, whatever its payment sentence says", async () => {
  const restore = withBrowserStorage();
  try {
    const { createTestTransaction, clearTestLedger } = await import("../lib/test-transaction.ts");
    clearTestLedger();

    // The exact sentence Boarding sends. Under the old inference this recorded as due_after_service.
    const paidStay = createTestTransaction({
      ...baseBooking,
      payment: "Paid in UAT sandbox from canonical Boarding quote",
      paymentState: "paid",
    });
    assert.equal(paidStay.paymentStatus, "paid");

    // A coupon suffix is display text and must not change the money state - this is what broke Grooming.
    const paidWithCoupon = createTestTransaction({
      ...baseBooking, service: "Grooming",
      payment: "Paid online · Coupon MONSOON20",
      paymentState: "paid",
    });
    assert.equal(paidWithCoupon.paymentStatus, "paid");

    // A split stay genuinely owes its balance, and must still say so.
    const splitStay = createTestTransaction({
      ...baseBooking,
      payment: "50% deposit paid in UAT sandbox · ₹1,048 due 24 hours before check-in",
      paymentState: "due_after_service",
    });
    assert.equal(splitStay.paymentStatus, "due_after_service");

    // Subscription credit reserves rather than collects.
    const credit = createTestTransaction({
      ...baseBooking, payment: "Subscription credit", paymentState: "credit_reserved",
    });
    assert.equal(credit.paymentStatus, "credit_reserved");
  } finally { restore(); }
});

test("no flow infers the money state from the payment sentence", async () => {
  const source = await readFile(new URL("../lib/test-transaction.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /input\.payment===/, "money state must come from paymentState, never from the payment sentence");

  const flows = [
    "app/page.tsx", "app/test-lab/page.tsx",
    "app/mobile-app/grooming-flow.tsx", "app/mobile-app/training-flow.tsx", "app/mobile-app/stay-flow.tsx",
  ];
  for (const flow of flows) {
    const body = await readFile(new URL(`../${flow}`, import.meta.url), "utf8");
    if (!body.includes("createTestTransaction(")) continue;
    assert.match(body, /paymentState\s*:/, `${flow} books a transaction without declaring its money state`);
  }
});
