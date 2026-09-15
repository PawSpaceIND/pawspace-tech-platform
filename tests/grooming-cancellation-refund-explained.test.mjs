/**
 * DEFECT: "Estimated refund: Rs0.00" with no explanation, beside a Rs2,298 booking total.
 *
 * The NUMBER is right. GET /api/grooming-booking-change returns refundAmount 0 for
 * PS-UAT-MU26QM0N-AE3F because it is a pay_after_service booking with amount_due_now 0 and nothing
 * captured, and it says so itself:
 *   reasons: ["No cancellation fee: return the amount actually paid before service starts"]
 * The policy card never rendered `cancellation.reasons`, so the customer read a bare Rs0.00 next to
 * their booking total and could reasonably conclude they were forfeiting the money.
 *
 * These tests EXECUTE the real GroomingChangePolicy component - its preview fetch runs, its state
 * settles - and read the words that end up on the customer's screen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount, textOf } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__GROOMING_REFUND_REASON_DB__");

const { default: GroomingChangePolicy } = await import("../app/grooming/manage/grooming-change-policy.tsx");

const BOOKING = "PS-UAT-MU26QM0N-AE3F";
const PAY_AFTER_SERVICE_REASON = "No cancellation fee: return the amount actually paid before service starts";

/** The preview body the route really returns for the reported booking. */
const preview = (overrides = {}) => ({
  consentRevision: "rev-1", bookingId: BOOKING, currency: "INR", durationMinutes: 120,
  reschedule: { allowed: true, feeAmount: 0, reasons: [] },
  cancellation: { mode: "cancel", refundAmount: 0, reasons: [PAY_AFTER_SERVICE_REASON] },
  policyVersion: "v1", refundPolicyVersion: "v1",
  ...overrides,
});

function installFetch(body) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/grooming-booking-change\?bookingId=/, "the card reads the governed preview");
    return new Response(JSON.stringify({ data: body }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return () => { globalThis.fetch = original; };
}

async function policyCard(body) {
  const restore = installFetch(body);
  const app = mount(GroomingChangePolicy, { bookingId: BOOKING, customerId: "E2E-CUS-UI-001", onChanged: () => {} }, { label: "GroomingChangePolicy" });
  await app.settle();
  restore();
  // textOf walks this card's own elements; the reschedule/cancel FORMS are separate components and
  // are not rendered here, so every word asserted below belongs to the policy card itself.
  return textOf(app.tree());
}

// ---------------------------------------------------------------------------------------------
test("a zero refund on a pay-after-service booking is explained, not left bare", async () => {
  const text = await policyCard(preview());
  assert.match(text, /Cancellation eligible/, "the card rendered at all");
  assert.match(text, /Estimated refund: ₹0\.00/, "the amount is still shown, unchanged");
  assert.match(text, new RegExp(PAY_AFTER_SERVICE_REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "and the server's own explanation of that amount is now on the screen with it");
});

test("a real money refund keeps its own reasons alongside the amount", async () => {
  const text = await policyCard(preview({ cancellation: { mode: "cancel", refundAmount: 1500, reasons: ["Cancelled more than 24 hours before the visit: full refund of the captured amount"] } }));
  assert.match(text, /Estimated refund: ₹1,500\.00/);
  assert.match(text, /full refund of the captured amount/);
});

test("an unavailable cancellation - which printed nothing at all - now says why", async () => {
  const text = await policyCard(preview({ cancellation: { mode: "unavailable", refundAmount: null, reasons: ["This service has already started"] } }));
  assert.match(text, /Cancellation unavailable/);
  assert.match(text, /This service has already started/);
});

test("no reasons means no empty list is drawn", async () => {
  const text = await policyCard(preview({ cancellation: { mode: "cancel", refundAmount: 0, reasons: [] } }));
  assert.match(text, /Estimated refund: ₹0\.00/);
  assert.doesNotMatch(text, new RegExp(PAY_AFTER_SERVICE_REASON.slice(0, 20)), "nothing is invented when the server sends no reason");
});
