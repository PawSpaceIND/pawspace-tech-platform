/**
 * Node 22.16 / Undici 6.21.2: garbage collection of an unretained Request clone can cancel its
 * sibling tee branch, so the gateway's authorization clone could consume the Boarding body before the
 * real scheduling route read it ("Scheduling failed" in the stay latency suite). This drives the real
 * gateway and the real scheduling handler with collections forced in between. It fails with an
 * already-consumed original body when viaWorker dispatches without the request-scoped clone adapter.
 * The gates also clone the gateway's sanitized inspection request; the second test collects throughout
 * a D1-latency dispatch and fails ("unusable") when only the route request's clones are retained.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import * as h from "./helpers/stay-taxi-latency-harness.mjs";

installWorkersHooks("__STAY_GC_DB__", "__STAY_GC_ENV__");
h.stubGeocoding();
const scheduling = await import("../app/api/uat-scheduling/route.ts");

// Real collections without a CLI flag, so the suite runs as-is under both hook paths.
setFlagsFromString("--expose-gc");
const gc = globalThis.gc ?? runInNewContext("gc");

const world = () => h.stayWorld({ dbGlobal: "__STAY_GC_DB__", envGlobal: "__STAY_GC_ENV__", ownRoster: true });
const boardingReserve = (w, clientRequestId) => h.schedulingRequest(w, {
  clientRequestId, petIds: [h.PETS.dog], serviceCode: "boarding", careMode: "visit",
  preferredProviderId: "stay_host_large", scheduledStart: h.ist(3, 10), scheduledEnd: h.ist(3, 14),
});

test("the stay gateway keeps the booking body readable when authorization clones are collected", async () => {
  const w = await world();
  const request = boardingReserve(w, "stay:gc-probe");
  let reached = false;
  await h.viaWorker(w, request, async (original) => {
    for (let i = 0; i < 8; i++) {
      gc();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(original.bodyUsed, false, "gateway clone collection must not consume the route body");
    const response = await scheduling.POST(original);
    assert.equal(response.status, 200, await response.clone().text());
    reached = true;
    return response;
  });
  assert.equal(reached, true, "the gateway must hand the request to the scheduling route");
  assert.equal(Object.hasOwn(request, "clone"), false, "dispatch restores the native clone method");
});

test("the gateway's inspection request survives collections between its authorization gates", async () => {
  const w = await world();
  const request = boardingReserve(w, "stay:gc-gates");
  // Staging-like D1 latency leaves each gate awaiting while collections run.
  w.latency.ms = 40;
  const pressure = setInterval(gc, 1);
  let response;
  try {
    response = await h.viaWorker(w, request, scheduling.POST);
  } finally {
    clearInterval(pressure);
    w.latency.ms = 0;
  }
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(Object.hasOwn(request, "clone"), false, "dispatch restores the native clone method");
});
