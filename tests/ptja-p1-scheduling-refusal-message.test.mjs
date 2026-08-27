/**
 * PHASE 1 (browser end-to-end) - the customer-facing scheduling refusal. [PTJA-P1-UI]
 *
 * MEASURED IN A REAL BROWSER. Signed in as a real customer created through the real OTP path, with a
 * pet and a Bengaluru address on file, /training resolved its zone, listed an eligible trainer, enabled
 * the booking button, and on click showed the customer exactly this:
 *
 *     NO_SCHEDULE_AVAILABLE
 *
 * The refusal itself is correct - no trainer had published availability for the chosen date, and the
 * server said so precisely, returning
 *   {"error":"NO_SCHEDULE_AVAILABLE","evaluations":[{"providerName":"Kiran S.","eligible":false,
 *     "reasons":["No published availability on 2026-08-30"]}]}
 *
 * Two things are wrong with what reaches the person:
 *   1. A machine code is rendered verbatim as customer copy.
 *   2. The server COMPUTED the human explanation - "No published availability on 2026-08-30" - and
 *      lib/uat-scheduling-client.ts threw it away, keeping only `body.error`.
 *
 * This is not a security or money defect. It is the difference between a customer who knows to pick
 * another date and a customer who sees a stack-trace fragment and leaves.
 */
import test from "node:test";
import assert from "node:assert/strict";

const CODES = ["NO_SCHEDULE_AVAILABLE", "SLOT_TAKEN"];

async function withStubbedFetch(payload, status, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  try { return await run(); } finally { globalThis.fetch = real; }
}

const REQUEST = {
  clientRequestId: "REQ-1", customerId: "CUS-1", petIds: ["PET-1"], serviceCode: "dog_training",
  zoneId: "blr-east", occurrences: [], packageCode: "TRAIN-STARTER",
};

test("UI-01: a scheduling refusal never shows the customer a raw error code", async () => {
  const { reserveUatSchedule } = await import("../lib/uat-scheduling-client.ts");
  for (const code of CODES) {
    const outcome = await withStubbedFetch({ error: code }, 409, () =>
      reserveUatSchedule(REQUEST).then(() => ({ ok: true }), (e) => ({ ok: false, message: String(e.message) })));
    assert.equal(outcome.ok, false, `${code} must still refuse`);
    assert.doesNotMatch(outcome.message, /[A-Z]{3,}_[A-Z_]{3,}/,
      `the customer must not be shown the raw code ${code}: ${JSON.stringify(outcome.message)}`);
    assert.ok(outcome.message.length > 20 && /\s/.test(outcome.message),
      `and must get a sentence, not a token: ${JSON.stringify(outcome.message)}`);
  }
});

test("UI-02: the server's own per-provider reason reaches the customer when it has one", async () => {
  // The whole point: the explanation exists and was being discarded.
  const { reserveUatSchedule } = await import("../lib/uat-scheduling-client.ts");
  const payload = {
    error: "NO_SCHEDULE_AVAILABLE",
    evaluations: [
      { providerId: "train_kiran", providerName: "Kiran S.", eligible: false, reasons: ["No published availability on 2026-08-30"] },
      { providerId: "train_asha", providerName: "Asha R.", eligible: false, reasons: ["No published availability on 2026-08-30"] },
    ],
  };
  const outcome = await withStubbedFetch(payload, 409, () =>
    reserveUatSchedule(REQUEST).then(() => ({ ok: true }), (e) => ({ ok: false, message: String(e.message) })));
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /no published availability on 2026-08-30/i,
    `the reason the server already computed must reach the person: ${JSON.stringify(outcome.message)}`);
});

test("UI-03: an unknown future code still yields a sentence, not the token", async () => {
  // Fail-safe: a code this mapping has never seen must not fall through to raw output.
  const { reserveUatSchedule } = await import("../lib/uat-scheduling-client.ts");
  const outcome = await withStubbedFetch({ error: "SOME_FUTURE_REFUSAL_CODE" }, 409, () =>
    reserveUatSchedule(REQUEST).then(() => ({ ok: true }), (e) => ({ ok: false, message: String(e.message) })));
  assert.equal(outcome.ok, false);
  assert.doesNotMatch(outcome.message, /SOME_FUTURE_REFUSAL_CODE/,
    `an unmapped code must not be shown verbatim: ${JSON.stringify(outcome.message)}`);
});

test("UI-04 (non-vacuity): a successful reservation is still returned unchanged", async () => {
  const { reserveUatSchedule } = await import("../lib/uat-scheduling-client.ts");
  const data = { groupId: "GRP-1", provider: { id: "train_kiran", name: "Kiran S.", model: "commission" }, mode: "automatic", occurrences: [] };
  const outcome = await withStubbedFetch({ data }, 200, () =>
    reserveUatSchedule(REQUEST).then((value) => ({ ok: true, value }), (e) => ({ ok: false, message: String(e.message) })));
  assert.equal(outcome.ok, true, `a good reservation must pass through: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.value.groupId, "GRP-1");
});
