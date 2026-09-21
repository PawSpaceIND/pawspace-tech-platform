/**
 * LP-D07 - after a 409 geofence refusal ("tap Mark arrived once you are at the address") the Partner
 * app kept the primary "Mark arrived" control disabled forever; only the small "Retry saved updates"
 * banner button could actually deliver the arrival.
 *
 * The root cause was in the offline status queue, not the button itself: once an item failed and was
 * marked with an `error`, enqueueStatus() refused every further attempt for that booking ("This job
 * already has a pending update"), and app/partner-app/page.tsx's `pendingStatus` (which disables the
 * primary control) stayed true for as long as ANY item - failed or not - sat in the queue for that
 * booking. These cases pin the fix at both layers: enqueueStatus now replaces a FAILED item with a fresh
 * attempt (a still-in-flight item is still refused), and the page's pendingStatus computation excludes
 * items that already carry an error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__LPD07_DB__");

const { enqueueStatus, readStatusQueue } = await import("../lib/partner-status-queue.ts");

function withMemoryLocalStorage(t) {
  const disk = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage; });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: undefined });
  globalThis.localStorage = { getItem: k => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, v) };
}

test("LP-D07: a still in-flight (error-free) queued item still refuses a second enqueue for the same booking", (t) => {
  withMemoryLocalStorage(t);
  const providerId = "provider-lpd07", bookingId = "job-lpd07";
  enqueueStatus({ providerId, bookingId, action: "on_the_way", checklist: [] });
  assert.throws(() => enqueueStatus({ providerId, bookingId, action: "arrived", checklist: [] }), /pending update/,
    "a genuinely in-flight item must still block a duplicate attempt");
});

test("LP-D07: a FAILED queued item (409 geofence refusal) is replaced by a fresh attempt instead of refusing forever", (t) => {
  withMemoryLocalStorage(t);
  const providerId = "provider-lpd07b", bookingId = "job-lpd07b";
  const first = enqueueStatus({ providerId, bookingId, action: "arrived", checklist: ["safe_area"] });
  // Simulate what use-status-queue.ts's flush() does on a non-network (permanent) delivery failure:
  // it marks the item with the server's error and leaves it in the queue for the Retry banner.
  const failed = readStatusQueue(providerId).map(item => item.id === first.id ? { ...item, error: "arrival_outside_geofence: tap Mark arrived once you are at the address" } : item);
  localStorage.setItem(`pawspace:partner-status:v1:${encodeURIComponent(providerId)}`, JSON.stringify(failed));

  // The partner walks to the doorstep and taps "Mark arrived" again - a second, fresh enqueue for the
  // very same booking - which must succeed rather than being told "already has a pending update".
  const retryAttempt = enqueueStatus({ providerId, bookingId, action: "arrived", checklist: ["safe_area"] });
  const queue = readStatusQueue(providerId);
  assert.equal(queue.length, 1, "the stale failed entry is replaced, not duplicated");
  assert.equal(queue[0].id, retryAttempt.id, "the fresh attempt is what is now queued");
  assert.equal(queue[0].error, undefined, "the fresh attempt starts clean, ready for delivery");
});

test("LP-D07 source contract: pendingStatus (which disables the primary control) ignores items that already failed", () => {
  const page = readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const pendingStatus=Boolean\(selected&&statusQueue\.pending\.some\(item=>item\.bookingId===selected\.bookingId&&!item\.error\)\);/,
    "an errored (already-failed) queue entry must not keep the primary control disabled forever");
  // The retry banner itself must still be offered regardless of error state - LP-D07 keeps both paths.
  assert.match(page, /statusQueue\.pending\.length>0&&<>/);
  assert.match(page, /Retry saved updates/);
});

test("LP-D07 source contract: enqueueStatus only refuses a duplicate that has not yet failed", () => {
  const lib = readFileSync(new URL("../lib/partner-status-queue.ts", import.meta.url), "utf8");
  assert.match(lib, /if\(existing&&!existing\.error\)throw new Error\("This job already has a pending update\. Sync or resolve it before sending another\."\);/);
  assert.match(lib, /const next=existing\?items\.map\(value=>value\.id===existing\.id\?item:value\):\[\.\.\.items,item\];/,
    "a failed existing item is replaced in place rather than appended alongside");
});
