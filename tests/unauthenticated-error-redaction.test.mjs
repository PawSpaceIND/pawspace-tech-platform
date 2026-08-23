import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// LEAK-2: unauthenticated routes must not echo an internal error message.
//
// PR #255 (LEAK-1) established authError() as the governed boundary: an
// intentional, safe Response passes through, and anything else is redacted to a
// fixed fallback with the original logged server-side only.
//
// A set of routes never adopted it. They hand-roll
//     catch(error){ return json({error: error instanceof Error ? error.message : "..."}, 500) }
// which returns the message of ANY Error - including a driver/SQL fault carrying
// table, column or constraint names. On routes that require no authentication at
// all, that hands internal schema detail to an anonymous caller.
//
// These tests drive the real exported handlers with a database stub that fails
// the way a real one does, and assert the internal detail never reaches the body
// while the status and no-store header are preserved.
// ---------------------------------------------------------------------------

installWorkersHooks("__LEAK2_DB__", "__LEAK2_ENV__");

// A realistic internal fault: the shape a D1/SQLite driver error actually takes.
const INTERNAL = "SQLITE_ERROR: no such column: service_controls.internal_disabled_reason";
const SECRETS = [/SQLITE_ERROR/i, /no such column/i, /service_controls/i, /internal_disabled_reason/i];

function failingDb(message = INTERNAL) {
  const boom = () => { throw new Error(message); };
  const statement = () => ({
    bind: () => statement(),
    first: async () => boom(),
    run: async () => boom(),
    all: async () => boom(),
  });
  return { prepare: () => statement(), batch: async () => boom(), exec: async () => boom() };
}

function useFailingDb(message) {
  globalThis.__LEAK2_DB__ = failingDb(message);
  globalThis.__LEAK2_ENV__ = {};
}

// console.error is the intended destination for the original fault; silence it per test so a
// deliberately-failing case does not spam the run, and assert it still received the detail.
async function withCapturedLog(run) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try { return { result: await run(), logged }; }
  finally { console.error = original; }
}

const bodyOf = async (response) => JSON.stringify(await response.json());

// ---------------------------------------------------------------------------
// The route this defect was reproduced on: GET /api/service-availability takes
// no authentication of any kind.
// ---------------------------------------------------------------------------

test("an anonymous caller never receives internal error detail from service-availability", async () => {
  useFailingDb();
  const route = await import("../app/api/service-availability/route.ts");
  const { result: response, logged } = await withCapturedLog(() => route.GET(new Request("https://pawspace.example/api/service-availability")));
  assert.equal(response.status, 500);
  const body = await bodyOf(response);
  for (const secret of SECRETS) {
    assert.doesNotMatch(body, secret, `an unauthenticated 500 body must not contain ${secret}`);
  }
  assert.match(body, /Unable to load service availability/, "the caller still gets a useful, fixed message");
  assert.ok(logged.join(" ").includes("SQLITE_ERROR") || logged.length > 0, "the original fault must still reach server-side logs");
});

test("the redacted response keeps its status and stays uncacheable", async () => {
  useFailingDb();
  const route = await import("../app/api/service-availability/route.ts");
  const { result: response } = await withCapturedLog(() => route.GET(new Request("https://pawspace.example/api/service-availability")));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a driver fault naming a different table is redacted just the same", async () => {
  useFailingDb("D1_ERROR: UNIQUE constraint failed: canonical_customers.primary_phone");
  const route = await import("../app/api/service-availability/route.ts");
  const { result: response } = await withCapturedLog(() => route.GET(new Request("https://pawspace.example/api/service-availability")));
  const body = await bodyOf(response);
  for (const secret of [/D1_ERROR/i, /UNIQUE constraint/i, /canonical_customers/i, /primary_phone/i]) {
    assert.doesNotMatch(body, secret, `redaction must not depend on the message text: ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// The same class across the other unauthenticated GET surfaces.
//
// Every entry must reach the injected fault and answer 500, and that is asserted
// rather than skipped. An earlier revision tolerated a non-failing response
// ("if (response.status < 400) return"), which let two entries pass without ever
// touching the failing dependency: host-profile was sent hostId when the route
// reads providerId, so it answered 400 before opening the database, and
// address-autocomplete has no database dependency at all. Both proved nothing. A
// hard status assertion is what stops a parameter or handler-shape drift from
// silently turning this coverage back into a no-op.
// ---------------------------------------------------------------------------

const UNAUTHENTICATED_GETS = [
  { name: "service-availability", path: "../app/api/service-availability/route.ts", url: "https://pawspace.example/api/service-availability" },
  { name: "training-trainers", path: "../app/api/training-trainers/route.ts", url: "https://pawspace.example/api/training-trainers" },
  { name: "provider-public-profile", path: "../app/api/provider-public-profile/route.ts", url: "https://pawspace.example/api/provider-public-profile?providerId=PROV-1" },
  { name: "host-profile", path: "../app/api/host-profile/route.ts", url: "https://pawspace.example/api/host-profile?providerId=PROV-1" },
];

for (const route of UNAUTHENTICATED_GETS) {
  test(`${route.name}: an internal fault is redacted for an anonymous caller`, async () => {
    useFailingDb();
    const handler = await import(route.path);
    assert.equal(typeof handler.GET, "function", `${route.name} must expose a GET handler for this case to assert anything`);
    const { result: response } = await withCapturedLog(() => handler.GET(new Request(route.url)));
    assert.equal(response.status, 500, `${route.name} never reached the failing database, so this case proves nothing`);
    const body = await bodyOf(response);
    for (const secret of SECRETS) {
      assert.doesNotMatch(body, secret, `${route.name} leaked ${secret} to an anonymous caller`);
    }
  });
}

// address-autocomplete opens no database: it calls the Places API and absorbs every provider fault into
// a 200 payload, so a failing D1 stub can never reach its catch and asserting against one would be
// theatre. The fault that does reach it is a failing runtime binding read - mapsCredentials() reads
// PAWSPACE_MAPS_ENV outside searchAddressSuggestions' own try, so that throw propagates to the route.
test("address-autocomplete: a runtime fault is redacted for an anonymous caller", async () => {
  useFailingDb();
  globalThis.__LEAK2_ENV__ = { get PAWSPACE_MAPS_ENV() { throw new Error(INTERNAL); } };
  const route = await import("../app/api/address-autocomplete/route.ts");
  const url = "https://pawspace.example/api/address-autocomplete?mode=search&query=indira";
  const { result: response } = await withCapturedLog(() => route.GET(new Request(url)));
  assert.equal(response.status, 500, "the injected fault must reach the route's own catch");
  const body = await bodyOf(response);
  for (const secret of SECRETS) {
    assert.doesNotMatch(body, secret, `address-autocomplete leaked ${secret} to an anonymous caller`);
  }
});

// ---------------------------------------------------------------------------
// The fix must not swallow intentional, caller-safe errors, and must not change
// the success path.
// ---------------------------------------------------------------------------

test("an intentional cross-origin refusal keeps its own message and status", async () => {
  useFailingDb();
  const route = await import("../app/api/sitting-payment-sandbox/route.ts");
  const response = await route.POST(new Request("https://pawspace.example/api/sitting-payment-sandbox", {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json", "x-payment-capture-key": "k" },
    body: JSON.stringify({ quoteId: "Q1", amount: 1 }),
  }));
  assert.equal(response.status, 403, "the intentional refusal keeps its status");
  assert.match(JSON.stringify(await response.json()), /Cross-origin Sitting sandbox payment blocked/,
    "a hand-written, caller-safe message must still reach the caller");
});

test("a validation refusal still explains itself", async () => {
  useFailingDb();
  const route = await import("../app/api/sitting-payment-sandbox/route.ts");
  const response = await route.POST(new Request("https://pawspace.example/api/sitting-payment-sandbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteId: "Q1", amount: 1 }),
  }));
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /MISSING_CAPTURE_KEY/, "deliberate validation codes are not internal detail");
});

test("the success path is unchanged: a healthy database still returns data", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  globalThis.__LEAK2_DB__ = {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
  globalThis.__LEAK2_ENV__ = {};
  const route = await import("../app/api/service-availability/route.ts");
  const response = await route.GET(new Request("https://pawspace.example/api/service-availability"));
  assert.equal(response.status, 200, "a healthy request must still succeed");
  const body = await response.json();
  assert.ok(Array.isArray(body.data), "the customer-safe service list is still returned");
  // and the customer-safe projection is still a projection: no internal fields leak on success
  for (const item of body.data) {
    assert.deepEqual(Object.keys(item).sort(), ["code", "enabled", "group", "name"], "no internal field joined the payload");
  }
});

test("the helper logs the original fault exactly once per failure", async () => {
  useFailingDb();
  const route = await import("../app/api/service-availability/route.ts");
  const { logged } = await withCapturedLog(() => route.GET(new Request("https://pawspace.example/api/service-availability")));
  const relevant = logged.filter((line) => line.includes("unauthenticated route"));
  assert.equal(relevant.length, 1, `expected exactly one server-side log line, saw ${JSON.stringify(logged)}`);
});

// ---------------------------------------------------------------------------
// Source-level guard: the hand-rolled leak shape must not come back. This is a
// contract assertion on top of the executable proof above, not a substitute for
// it - the executable tests can only cover handlers they can drive.
// ---------------------------------------------------------------------------

test("no unauthenticated route hand-rolls a raw internal error message", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const apiDir = new URL("../app/api/", import.meta.url);
  const entries = await readdir(apiDir, { withFileTypes: true });
  const AUTH = /resolveActor|requireCustomerOwnership|resolvePlatformSession|resolveUatStaffActor|hasPermission|authorize\(|requirePermission|verifyIdentityAssertion|uatAccessCodeValid/;
  const LEAK = /(error|e|cause|problem|x)\s*instanceof\s*Error\s*\?\s*\1\s*\.\s*message/;
  const offenders = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let source;
    try { source = await readFile(new URL(`${entry.name}/route.ts`, apiDir), "utf8"); }
    catch { continue; }
    if (AUTH.test(source)) continue;          // an authenticated route is a separate, lower exposure
    if (LEAK.test(source)) offenders.push(entry.name);
  }
  assert.deepEqual(offenders, [], `these unauthenticated routes still echo an internal error message: ${offenders.join(", ")}`);
});
