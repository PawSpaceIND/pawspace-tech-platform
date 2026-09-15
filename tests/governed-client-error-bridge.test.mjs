import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// [PTJA-AUTHERR-422] backend/src/* raises client faults the Fastify way - a plain Error carrying
// `statusCode` - because it is a standalone app that imports nothing from lib/. The same functions
// are also called from app/api/* routes, where the catch lands in authError(), which trusted Response
// objects ONLY. Every scheduling validation refusal therefore reached the customer as
// `500 {"error":"Scheduling failed"}`: the caller never learned what to change, and bad input was
// reported to monitoring as a server fault.
//
// The bridge is deliberately opt-in by a registry-symbol brand, NOT by the presence of `statusCode`,
// so that an incidental statusCode from a fetch/undici/Fastify-internal error can never put an
// upstream message (or a URL carrying a token) in front of a caller. The last three tests are that
// guarantee, and the ratchet keeps new throw sites on the helper.
// ---------------------------------------------------------------------------

nodeModule.register(new URL("./helpers/ts-extension-loader.mjs", import.meta.url));

const { buildOccurrences } = await import("../backend/src/scheduling.ts");
const { authError } = await import("../lib/server-auth.ts");

const BRAND = Symbol.for("pawspace.governed-client-error");
const base = {
  cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training", petIds: ["p1"],
  scheduledStart: "2026-11-01T10:00:00.000Z", scheduledEnd: "2026-11-01T11:00:00.000Z",
  occurrences: 1, cadenceDays: 7,
};
function refusalFor(patch) {
  try { buildOccurrences({ ...base, ...patch }); } catch (error) { return error; }
  throw new Error("buildOccurrences accepted input that should have been refused");
}

const REFUSALS = [
  ["occurrences above the catalogue ceiling", { occurrences: 999 }, /Occurrences must be between 1 and \d+/],
  ["scheduled end not after start", { scheduledEnd: "2026-11-01T09:00:00.000Z" }, /Scheduled end must be after start/],
  ["recurring cadence below one day", { occurrences: 3, cadenceDays: 0 }, /cadence must be at least one day/],
  ["recurring weekdays out of range", { occurrences: 3, weekdays: [9] }, /weekdays must use values/],
];

for (const [label, patch, expected] of REFUSALS) {
  test(`a scheduling refusal (${label}) reaches the caller as 422 with its real reason`, async () => {
    const error = refusalFor(patch);
    const response = authError(error, "Scheduling failed");
    assert.equal(response.status, 422, `${label} should be 422, not ${response.status}`);
    const body = await response.json();
    assert.match(String(body.error), expected);
    assert.notEqual(body.error, "Scheduling failed", "the caller must not get the generic fallback");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
}

test("the Fastify convention is preserved so backend/src/app.ts still maps these itself", () => {
  // backend/src/app.ts's setErrorHandler reads `statusCode` off the error. Branding must not
  // have replaced that mechanism, or every Fastify route would start answering 500 instead.
  for (const [, patch] of REFUSALS) {
    const error = refusalFor(patch);
    assert.equal(error.statusCode, 422);
    assert.ok(error instanceof Error);
    const status = error.statusCode ?? 500;
    assert.equal(status, 422, "Fastify's own handler must still derive 422 from the error");
  }
});

test("an UNBRANDED error carrying statusCode is still redacted to 500", async () => {
  // The shape a fetch/undici/Fastify-internal failure has. Surfacing this would leak upstream
  // detail - here a URL with a token in it - to whoever made the request.
  const leaky = Object.assign(new Error("GET https://vendor.example/v1/x?api_key=sk_live_SECRET failed"), { statusCode: 404 });
  const response = authError(leaky, "Scheduling failed");
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "Scheduling failed");
  assert.ok(!JSON.stringify(body).includes("sk_live_SECRET"), "an unbranded message must never reach the caller");
});

test("a brand that is not literally true is not trusted", async () => {
  const spoofed = Object.assign(new Error("internal detail"), { statusCode: 403, [BRAND]: "yes" });
  const response = authError(spoofed, "Request failed");
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "Request failed");
});

test("a branded error outside 4xx is not surfaced", async () => {
  for (const statusCode of [500, 503, 302, 200]) {
    const error = Object.assign(new Error("upstream detail"), { statusCode, [BRAND]: true });
    const response = authError(error, "Request failed");
    assert.equal(response.status, 500, `statusCode ${statusCode} must not be surfaced`);
    assert.equal((await response.json()).error, "Request failed");
  }
});

test("RATCHET: every 4xx throw in backend/src/scheduling.ts goes through the branded helper", () => {
  const source = readFileSync(new URL("../backend/src/scheduling.ts", import.meta.url), "utf8");
  const helper = source.slice(source.indexOf("function clientError("));
  const body = helper.slice(0, helper.indexOf("\n}") + 2);
  assert.match(body, /Symbol\.for\("pawspace\.governed-client-error"\)/, "the helper must set the brand");
  assert.match(body, /statusCode/, "the helper must keep statusCode for Fastify");

  const outsideHelper = source.replace(body, "");
  const raw = [...outsideHelper.matchAll(/Object\.assign\(\s*new Error\([^)]*\)\s*,\s*\{\s*statusCode:\s*(4\d{2})/g)];
  assert.deepEqual(
    raw.map((m) => m[0]), [],
    "a 4xx client fault was raised without clientError(), so it will collapse to a 500 again",
  );
  assert.ok(outsideHelper.split("clientError(").length - 1 >= 9, "clientError() call sites disappeared");
});
