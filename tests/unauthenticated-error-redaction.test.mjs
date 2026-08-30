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

test("the governed boundary logs the original fault exactly once per failure", async () => {
  useFailingDb();
  const route = await import("../app/api/service-availability/route.ts");
  const { logged } = await withCapturedLog(() => route.GET(new Request("https://pawspace.example/api/service-availability")));
  // Asserted on the fault text, not on any helper's prefix: the requirement is that the original
  // reaches the server log once, whichever governed helper carries it there.
  const relevant = logged.filter((line) => line.includes("SQLITE_ERROR"));
  assert.equal(relevant.length, 1, `expected exactly one server-side log line carrying the fault, saw ${JSON.stringify(logged)}`);
});

// ---------------------------------------------------------------------------
// Source-level guard: the hand-rolled leak shape must not come back. This is a
// contract assertion on top of the executable proof above, not a substitute for
// it - the executable tests can only cover handlers they can drive.
// ---------------------------------------------------------------------------

test("every unauthenticated route routes unexpected failures through the shared LEAK-1 boundary", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const apiDir = new URL("../app/api/", import.meta.url);
  const missing = [];
  for (const name of await unauthenticatedRouteNames()) {
    const source = await readFile(new URL(`${name}/route.ts`, apiDir), "utf8");
    if (!/authError\(/.test(source)) missing.push(name);
  }
  // authError() is the module's public boundary and 166 of 199 routes already used it. These routes
  // hand-rolled their own catch instead, which is how the raw message came back; a parallel private
  // sanitizer would only have split the convention in two, so there deliberately is not one.
  assert.deepEqual(missing, [], `these unauthenticated routes do not reach authError(): ${missing.join(", ")}`);
  void readdir;
});

test("no unauthenticated route hand-rolls a raw internal error message", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const apiDir = new URL("../app/api/", import.meta.url);
  const entries = await readdir(apiDir, { withFileTypes: true });
  const AUTH = /resolveActor|requireCustomerOwnership|resolvePlatformSession|resolveUatStaffActor|hasPermission|authorize\(|requirePermission|verifyIdentityAssertion|uatAccessCodeValid/;
  const LEAK = /(?:json|Response\.json)\([\s\S]{0,160}?(error|e|cause|problem|x)\s*instanceof\s*Error\s*\?\s*\1\s*\.\s*message/;
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

// ---------------------------------------------------------------------------
// Class containment.
//
// Everything above fixes named routes. This enumerates the whole unauthenticated
// surface from disk, drives every exported method of every one of them against a
// database whose every call fails with a distinctive sentinel, and asserts the
// sentinel never crosses the HTTP boundary. That is what turns "these routes were
// fixed" into "this exposure class stays closed" - a new unauthenticated route
// added tomorrow is swept without anyone remembering to list it here.
//
// The failing stub also makes the sweep read-only by construction: every write a
// handler attempts throws before it can touch anything.
// ---------------------------------------------------------------------------

const SENTINEL = "INTERNAL_SECRET_SCHEMA_SENTINEL";
const AUTH_MARKERS = /resolveActor|requireCustomerOwnership|resolvePlatformSession|resolveUatStaffActor|hasPermission|authorize\(|requirePermission|verifyIdentityAssertion|uatAccessCodeValid/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

async function unauthenticatedRouteNames() {
  const { readdir, readFile } = await import("node:fs/promises");
  const apiDir = new URL("../app/api/", import.meta.url);
  const names = [];
  for (const entry of await readdir(apiDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let source;
    try { source = await readFile(new URL(`${entry.name}/route.ts`, apiDir), "utf8"); } catch { continue; }
    if (!AUTH_MARKERS.test(source)) names.push(entry.name);
  }
  return names.sort();
}

// A handler that hangs would stall CI rather than fail it, so every call is bounded.
function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function sweepUnauthenticatedSurface() {
  const names = await unauthenticatedRouteNames();
  const leaked = [], threw = [], answered = [];
  for (const name of names) {
    const handler = await import(`../app/api/${name}/route.ts`);
    for (const method of METHODS) {
      if (typeof handler[method] !== "function") continue;
      const label = `${name}.${method}`;
      // The sentinel is injected fresh per call so a cached module cannot mask it.
      globalThis.__LEAK2_DB__ = failingDb(`SQLITE_ERROR: no such column: ${SENTINEL}`);
      globalThis.__LEAK2_ENV__ = {};
      const init = method === "GET" ? undefined : { method, headers: { "content-type": "application/json" }, body: "{}" };
      let response;
      try {
        response = await withDeadline(handler[method](new Request(`https://pawspace.example/api/${name}`, init)), 10000, label);
      } catch (error) {
        threw.push(`${label}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
        continue;
      }
      if (!(response instanceof Response)) { threw.push(`${label}: returned ${typeof response}, not a Response`); continue; }
      const body = await response.text().catch(() => "");
      answered.push({ label, status: response.status });
      if (body.includes(SENTINEL)) leaked.push(`${label} [${response.status}]`);
    }
  }
  return { names, leaked, threw, answered };
}

test("no unauthenticated handler lets the internal sentinel cross the HTTP boundary", async () => {
  const { names, leaked, answered } = await withCapturedLog(sweepUnauthenticatedSurface).then((r) => r.result);
  assert.ok(names.length > 0, "the sweep found no unauthenticated routes, so it is asserting nothing");
  assert.ok(answered.length >= names.length, "every enumerated route must contribute at least one driven handler");
  assert.deepEqual(leaked, [], `these unauthenticated handlers returned the internal sentinel to an anonymous caller: ${leaked.join(", ")}`);
});

test("the sweep actually reaches the injected fault, not just validation guards", async () => {
  const { answered } = await withCapturedLog(sweepUnauthenticatedSurface).then((r) => r.result);
  // Without this floor the sweep could silently degrade to every handler answering 400 on an empty
  // body, which would keep the leak assertion green while testing nothing at all.
  const reached = answered.filter((entry) => entry.status >= 500);
  assert.ok(reached.length >= 10, `only ${reached.length} handlers reached the failing database; the sweep has stopped exercising the fault path`);
});

test("every unauthenticated handler answers with a Response instead of throwing", async () => {
  const { threw } = await withCapturedLog(sweepUnauthenticatedSurface).then((r) => r.result);
  // An uncaught throw is not a redaction bug, it is the absence of any boundary at all: the body the
  // caller receives is then whatever the runtime renders, which this suite cannot govern.
  assert.deepEqual(threw, [], `these unauthenticated handlers threw out of the handler instead of returning a governed response: ${threw.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// The boundary must distinguish an approved, externally meaningful refusal from an
// arbitrary infrastructure fault. Redacting everything to "Internal server error"
// would be just as wrong as echoing the driver message: it would delete the
// rate-limit, validation and not-found signals real callers depend on.
//
// authError() draws that line by object identity - a response minted through
// governedJsonError() passes through verbatim, anything else does not - so these
// pairs assert both directions on the same route.
// ---------------------------------------------------------------------------

function workingDb() {
  const { DatabaseSync } = require$sqlite;
  const sqlite = new DatabaseSync(":memory:");
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { sqlite, db: { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); } } };
}
const require$sqlite = await import("node:sqlite");

test("public-contact: a governed rate-limit refusal still reaches the caller in full", async () => {
  const { db } = workingDb();
  globalThis.__LEAK2_DB__ = db;
  globalThis.__LEAK2_ENV__ = {};
  const route = await import("../app/api/public-contact/route.ts");
  // No cf-connecting-ip, so the abuse gate throws its governed 429 before anything else.
  const response = await route.POST(new Request("https://pawspace.example/api/public-contact", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "A", phone: "9999999999" }),
  }));
  assert.equal(response.status, 429, "the governed refusal keeps its own status");
  assert.match(JSON.stringify(await response.json()), /Request origin could not be verified/,
    "a governed 4xx must pass through the boundary verbatim, not be flattened to the fallback");
});

test("public-contact: an infrastructure fault on the same route is redacted", async () => {
  useFailingDb();
  const route = await import("../app/api/public-contact/route.ts");
  const { result: response } = await withCapturedLog(() => route.POST(new Request("https://pawspace.example/api/public-contact", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" }, body: JSON.stringify({ name: "A", phone: "9999999999" }),
  })));
  assert.equal(response.status, 500);
  const body = await bodyOf(response);
  for (const secret of SECRETS) assert.doesNotMatch(body, secret, `public-contact leaked ${secret}`);
  assert.match(body, /Unable to submit your enquiry/, "the caller still gets the route's own fixed message");
});

test("haptik: a malformed body stays a permanent 400 so the webhook is not retried forever", async () => {
  useFailingDb();
  globalThis.__LEAK2_ENV__ = { HAPTIK_API_KEY: "test-key" };
  const route = await import("../app/api/haptik/route.ts");
  const response = await route.POST(new Request("https://pawspace.example/api/haptik", {
    method: "POST", headers: { "content-type": "application/json", "x-haptik-key": "test-key" }, body: "this is not json",
  }));
  assert.equal(response.status, 400, "a malformed body is the caller's fault and must not be retryable");
  assert.match(JSON.stringify(await response.json()), /Malformed Haptik request body/);
});

test("haptik: an infrastructure fault becomes a retryable, redacted 500", async () => {
  useFailingDb();
  globalThis.__LEAK2_ENV__ = { HAPTIK_API_KEY: "test-key" };
  const route = await import("../app/api/haptik/route.ts");
  const { result: response } = await withCapturedLog(() => route.POST(new Request("https://pawspace.example/api/haptik", {
    method: "POST", headers: { "content-type": "application/json", "x-haptik-key": "test-key" },
    body: JSON.stringify({ action: "capture_lead", idempotencyKey: "k1", phone: "9999999999" }),
  })));
  assert.equal(response.status, 500, "a database fault must be retryable, not classed as a permanent client error");
  const body = await bodyOf(response);
  for (const secret of SECRETS) assert.doesNotMatch(body, secret, `haptik leaked ${secret}`);
});

test("haptik: a wrong key is still refused with its own message", async () => {
  useFailingDb();
  globalThis.__LEAK2_ENV__ = { HAPTIK_API_KEY: "test-key" };
  const route = await import("../app/api/haptik/route.ts");
  const response = await route.POST(new Request("https://pawspace.example/api/haptik", {
    method: "POST", headers: { "content-type": "application/json", "x-haptik-key": "wrong" }, body: "{}",
  }));
  assert.equal(response.status, 401, "credential refusal must not be swallowed by the boundary");
});

test("whatsapp-uat-webhook: an operator kill-switch reason no longer reaches the webhook caller", async () => {
  const { sqlite, db } = workingDb();
  globalThis.__LEAK2_DB__ = db;
  const secret = "webhook-secret";
  globalThis.__LEAK2_ENV__ = { PAWSPACE_WHATSAPP_ENV: "uat", PAWSPACE_WHATSAPP_UAT_WEBHOOK_SECRET: secret };
  const adapter = await import("../lib/whatsapp-uat-adapter.ts");
  await adapter.ensureWhatsAppUatTables(db);
  const REASON = "disabled pending Meta template audit ticket OPS-4471";
  // ensureWhatsAppUatTables seeds the provider row, so flip the existing one into the disabled state.
  sqlite.prepare("UPDATE whatsapp_uat_provider_controls SET disabled=1,reason=?,updated_by='ops@pawspace.in',updated_at=1 WHERE provider='sandbox_simulator'").run(REASON);
  assert.equal(sqlite.prepare("SELECT disabled,reason FROM whatsapp_uat_provider_controls WHERE provider='sandbox_simulator'").get().reason, REASON, "the kill-switch reason must actually be in the database for this to prove anything");

  const raw = JSON.stringify({ type: "inbound_message", phone: "9999999999", text: "hello" });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");

  const route = await import("../app/api/whatsapp-uat-webhook/route.ts");
  const { result: response } = await withCapturedLog(() => route.POST(new Request("https://pawspace.example/api/whatsapp-uat-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pawspace-signature": signature, "x-pawspace-event-id": "EVT-1", "x-pawspace-whatsapp-provider": "sandbox_simulator" },
    body: raw,
  })));
  const body = await bodyOf(response);
  assert.doesNotMatch(body, /OPS-4471/, "an internal ticket reference must not reach the webhook caller");
  assert.doesNotMatch(body, /Meta template audit/, "an operator-authored kill-switch reason must not cross the boundary");
  assert.ok(response.status >= 400, `the request must still be refused, got ${response.status}`);
});

test("scheduling-rules: an infrastructure fault is answered, not thrown out of the handler", async () => {
  useFailingDb();
  const route = await import("../app/api/scheduling-rules/route.ts");
  const { result: response } = await withCapturedLog(() => route.GET());
  assert.equal(response.status, 500, "the route had no error boundary at all before this");
  const body = await bodyOf(response);
  for (const secret of SECRETS) assert.doesNotMatch(body, secret, `scheduling-rules leaked ${secret}`);
});

test("a thrown domain refusal from a governance library keeps its status and message", async () => {
  useFailingDb();
  const route = await import("../app/api/boarding-commercial/route.ts");
  // sameOriginWrite throws a 4xx for a cross-origin write; that text is written for the caller.
  const response = await route.POST(new Request("https://pawspace.example/api/boarding-commercial", {
    method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" }, body: "{}",
  }));
  assert.ok(response.status >= 400 && response.status < 500, `expected a client refusal, got ${response.status}`);
  const body = await bodyOf(response);
  for (const secret of SECRETS) assert.doesNotMatch(body, secret, "a domain refusal must not carry internal detail either");
});
