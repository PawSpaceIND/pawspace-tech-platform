/*
 * Staging, 26 Sep 2026: a tester's paid Dog Training programme showed on the legacy CRM's "SYNCED TEST RECORD"
 * card as "Awaiting Acceptance" and "Payment: Due After Service" with the full-time PawSpace Training Team
 * (UAT) as provider. The mobile Training flow wrote that record with a hard-coded commission trainer and no
 * payment state, so the pay-after-service fallback applied. The record now carries the trainer's real model
 * and the verified payment: paid in full, or a captured deposit with the balance due before the final session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = new Map();
globalThis.window = {
  localStorage: { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => { store.set(key, String(value)); } },
  dispatchEvent: () => true, addEventListener() {}, removeEventListener() {},
};
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };

const { createTestTransaction } = await import("../lib/test-transaction.ts");
const { trainingTestPayment, trainingTestProviderModel } = await import("../lib/training-test-record.ts");

/** The record exactly as app/mobile-app/training-flow.tsx builds it once the payment page verifies payment. */
const record = (mode, model) => createTestTransaction({
  customerId: `CUST-${mode}-${model}`, customerName: "Shweta", primary: "8000000000", secondary: "", pets: "Maya", petCount: 1,
  service: "Dog Training", packageName: "Basic Obedience Plan", area: "Indiranagar, Bengaluru", slot: "Tue & Sat · 3:00 PM",
  duration: "8 sessions", amount: 12000, ...trainingTestPayment(mode), provider: "PawSpace Training Team (UAT)",
  providerModel: trainingTestProviderModel(model), subscription: "Basic Obedience Plan · 8 sessions", creditsBefore: 8,
  crmOwner: "Unassigned", crmNextAction: "Trainer acceptance", reminder: "In-app reminders queued",
}, `BK-${mode}-${model}`);

test("a split programme with the full-time team: assigned, deposit paid, eight sessions", () => {
  const split = record("split", "full_time");
  assert.equal(split.status, "assigned", "a full-time trainer is assigned, not awaiting acceptance");
  assert.equal(split.paymentStatus, "deposit_paid");
  assert.match(split.payment, /deposit .* balance due before the final session/);
  assert.equal(split.creditsAfter, 8);
  assert.ok(split.events.some((event) => event.label === "Full-time provider assigned automatically"));
});

test("a prepaid programme is paid in full, and only a commission trainer awaits acceptance", () => {
  assert.equal(record("prepaid", "full_time").paymentStatus, "paid");
  assert.equal(record("prepaid", "full_time").status, "assigned");
  const commission = record("prepaid", "commission");
  assert.equal(commission.status, "awaiting_acceptance");
  assert.equal(commission.paymentStatus, "paid", "the payment state never falls back to due after service");
});

test("the mobile Training flow builds its record from the reservation's trainer and the verified payment", () => {
  const flow = readFileSync(new URL("../app/mobile-app/training-flow.tsx", import.meta.url), "utf8");
  assert.match(flow, /\.\.\.trainingTestPayment\(pendingPayment\.mode\)/);
  assert.match(flow, /providerModel:trainingTestProviderModel\(pendingPayment\.trainerModel\)/);
  assert.doesNotMatch(flow, /providerModel:"Commission"/, "no hard-coded commission trainer");
  assert.equal((flow.match(/trainerModel:decision\.provider\.model/g) || []).length, 2, "both the Meet & Greet and the programme carry the reserved trainer's model");
  const panel = readFileSync(new URL("../app/components/test-sync-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /record\.service==="Dog Training"\?"Sessions":"Credits"/, "a Training programme's count reads as sessions");
});
