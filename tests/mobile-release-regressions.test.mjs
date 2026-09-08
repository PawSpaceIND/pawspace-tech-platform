import test from "node:test";
import assert from "node:assert/strict";
import { assertSandboxPaymentLocks } from "../lib/mobile/razorpay.ts";
import { clearOfflineQueue, enqueueOfflineTelemetry, flushOfflineQueue, getOfflineQueue } from "../lib/mobile/offline-queue.ts";

test("payment locks reject absent, empty, and malformed explicit configuration", () => {
  const safe = { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };
  assert.doesNotThrow(() => assertSandboxPaymentLocks(safe));
  assert.throws(() => assertSandboxPaymentLocks({}));
  for (const key of Object.keys(safe)) {
    for (const value of [undefined, null, "", "unexpected"]) {
      assert.throws(() => assertSandboxPaymentLocks({ ...safe, [key]: value }), `${key}: ${value}`);
    }
  }
  assert.throws(() => assertSandboxPaymentLocks({ ...safe, FORBID_PRODUCTION: false }));
});

const packet = (id) => ({ type: "gps_coordinate", endpoint: "/api/walking-proof", payload: { idempotencyKey: id } });

test("queue preserves conflicts and failures beyond five retries", async () => {
  const originalFetch = globalThis.fetch;
  await clearOfflineQueue();
  try {
    await enqueueOfflineTelemetry(packet("retry"));
    globalThis.fetch = async () => ({ ok: false, status: 409 });
    for (let attempt = 0; attempt < 7; attempt++) {
      assert.deepEqual(await flushOfflineQueue(), { flushed: 0, remaining: 1 });
    }
    assert.equal((await getOfflineQueue())[0].retryCount, 7);
  } finally {
    globalThis.fetch = originalFetch;
    await clearOfflineQueue();
  }
});

test("concurrent enqueues and flush calls neither duplicate nor lose updates", async () => {
  const originalFetch = globalThis.fetch;
  await clearOfflineQueue();
  try {
    await Promise.all(Array.from({ length: 10 }, (_, i) => enqueueOfflineTelemetry(packet(`first-${i}`))));
    assert.equal((await getOfflineQueue()).length, 10);
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    let requests = 0;
    globalThis.fetch = async () => { requests++; started(); await delayed; return { ok: true, status: 200 }; };
    const first = flushOfflineQueue();
    await ready;
    const second = flushOfflineQueue();
    assert.equal(first, second);
    await enqueueOfflineTelemetry(packet("arrived-during-flush"));
    release();
    assert.deepEqual(await first, { flushed: 10, remaining: 1 });
    assert.equal(requests, 10);
    assert.equal((await getOfflineQueue())[0].payload.idempotencyKey, "arrived-during-flush");
  } finally {
    globalThis.fetch = originalFetch;
    await clearOfflineQueue();
  }
});

test("storage failure rejects saving instead of claiming durable delivery", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  await clearOfflineQueue();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => null,
    setItem: () => { throw new Error("QuotaExceededError"); },
  } });
  try {
    await assert.rejects(enqueueOfflineTelemetry(packet("quota")), /Could not save this update/);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
    await clearOfflineQueue();
  }
});
