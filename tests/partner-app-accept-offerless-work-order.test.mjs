/*
 * "Accept job" dead-ended on a work order that IS awaiting acceptance.
 *
 * The screen offers Accept whenever the booking reads `confirmed` or `awaiting_acceptance`
 * (app/partner-app/page.tsx nextAction), then sends a commission provider to
 * /api/provider-assignment-recovery - which accepts only while a PENDING, UNEXPIRED row exists in
 * provider_assignment_offers. Two different preconditions behind one button. Measured on an e2e work
 * order at awaiting_acceptance with an empty offers table: 409 "No pending provider offer is
 * available", while POST /api/grooming-lifecycle {"action":"accept"} took the SAME booking from
 * confirmed to assigned. The offer-less and expired-offer states were a dead end with a working path
 * sitting next to them.
 *
 * The fixture that produced it is not the defect. The defect is that the button's precondition is not
 * the endpoint's, and nothing covered the gap.
 *
 * These tests EXECUTE the shipped accept path (exported from the page module) against a stubbed
 * network, because what is being fixed is exactly which requests it makes and in what order.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PARTNER_ACCEPT_DB__");

const BOOKING = "E2E-BK-UI-001", PROVIDER = "prv_commission_1";

/** Record every request the accept path makes, answering each endpoint from `answers`. */
function network(answers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null, method: init.method });
    const answer = answers[path];
    if (!answer) throw new Error(`unexpected request to ${path}`);
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  return calls;
}
const OFFER = "/api/provider-assignment-recovery";
const WORK_ORDER = "/api/grooming-lifecycle";
const accept = async () => (await import("../app/partner-app/page.tsx")).respondToCommissionAssignment;

const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });

test("ACCEPT-1 an offer-less work order is accepted through the work-order path instead of dead-ending", async () => {
  // The reported state: provider_work_orders.status='awaiting_acceptance' with no offer row at all.
  const calls = network({
    [OFFER]: { status: 409, body: { error: "No pending provider offer is available" } },
    [WORK_ORDER]: { status: 200, body: { data: { booking: { status: "assigned" } } } },
  });
  const result = await (await accept())({ bookingId: BOOKING, providerId: PROVIDER, action: "accept" });

  assert.equal(result.path, "work_order", "the accept must complete, not surface the 409 to the partner");
  assert.equal(result.offerRefusal, "No pending provider offer is available", "and why the offer path could not serve it is kept");
  assert.deepEqual(calls.map((call) => call.path), [OFFER, WORK_ORDER], "the offer path is still tried FIRST");
  assert.deepEqual(calls[1].body, { bookingId: BOOKING, action: "accept", actorId: PROVIDER },
    "the fallback is the canonical work-order accept the button's own precondition describes");
});

test("ACCEPT-2 an expired offer is no longer a dead end either", async () => {
  const calls = network({
    [OFFER]: { status: 409, body: { error: "Provider offer has expired; replacement is required" } },
    [WORK_ORDER]: { status: 200, body: { data: {} } },
  });
  const result = await (await accept())({ bookingId: BOOKING, providerId: PROVIDER, action: "accept" });
  assert.equal(result.path, "work_order");
  assert.equal(calls.length, 2);
});

test("ACCEPT-3 when there IS an offer, the offer path still wins and nothing else is called", async () => {
  // The offer response is the one that closes the offer, scores acceptance telemetry and resolves the
  // recovery case. The fallback must never take work away from it.
  const calls = network({ [OFFER]: { status: 200, body: { data: { status: "assigned" } } } });
  const result = await (await accept())({ bookingId: BOOKING, providerId: PROVIDER, action: "accept" });
  assert.equal(result.path, "assignment_offer");
  assert.deepEqual(calls.map((call) => call.path), [OFFER], "no second request may be made once the offer path succeeded");
});

test("ACCEPT-4 a job that genuinely cannot be accepted is still refused, with BOTH reasons", async () => {
  // Not a bypass: /api/grooming-lifecycle re-checks provider ownership and its own transition table.
  const calls = network({
    [OFFER]: { status: 409, body: { error: "No pending provider offer is available" } },
    [WORK_ORDER]: { status: 409, body: { error: "Action accept is not allowed from completed" } },
  });
  await assert.rejects(
    async () => (await accept())({ bookingId: BOOKING, providerId: PROVIDER, action: "accept" }),
    (error) => /No pending provider offer is available/.test(error.message) && /not allowed from completed/.test(error.message),
    "the partner must be told what both paths said, not one opaque refusal",
  );
  assert.deepEqual(calls.map((call) => call.path), [OFFER, WORK_ORDER]);
});

test("ACCEPT-5 the fallback is only for 409 - an authorization refusal fails closed", async () => {
  // A 403 says this session may not act on this booking at all. Retrying elsewhere would be shopping
  // for a second opinion on a security answer.
  const calls = network({ [OFFER]: { status: 403, body: { error: "Provider ownership denied" } } });
  await assert.rejects(
    async () => (await accept())({ bookingId: BOOKING, providerId: PROVIDER, action: "accept" }),
    /Provider ownership denied/,
  );
  assert.deepEqual(calls.map((call) => call.path), [OFFER], "no fallback may be attempted after a 403");
});

test("ACCEPT-6 decline keeps the offer path alone", async () => {
  // There is no work-order equivalent of declining an offer, so a decline must report its own refusal
  // rather than pretending to have another route.
  const calls = network({ [OFFER]: { status: 409, body: { error: "No pending provider offer is available" } } });
  await assert.rejects(
    async () => (await accept())({ bookingId: BOOKING, providerId: PROVIDER, action: "decline" }),
    /No pending provider offer is available/,
  );
  assert.deepEqual(calls.map((call) => call.path), [OFFER]);
});

test("ACCEPT-7 a decline that the offer path CAN serve still works", async () => {
  const calls = network({ [OFFER]: { status: 200, body: { data: { status: "ops_escalation" } } } });
  const result = await (await accept())({ bookingId: BOOKING, providerId: PROVIDER, action: "decline" });
  assert.equal(result.path, "assignment_offer");
  assert.equal(calls[0].body.action, "decline");
  assert.equal(calls[0].body.reason, "Declined in mobile Partner app", "the recovery reason the endpoint records is unchanged");
});

test("ACCEPT-8 the Accept button is wired to this path, not to a bare offer request", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
  const act = page.slice(page.indexOf("const act = async (action:"));
  assert.ok(act.includes("respondToCommissionAssignment("), "the commission accept/decline branch must use the shared path");
  assert.ok(!act.includes('fetch("/api/provider-assignment-recovery"'),
    "an inline offer-only request in act() is the dead end this change removed");
});
