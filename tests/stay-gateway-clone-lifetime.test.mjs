/**
 * Node 22.16 / Undici 6.21.2: garbage collection of an unretained Request clone can cancel its
 * sibling tee branch, so the gateway's authorization clone could consume the Boarding body before the
 * real scheduling route read it ("Scheduling failed" in the stay latency suite). This drives the real
 * gateway and the real scheduling handler with collections forced in between. It fails with an
 * already-consumed original body when viaWorker dispatches without the request-scoped clone adapter.
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

test("the stay gateway keeps the booking body readable when authorization clones are collected", async () => {
  const w = await h.stayWorld({ dbGlobal: "__STAY_GC_DB__", envGlobal: "__STAY_GC_ENV__", ownRoster: true });
  const request = h.schedulingRequest(w, {
    clientRequestId: "stay:gc-probe", petIds: [h.PETS.dog], serviceCode: "boarding", careMode: "visit",
    preferredProviderId: "stay_host_large", scheduledStart: h.ist(3, 10), scheduledEnd: h.ist(3, 14),
  });
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
