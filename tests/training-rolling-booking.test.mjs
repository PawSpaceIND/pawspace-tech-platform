/**
 * The customer next-appointment booking machine against the FROZEN rolling contract (slot -> hold -> confirm), driven
 * through a fake client that answers exactly as lib/training-programme-client.ts's loadTrainingRollingSummary and
 * sendTrainingRollingAction do. The frozen helpers themselves are not on this base (origin/main 799cf99), so the
 * structural binding is exercised for its refusal; on the frozen branch the same machine runs against the real
 * functions unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__ROLLING_BOOKING_DB__");
const { createRollingBooking, rollingScheduleGate, frozenRollingClient, ROLLING_NOT_IN_BUILD } = await import("../lib/training-rolling-booking.ts");

const SLOT_A = { start: "2026-10-08T04:30:00.000Z", end: "2026-10-08T05:30:00.000Z" };
const SLOT_B = { start: "2026-10-09T04:30:00.000Z", end: "2026-10-09T05:30:00.000Z" };
const NOW = Date.UTC(2026, 9, 4, 6, 0);
function summary(overrides = {}) {
  return { canSchedule: true, validFrom: "2026-10-04T00:00:00.000Z", validUntil: Date.UTC(2026, 11, 3), remainingSessions: 7, remainingUnallocatedSessions: 6, maxUpcomingSessions: 3, upcomingSessions: [{ id: "S1", start: "2026-10-05T04:30:00.000Z", end: "2026-10-05T05:30:00.000Z", status: "scheduled" }], holds: [], availableSlots: [SLOT_A, SLOT_B], availabilityWindow: { from: "2026-10-05", to: "2026-10-19" }, providerId: "ct_sana", ...overrides };
}
/** A fake frozen client: every call is recorded; `script` decides each sendAction answer in order. */
function fakeClient(script, summaries = [summary()]) {
  const calls = [];
  let loads = 0;
  return {
    calls,
    get loads() { return loads; },
    loadSummary: async (bookingId) => { loads += 1; calls.push({ kind: "summary", bookingId }); return summaries[Math.min(loads - 1, summaries.length - 1)]; },
    sendAction: async (input) => { calls.push({ kind: "action", input }); const step = script.shift(); if (!step) throw new Error("unexpected action"); if (step.throws) throw step.throws; return step.result; },
  };
}
const ids = (prefix) => { let n = 0; return () => `${prefix}${++n}`; };

test("gate: every disabled state is named; booking is allowed only with an assigned trainer and a schedulable summary", () => {
  assert.match(rollingScheduleGate({ assignmentState: "pending", summary: summary(), now: NOW }).reason, /once your trainer is assigned/);
  assert.match(rollingScheduleGate({ assignmentState: "assigned", summary: null, now: NOW }).reason, /Loading/);
  assert.match(rollingScheduleGate({ assignmentState: "assigned", summary: summary({ providerId: null }), now: NOW }).reason, /once your trainer is assigned/);
  assert.match(rollingScheduleGate({ assignmentState: "assigned", summary: summary({ canSchedule: false }), now: NOW }).reason, /paused/);
  assert.match(rollingScheduleGate({ assignmentState: "assigned", summary: summary({ remainingUnallocatedSessions: 0 }), now: NOW }).reason, /already scheduled or used/);
  assert.match(rollingScheduleGate({ assignmentState: "assigned", summary: summary({ remainingUnallocatedSessions: null, remainingSessions: 0 }), now: NOW }).reason, /already scheduled or used/);
  assert.match(rollingScheduleGate({ assignmentState: "assigned", summary: summary({ maxUpcomingSessions: 1 }), now: NOW }).reason, /up to 1 upcoming session at a time/);
  assert.match(rollingScheduleGate({ assignmentState: "assigned", summary: summary({ validUntil: "2026-10-01T00:00:00.000Z" }), now: NOW }).reason, /validity has ended/);
  assert.match(rollingScheduleGate({ assignmentState: "assigned", summary: summary({ availableSlots: [] }), now: NOW }).reason, /no open slot/);
  assert.deepEqual(rollingScheduleGate({ assignmentState: "assigned", summary: summary(), now: NOW }), { ok: true });
});

test("hold then confirm: server-offered slot only, stable hold key, DISTINCT stable confirm key, success only from the server's answer, summary refreshed after confirm", async () => {
  const client = fakeClient([
    { result: { holdId: "H1", expiresAt: NOW + 10 * 60_000, status: "held" } },
    { result: { holdId: "H1", sessionIds: ["S2"], status: "confirmed" } },
  ], [summary(), summary({ upcomingSessions: [{ id: "S1" }, { id: "S2" }], remainingUnallocatedSessions: 5 })]);
  const states = [];
  const machine = createRollingBooking({ bookingId: "BK1", client, now: () => NOW, random: ids("k"), onChange: (state) => states.push(state.phase) });
  await machine.load();
  assert.equal(machine.state.phase, "ready");
  machine.select({ start: "2026-10-10T04:30:00.000Z", end: "2026-10-10T05:30:00.000Z" });
  await machine.hold();
  assert.match(machine.state.error, /slots your trainer offered/); assert.equal(client.calls.filter((c) => c.kind === "action").length, 0, "a slot the server did not offer is never sent");
  machine.select(SLOT_A);
  const holdKey = machine.holdKeyFor(SLOT_A);
  assert.equal(machine.holdKeyFor(SLOT_A), holdKey, "the hold key is stable for the slot");
  await machine.hold();
  const holdCall = client.calls.find((c) => c.kind === "action").input;
  assert.deepEqual(holdCall, { bookingId: "BK1", actorKind: "customer", action: "hold", idempotencyKey: holdKey, slots: [SLOT_A] });
  assert.equal(machine.state.phase, "held"); assert.deepEqual(machine.state.hold, { holdId: "H1", expiresAt: NOW + 10 * 60_000, slot: SLOT_A });
  const confirmKey = machine.confirmKeyFor("H1");
  assert.notEqual(confirmKey, holdKey, "confirm uses its own key"); assert.equal(machine.confirmKeyFor("H1"), confirmKey, "stable per hold");
  await machine.confirm();
  const confirmCall = client.calls.filter((c) => c.kind === "action")[1].input;
  assert.deepEqual(confirmCall, { bookingId: "BK1", actorKind: "customer", action: "confirm", idempotencyKey: confirmKey, holdId: "H1" });
  assert.equal(machine.state.phase, "confirmed"); assert.deepEqual(machine.state.confirmedSessionIds, ["S2"]); assert.match(machine.state.message, /Appointment confirmed/);
  assert.equal(client.loads, 2, "the authoritative summary is reloaded after the confirm");
  assert.equal(machine.state.summary.upcomingSessions.length, 2); assert.equal(machine.state.hold, null);
  assert.deepEqual(states.filter((p, i, a) => a[i - 1] !== p), ["loading", "ready", "holding", "held", "confirming", "confirmed"]);
});

test("a confirm answer that does not confirm is not a success; the hold stays and the same key is reused", async () => {
  const client = fakeClient([
    { result: { holdId: "H1", expiresAt: NOW + 600_000 } },
    { result: { status: "pending_review" } },
    { result: { status: "confirmed", sessionIds: ["S9"] } },
  ]);
  const machine = createRollingBooking({ bookingId: "BK1", client, now: () => NOW, random: ids("k") });
  await machine.load(); machine.select(SLOT_A); await machine.hold(); await machine.confirm();
  assert.equal(machine.state.phase, "held"); assert.match(machine.state.error, /did not verify the confirmation/); assert.equal(machine.state.confirmedSessionIds.length, 0);
  await machine.confirm();
  const confirms = client.calls.filter((c) => c.kind === "action" && c.input.action === "confirm").map((c) => c.input);
  assert.equal(confirms.length, 2); assert.equal(confirms[0].idempotencyKey, confirms[1].idempotencyKey); assert.equal(confirms[1].holdId, "H1");
  assert.equal(client.calls.filter((c) => c.kind === "action" && c.input.action === "hold").length, 1, "never a duplicate hold");
  assert.equal(machine.state.phase, "confirmed");
});

test("an ambiguous confirm (no readable answer) keeps the hold and confirm key; the retry confirms the SAME hold and no second hold is created", async () => {
  const client = fakeClient([
    { result: { holdId: "H1", expiresAt: NOW + 600_000 } },
    { throws: new TypeError("Failed to fetch") },
    { result: { status: "confirmed", sessionIds: ["S3"] } },
  ]);
  const machine = createRollingBooking({ bookingId: "BK1", client, now: () => NOW, random: ids("k") });
  await machine.load(); machine.select(SLOT_A); await machine.hold();
  await machine.confirm();
  assert.equal(machine.state.phase, "held", "ambiguous: still held"); assert.match(machine.state.error, /could not be verified.*may or may not have gone through.*same hold/); assert.doesNotMatch(machine.state.error, /Nothing is booked/, "no false assurance either way");
  assert.equal(machine.state.hold.holdId, "H1");
  await machine.confirm();
  const actions = client.calls.filter((c) => c.kind === "action").map((c) => c.input);
  assert.deepEqual(actions.map((a) => a.action), ["hold", "confirm", "confirm"]);
  assert.equal(actions[1].idempotencyKey, actions[2].idempotencyKey, "the retry reuses the confirm key"); assert.equal(actions[2].holdId, "H1");
  assert.equal(machine.state.phase, "confirmed");
});

test("expiry: a hold past its expiresAt is never confirmed; a definite 'hold expired' refusal clears the hold and the next hold is a NEW attempt with a new key", async () => {
  let clock = NOW;
  const client = fakeClient([
    { result: { holdId: "H1", expiresAt: NOW + 60_000 } },
    { result: { holdId: "H2", expiresAt: NOW + 20 * 60_000 } },
    { throws: new Error("Hold H2 has expired") },
    { result: { holdId: "H3", expiresAt: NOW + 40 * 60_000 } },
  ]);
  const machine = createRollingBooking({ bookingId: "BK1", client, now: () => clock, random: ids("k") });
  await machine.load(); machine.select(SLOT_A); await machine.hold();
  const firstHoldKey = machine.holdKeyFor(SLOT_A);
  clock = NOW + 120_000;
  assert.equal(machine.holdExpired(), true);
  await machine.confirm();
  assert.equal(machine.state.hold, null); assert.match(machine.state.error, /expired/);
  assert.equal(client.calls.filter((c) => c.kind === "action" && c.input.action === "confirm").length, 0, "an expired hold is not sent for confirmation");
  machine.select(SLOT_A); await machine.hold();
  const secondHoldKey = client.calls.filter((c) => c.kind === "action" && c.input.action === "hold")[1].input.idempotencyKey;
  assert.notEqual(secondHoldKey, firstHoldKey, "a new hold after expiry is a new attempt, not a replay of the dead one");
  await machine.confirm();
  assert.equal(machine.state.hold, null); assert.match(machine.state.error, /expired/); assert.equal(machine.state.phase, "ready");
  machine.select(SLOT_A); await machine.hold();
  assert.equal(machine.state.hold.holdId, "H3");
});

test("a hold refusal leaves nothing held; a hold answer without holdId is not a hold", async () => {
  const client = fakeClient([{ throws: new Error("Slot no longer available") }, { result: { status: "held" } }]);
  const machine = createRollingBooking({ bookingId: "BK1", client, now: () => NOW, random: ids("k") });
  await machine.load(); machine.select(SLOT_B); await machine.hold();
  assert.equal(machine.state.hold, null); assert.match(machine.state.error, /Slot no longer available/);
  await machine.hold();
  assert.equal(machine.state.hold, null); assert.match(machine.state.error, /did not hold/);
});

test("the bound client uses installed frozen helpers; a pre-helper base refuses plainly and posts nothing", async () => {
  const client = frozenRollingClient();
  const exports = await import("../lib/training-programme-client.ts");
  if (typeof exports.loadTrainingRollingSummary === "function" && typeof exports.sendTrainingRollingAction === "function") {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
      const body = init.method === "POST" ? JSON.parse(init.body) : null;
      requests.push({url: String(url), body});
      return Response.json({data: body ? {action: "hold", holdId: "H-FROZEN", expiresAt: NOW + 60000} : summary()});
    };
    try {
      assert.deepEqual((await client.loadSummary("BK1")).availableSlots, [SLOT_A, SLOT_B]);
      assert.equal((await client.sendAction({bookingId:"BK1", actorKind:"customer", action:"hold", idempotencyKey:"frozen-hold-key", slots:[SLOT_A]})).holdId, "H-FROZEN");
      assert.match(requests[0].url, /bookingId=BK1&actorKind=customer/);
      assert.deepEqual(requests[1].body, {bookingId:"BK1", actorKind:"customer", action:"hold", idempotencyKey:"frozen-hold-key", slots:[SLOT_A]});
    } finally { globalThis.fetch = originalFetch; }
    return;
  }
  await assert.rejects(() => client.loadSummary("BK1"), new RegExp(ROLLING_NOT_IN_BUILD));
  await assert.rejects(() => client.sendAction({ bookingId: "BK1", actorKind: "customer", action: "hold", idempotencyKey: "k", slots: [SLOT_A] }), new RegExp(ROLLING_NOT_IN_BUILD));
  const machine = createRollingBooking({ bookingId: "BK1", client, now: () => NOW });
  await machine.load();
  assert.equal(machine.state.summary, null); assert.equal(machine.state.error, ROLLING_NOT_IN_BUILD);
  assert.equal(rollingScheduleGate({ assignmentState: "assigned", summary: machine.state.summary, now: NOW }).ok, false);
});

test("regression: reset after an expired hold discards that slot's hold key, so re-selecting the same offered slot is a NEW hold, not a replay of the expired one", async () => {
  let clock = NOW;
  const client = fakeClient([
    { result: { holdId: "H1", expiresAt: NOW + 60_000 } },
    { result: { holdId: "H2", expiresAt: NOW + 30 * 60_000 } },
  ]);
  const machine = createRollingBooking({ bookingId: "BK1", client, now: () => clock, random: ids("k") });
  await machine.load(); machine.select(SLOT_A); await machine.hold();
  const expiredKey = machine.state.hold && client.calls.find((c) => c.kind === "action").input.idempotencyKey;
  clock = NOW + 120_000;
  assert.equal(machine.holdExpired(), true, "the UI hides Confirm here and offers reset");
  machine.reset();
  assert.equal(machine.state.hold, null);
  machine.select(SLOT_A); await machine.hold();
  const holds = client.calls.filter((c) => c.kind === "action" && c.input.action === "hold").map((c) => c.input.idempotencyKey);
  assert.equal(holds.length, 2); assert.notEqual(holds[1], expiredKey, "a fresh key: the expired hold is never replayed");
  assert.equal(machine.state.hold.holdId, "H2");
});

test("regression: only an exact confirming status or returned session ids count as confirmed; not_confirmed, unassigned, pending and unknown statuses stay unconfirmed", async () => {
  const { isConfirmedAnswer } = await import("../lib/training-rolling-booking.ts");
  for (const status of ["not_confirmed", "unassigned", "pending", "confirmation_pending", "unconfirmed", "scheduled_later", "", undefined]) assert.equal(isConfirmedAnswer({ status }), false, String(status));
  for (const status of ["confirmed", "booked", "scheduled", "Confirmed "]) assert.equal(isConfirmedAnswer({ status }), true, status);
  assert.equal(isConfirmedAnswer({ sessionIds: ["S1"] }), true); assert.equal(isConfirmedAnswer({ sessionIds: [] }), false);
  const client = fakeClient([{ result: { holdId: "H1", expiresAt: NOW + 600_000 } }, { result: { status: "not_confirmed" } }, { result: { status: "unassigned" } }]);
  const machine = createRollingBooking({ bookingId: "BK1", client, now: () => NOW, random: ids("k") });
  await machine.load(); machine.select(SLOT_A); await machine.hold();
  await machine.confirm(); assert.equal(machine.state.phase, "held"); assert.match(machine.state.error, /did not verify the confirmation/); assert.equal(machine.state.message, "");
  await machine.confirm(); assert.equal(machine.state.phase, "held"); assert.equal(machine.state.confirmedSessionIds.length, 0);
});

test("regression: an ambiguous confirm never claims nothing was booked; it says the confirmation could not be verified and that the retry reuses the same hold and key", async () => {
  const client = fakeClient([{ result: { holdId: "H1", expiresAt: NOW + 600_000 } }, { throws: new Error("Network error") }]);
  const machine = createRollingBooking({ bookingId: "BK1", client, now: () => NOW, random: ids("k") });
  await machine.load(); machine.select(SLOT_A); await machine.hold(); await machine.confirm();
  assert.match(machine.state.error, /^Network error Your confirmation could not be verified: it may or may not have gone through\. Confirm the same hold again; it uses the same key, so PawSpace will not book it twice\.$/);
  assert.equal(machine.state.hold.holdId, "H1"); assert.equal(machine.state.phase, "held");
});
