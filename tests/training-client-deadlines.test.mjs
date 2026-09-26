/*
 * Client deadlines on the Training write path, driven with a stubbed fetch and node:test mock timers.
 *
 * Staging master E2E run 36243387701 (commit 7dd8f5c): the V2 Meet & Greet reserve never saw its
 * POST /api/canonical-bookings response and the mobile Basic Obedience reserve showed "The request took too
 * long. Please try again." Both went through the shared apiSend deadline of 20 s, while a Training create is a
 * fixed chain of 55-74 sequential D1 round trips - 14-19 s from the CI runner, so ordinary jitter crossed it.
 * The browser aborted a request the server could still commit.
 *
 *   POST /api/canonical-bookings for dog_training   90 s  (idempotent: replays on idempotencyKey/scheduleGroupId)
 *   every other service's create                    20 s  (unchanged)
 *   POST /api/training-programmes (materialize)     60 s  (follows the create; ~32 round trips)
 *   POST /api/training-sessions (trainer actions)   60 s  (36-70 round trips; complete is the largest)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__TRAINING_CLIENT_DEADLINES_DB__");
const { createCanonicalLifecycle } = await import("../lib/canonical-lifecycle-client.ts");
const { materializeTrainingProgramme } = await import("../lib/training-programme-client.ts");
const { trainingSessionAction, loadTrainerSessions } = await import("../lib/training-session-client.ts");
const { ApiError } = await import("../lib/api-fetch.ts");

const NEVER = Infinity;
/** A server that answers after `answerAfterMs` of (mocked) time, or never, and notices a client abort. */
function stubServer(t, answerAfterMs, body, status = 201) {
  const original = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const call = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null, aborted: false };
    calls.push(call);
    const timer = Number.isFinite(answerAfterMs) ? setTimeout(() => resolve(Response.json(body, { status })), answerAfterMs) : null;
    init.signal?.addEventListener("abort", () => { call.aborted = true; if (timer) clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  });
  return calls;
}
function track(promise) {
  const state = { settled: false };
  state.done = promise.then((value) => { Object.assign(state, { settled: true, value }); }, (error) => { Object.assign(state, { settled: true, error }); });
  return state;
}
/** Let every promise that the elapsed (mocked) time released run to completion. */
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function advance(t, ms) { t.mock.timers.tick(ms); await flush(); await flush(); }

const created = { bookingId: "BK-DEADLINE", customerId: "CUST-A", petIds: ["PET-A"], scheduleGroupId: "GRP-A", workOrderId: "WO-A", paymentId: "PAY-A", status: "payment_pending", duplicatePrevented: false };
const lifecycle = (serviceCode, packageCode) => ({
  idempotencyKey: `deadline:${serviceCode}`, scheduleGroupId: "GRP-A",
  customer: { id: "CUST-A", name: "Asha Rao", primaryPhone: "+919900000801" },
  pets: [{ sourceId: "PET-A", name: "Bruno", species: "dog" }],
  cityId: "blr", zoneId: "blr-east", serviceCode, packageCode, packageName: packageCode,
  scheduledStart: "2026-09-29T05:30:00.000Z", scheduledEnd: "2026-09-29T06:30:00.000Z",
  provider: { id: "train_meera", name: "Meera T.", model: "full_time" },
  totalAmount: 500, amountDueNow: 500,
  payment: { method: "payment_link", mode: "prepaid", status: "created", detail: "Awaiting a verified payment event" },
  pricing: { discount: 0, trainingQuoteId: "TQ-DEADLINE" },
});
const timedOut = (error) => error instanceof ApiError && error.kind === "timeout" && error.message === "The request took too long. Please try again.";

test("a Training create the server answers after 21 s is returned to the booking screen, not reported as a timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = stubServer(t, 21_000, { data: created });
  const request = track(createCanonicalLifecycle(lifecycle("dog_training", "trainer-meet-greet")));
  await advance(t, 20_000);
  assert.equal(request.settled, false, "20 s is no longer the end of a Training create");
  assert.equal(calls[0].aborted, false, "the browser keeps the request open");
  await advance(t, 1_000);
  await request.done;
  assert.equal(request.error, undefined, String(request.error));
  assert.deepEqual(request.value, created);
  assert.deepEqual([calls.length, calls[0].url, calls[0].method, calls[0].body.serviceCode], [1, "/api/canonical-bookings", "POST", "dog_training"]);
});

test("a Training create that never answers still ends with the timeout alert, at 90 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = stubServer(t, NEVER);
  const request = track(createCanonicalLifecycle(lifecycle("dog_training", "training-8-basic")));
  await advance(t, 89_999);
  assert.equal(request.settled, false);
  await advance(t, 1);
  await request.done;
  assert.ok(timedOut(request.error), String(request.error));
  assert.equal(calls[0].aborted, true);
});

test("every other service's create keeps the 20 s budget", async (t) => {
  for (const [serviceCode, packageCode] of [["grooming", "dog-bath"], ["boarding", "boarding-24h"], ["pet_sitting", "sitting-visit-60"]]) {
    await t.test(serviceCode, async (st) => {
      st.mock.timers.enable({ apis: ["setTimeout"] });
      const calls = stubServer(st, 21_000, { data: created });
      const request = track(createCanonicalLifecycle(lifecycle(serviceCode, packageCode)));
      await advance(st, 19_999);
      assert.equal(request.settled, false);
      await advance(st, 1);
      await request.done;
      assert.ok(timedOut(request.error), `${serviceCode}: ${String(request.error)}`);
      assert.equal(calls[0].aborted, true, "the browser gave up at 20 s, before the 21 s answer");
    });
  }
});

test("the programme ledger that follows the create waits 60 s", async (t) => {
  const ledger = { programme: { id: "TP-1", booking_id: "BK-DEADLINE" }, sessions: [{ id: "TS-1" }], events: [], duplicatePrevented: false };
  await t.test("answered at 45 s", async (st) => {
    st.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = stubServer(st, 45_000, { data: ledger });
    const request = track(materializeTrainingProgramme({ bookingId: "BK-DEADLINE" }));
    await advance(st, 45_000);
    await request.done;
    assert.equal(request.error, undefined, String(request.error));
    assert.deepEqual(request.value, ledger);
    assert.deepEqual([calls[0].url, calls[0].method, calls[0].aborted], ["/api/training-programmes", "POST", false]);
  });
  await t.test("never answered", async (st) => {
    st.mock.timers.enable({ apis: ["setTimeout"] });
    stubServer(st, NEVER);
    const request = track(materializeTrainingProgramme({ bookingId: "BK-DEADLINE" }));
    await advance(st, 59_999);
    assert.equal(request.settled, false);
    await advance(st, 1);
    await request.done;
    assert.ok(timedOut(request.error), String(request.error));
  });
});

test("a trainer lifecycle action waits 60 s, and its timeout says the action may already be saved", async (t) => {
  await t.test("complete answered at 45 s", async (st) => {
    st.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = stubServer(st, 45_000, { data: { status: "completed", consumedExactlyOnce: true } });
    const request = track(trainingSessionAction({ sessionId: "TS-1", action: "complete" }));
    await advance(st, 20_000);
    assert.equal(request.settled, false, "the shared 20 s abort no longer cuts a lifecycle action off");
    await advance(st, 25_000);
    await request.done;
    assert.equal(request.error, undefined, String(request.error));
    assert.equal(request.value.status, "completed");
    assert.deepEqual([calls[0].url, calls[0].method, calls[0].body.action, calls[0].aborted], ["/api/training-sessions", "POST", "complete", false]);
  });
  await t.test("start never answered", async (st) => {
    st.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = stubServer(st, NEVER);
    const request = track(trainingSessionAction({ sessionId: "TS-1", action: "start" }));
    await advance(st, 59_999);
    assert.equal(request.settled, false);
    await advance(st, 1);
    await request.done;
    assert.ok(request.error instanceof Error);
    assert.match(request.error.message, /took too long to confirm and may still have been saved/);
    assert.match(request.error.message, /Refresh your sessions to see its current state before trying again/);
    // Every tap is a fresh key, so the shared "replay-safe actions will reuse their idempotency key" is not true here.
    assert.doesNotMatch(request.error.message, /idempotency key/);
    assert.match(calls[0].body.idempotencyKey, /^training:TS-1:start:[0-9a-f-]{36}$/);
  });
  await t.test("reads keep the shared 20 s budget", async (st) => {
    st.mock.timers.enable({ apis: ["setTimeout"] });
    stubServer(st, NEVER);
    const request = track(loadTrainerSessions("train_meera"));
    await advance(st, 20_000);
    await request.done;
    assert.match(String(request.error?.message), /^Network request timed out/);
  });
});
