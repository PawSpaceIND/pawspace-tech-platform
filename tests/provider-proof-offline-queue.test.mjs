/*
 * The Partner app's offline proof queue, executed against a small in-memory IndexedDB. The defect this pins
 * was seen on staging: the page flushes the queue every 15 s and on `online`, and a photo is queued BEFORE
 * it is registered so it survives a dropped connection; a flush that fired while a fresh photo was still
 * uploading registered the same bytes a second time, leaving a duplicate asset in the Ops review queue that
 * never received its bytes ("upload incomplete" on approval).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dispatchQueuedProof, flushProviderProofQueue, isProviderProofInFlight, providerProofQueueId, queueProviderProof, discardProviderProof, clearProviderProofQueue } from "../lib/provider-proof-offline-queue.ts";

// --- a minimal IndexedDB: one store keyed by id, requests settle on a microtask like the real thing ---
const rows = new Map();
const settle = (fn) => { const req = { onsuccess: null, onerror: null, result: undefined, error: null }; queueMicrotask(() => { try { req.result = fn(); req.onsuccess?.({ target: req }); } catch (error) { req.error = error; req.onerror?.({ target: req }); } }); return req; };
const store = {
  put: (item) => settle(() => { rows.set(item.id, item); return item.id; }),
  get: (id) => settle(() => rows.get(id)),
  delete: (id) => settle(() => { rows.delete(id); return undefined; }),
  clear: () => settle(() => { rows.clear(); return undefined; }),
  getAll: () => settle(() => [...rows.values()]),
};
const database = { objectStoreNames: { contains: () => true }, createObjectStore() {}, transaction: () => ({ objectStore: () => store }), close() {} };
globalThis.indexedDB = { open: () => { const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: database }; queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); }); return req; } };
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });

const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const photo = (purpose, sha256 = "a".repeat(64)) => ({ bookingId: "PS-UAT-1", purpose, file: new Blob(["jpeg"]), fileName: `${purpose}.jpg`, mimeType: "image/jpeg", sizeBytes: 4, sha256 });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test.beforeEach(async () => { await clearProviderProofQueue(); });

test("a queued photo is keyed by booking, purpose and the SHA-256 computed before dispatch; re-adding it replaces, never duplicates", async () => {
  const first = await queueProviderProof(photo("before_service", "AB".repeat(32)));
  const again = await queueProviderProof(photo("before_service", "ab".repeat(32)));
  assert.equal(first.id, providerProofQueueId({ bookingId: "PS-UAT-1", purpose: "before_service", sha256: "ab".repeat(32) }));
  assert.equal(again.id, first.id, "the same bytes for the same booking and purpose share one queue entry");
  assert.equal(first.sha256, "ab".repeat(32), "the digest is normalised before it keys the entry");
  assert.equal(rows.size, 1);
  const other = await queueProviderProof(photo("after_service", "ab".repeat(32)));
  assert.notEqual(other.id, first.id, "the same bytes for another purpose are another entry");
  assert.equal(rows.size, 2);
});

test("two flushes that overlap register a queued photo once (single-flight)", async () => {
  await queueProviderProof(photo("before_service"));
  const gate = deferred(); const calls = [];
  const register = async (item) => { calls.push(item.id); await gate.promise; };
  const a = flushProviderProofQueue(register);
  const b = flushProviderProofQueue(register);
  await tick();
  assert.equal(calls.length, 1, "the second flush joined the first instead of walking the queue again");
  gate.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, { uploaded: 1, pending: 0, discarded: 0, skipped: 0 });
  assert.equal(rb, ra, "both callers observe the one flush");
  assert.equal(rows.size, 0, "the item left the queue once the server had it");
});

test("a flush that runs while the direct upload holds the item skips it: one registration, then the queue is empty", async () => {
  const item = await queueProviderProof(photo("after_service"));
  const gate = deferred(); const calls = [];
  const register = async (queued) => { calls.push(queued.id); await gate.promise; };
  const direct = dispatchQueuedProof(item, register);
  await tick();
  assert.equal(isProviderProofInFlight(item.id), true);
  let flushed;
  try {
    // A flush that ignored the lock would register the item again and then WAIT on the same gate; race it
    // against a short timer so that defect fails as an assertion rather than as a hung test.
    flushed = await Promise.race([flushProviderProofQueue(register), new Promise(resolve => setTimeout(() => resolve("the flush is waiting on the upload it should have skipped"), 100))]);
  } finally { if (calls.length !== 1) gate.resolve(); }
  assert.deepEqual(flushed, { uploaded: 0, pending: 0, discarded: 0, skipped: 1 }, "the flush saw the item but left it to the dispatcher that holds it");
  assert.equal(await dispatchQueuedProof(item, register), "in_flight", "a second direct dispatch sends nothing either");
  assert.equal(calls.length, 1, "exactly one registration for one photo");
  gate.resolve();
  assert.equal(await direct, "uploaded");
  assert.equal(isProviderProofInFlight(item.id), false);
  assert.equal(rows.size, 0, "dispatch removed the item itself; nothing is left for a later flush to re-register");
  assert.deepEqual(await flushProviderProofQueue(register), { uploaded: 0, pending: 0, discarded: 0, skipped: 0 });
  assert.equal(calls.length, 1);
});

test("a permanent refusal is discarded; a transport failure is retried later, not re-sent in the same cycle", async () => {
  const bad = await queueProviderProof(photo("before_service", "b".repeat(64)));
  const flaky = await queueProviderProof(photo("after_service", "c".repeat(64)));
  const calls = [];
  const register = async (item) => {
    calls.push(item.id);
    if (item.id === bad.id) throw Object.assign(new Error("Provider ownership denied"), { permanent: true });
    throw new Error("network dropped");
  };
  const first = await flushProviderProofQueue(register);
  assert.deepEqual(first, { uploaded: 0, pending: 1, discarded: 1, skipped: 0 });
  assert.equal(rows.has(bad.id), false, "a 4xx the server will always repeat is dropped, never re-registered for ever");
  const retry = rows.get(flaky.id);
  assert.equal(retry.attempts, 1);
  assert.ok(retry.nextAttemptAt > Date.now(), "the retry is scheduled with back-off");
  const second = await flushProviderProofQueue(register);
  assert.deepEqual(second, { uploaded: 0, pending: 1, discarded: 0, skipped: 0 });
  assert.equal(calls.length, 2, "an item that is not yet due is not re-sent");
  await discardProviderProof(flaky.id);
  assert.equal(rows.size, 0);
});

test("a dispatch that fails releases the lock and leaves the item queued for the caller to decide", async () => {
  const item = await queueProviderProof(photo("before_service", "d".repeat(64)));
  await assert.rejects(dispatchQueuedProof(item, async () => { throw new Error("timeout"); }), /timeout/);
  assert.equal(isProviderProofInFlight(item.id), false);
  assert.equal(rows.has(item.id), true, "the page decides between discarding (permanent) and leaving it for the flush");
});

test("a lock held by another tab (Web Locks) makes every dispatcher here skip the item instead of registering it a second time", async () => {
  const item = await queueProviderProof(photo("before_service", "e".repeat(64)));
  const heldElsewhere = new Set(); const requests = [];
  // IndexedDB is shared by every open Partner tab; the browser's lock manager is the only lock that spans them.
  navigator.locks = { request: async (name, options, callback) => { requests.push({ name, options }); return callback(heldElsewhere.has(name) ? null : { name }); } };
  try {
    heldElsewhere.add(`pawspace-proof-upload:${item.id}`);
    const calls = []; const register = async (queued) => { calls.push(queued.id); };
    assert.equal(await dispatchQueuedProof(item, register), "in_flight", "the other tab is uploading this photo");
    assert.deepEqual(await flushProviderProofQueue(register), { uploaded: 0, pending: 0, discarded: 0, skipped: 1 });
    assert.equal(calls.length, 0, "nothing was registered while another tab held the photo");
    assert.ok(requests.length >= 2 && requests.every(entry => entry.options?.ifAvailable === true), "a held lock is skipped, never waited for behind the other tab's upload");
    heldElsewhere.clear();
    assert.equal(await dispatchQueuedProof(item, register), "uploaded");
    assert.equal(calls.length, 1); assert.equal(rows.size, 0);
  } finally { delete navigator.locks; }
});

test("a row that left the queue after this walk read it is not sent from the stale copy", async () => {
  const gone = await queueProviderProof(photo("before_service", "f".repeat(64)));
  const kept = await queueProviderProof(photo("after_service", "0".repeat(64)));
  // The walk observes both rows; then "another tab" uploads and removes the first before this tab reaches it.
  const realGetAll = store.getAll;
  store.getAll = () => { store.getAll = realGetAll; return settle(() => { const all = [...rows.values()]; rows.delete(gone.id); return all; }); };
  const calls = [];
  const result = await flushProviderProofQueue(async (item) => { calls.push(item.id); });
  assert.deepEqual(calls, [kept.id], "the row removed after the walk began was never registered");
  assert.deepEqual(result, { uploaded: 1, pending: 0, discarded: 0, skipped: 1 });
  assert.equal(rows.size, 0);
});

test("a session boundary stops a running flush: rows read before logout are neither sent nor re-queued afterwards", async () => {
  const first = await queueProviderProof(photo("before_service", "1".repeat(64)));
  await queueProviderProof(photo("after_service", "2".repeat(64)));
  const gate = deferred(); const calls = [];
  const register = async (item) => { calls.push(item.id); await gate.promise; throw new Error("network dropped"); };
  const flush = flushProviderProofQueue(register);
  await tick();
  assert.deepEqual(calls, [first.id]);
  await clearProviderProofQueue(); // the partner logged out (or switched provider) while the first upload was in flight
  gate.resolve();
  const result = await flush;
  assert.deepEqual(calls, [first.id], "the second row, read before logout, was never sent on behalf of the ended session");
  assert.deepEqual(result, { uploaded: 0, pending: 0, discarded: 0, skipped: 1 });
  assert.equal(rows.size, 0, "the transient failure did not resurrect the ended session's photo in the cleared queue");
});
