/**
 * Bug B2 follow-up: the 20 s preview deadline must not poison the isolate.
 *
 * The Workers runtime cancels a finished request's unfinished I/O, and a cancelled promise never
 * settles. Reproduced under workerd (Miniflare, the built worker, 60 ms per D1 call, deadline 1.5 s):
 * the first cold preview answered 503 at the deadline while its schema set-up was still running; the
 * set-up's in-flight promise, cached per isolate, never settled, and EVERY later preview on that isolate
 * waited on it and answered 503 too. Two fixes, both executed here:
 *
 * 1. The deadline hands the unfinished work to the request's waitUntil (ctx.waitUntil, carried in the
 *    request's D1 scope by worker/index.ts), so the runtime lets it finish.
 * 2. The per-isolate schema guards added for B2 keep only a "ready" set. They never share an in-flight
 *    promise across requests, so a set-up that never finishes (a cancelled request) cannot block a later
 *    request: the later request runs the idempotent set-up itself.
 *
 * No network: fetch is stubbed for the only external call on this path (geocoding).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__SCHED_DEADLINE_DB__", "__SCHED_DEADLINE_ENV__");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
globalThis.fetch = async () => Response.json({ status: "OK", results: [{ formatted_address: "Test address, Bengaluru", geometry: { location: { lat: 12.9784, lng: 77.6408 } } }] });

const route = await import("../app/api/uat-scheduling/route.ts");
const metricsLib = await import("../lib/request-d1-metrics.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const { seedDefaultZones, ensureServiceZonesTables } = await import("../lib/service-zones.ts");
const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
const { upsertIdentityBinding, ensureIdentityBindingTables } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, ensurePlatformSessionTables, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
const { ensureControlRuntimeTables } = await import("../lib/control-runtime-switches.ts");

/** Every D1 call waits `latencyMs` before reaching SQLite, like a distant staging D1. */
function slowed(raw, latencyMs) {
  const statement = (inner) => ({ __raw: inner, bind: (...values) => statement(inner.bind(...values)),
    first: async (...args) => { await sleep(latencyMs); return inner.first(...args); }, all: async () => { await sleep(latencyMs); return inner.all(); },
    run: async () => { await sleep(latencyMs); return inner.run(); }, raw: async () => { await sleep(latencyMs); return inner.raw(); } });
  return { prepare: (sql) => statement(raw.prepare(sql)), batch: async (list) => { await sleep(latencyMs); return raw.batch(list.map((item) => item.__raw ?? item)); }, exec: async (sql) => { await sleep(latencyMs); return raw.exec(sql); } };
}

const CUSTOMER = "CUST-B2-DEADLINE";
const RUNTIME = { PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_MAPS_ENV: "sandbox", GOOGLE_MAPS_SERVER_API_KEY_UAT: "test-not-a-key", PAWSPACE_DEPLOYMENT_ENV: "staging", PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "off" };
const DAY = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

async function stagingWorld(latencyMs) {
  const sqlite = new DatabaseSync(":memory:");
  const setup = d1(sqlite);
  enterWorkersDbScope(setup);
  globalThis.__SCHED_DEADLINE_DB__ = setup;
  globalThis.__SCHED_DEADLINE_ENV__ = RUNTIME;
  await ensureSecurityTables(setup); await seedDefaultZones(setup); await seedProviderCapacityDefaults(setup); await ensureCustomerAccountTables(setup);
  const roster = fs.readFileSync(new URL("../scripts/uat-staging-provider-capacity.sql", import.meta.url), "utf8").split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  for (const statement of roster.split(/;\s*\n/).map((item) => item.trim()).filter(Boolean)) sqlite.exec(`${statement};`);
  sqlite.prepare("INSERT OR IGNORE INTO canonical_pets(id,customer_id,source_pet_id,name,species,vaccination_status,created_at,updated_at) VALUES ('PET-B2-DL',?,'PET-B2-DL','Bruno','dog','verified',?,?)").run(CUSTOMER, Date.now(), Date.now());
  const binding = await upsertIdentityBinding(setup, { identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${CUSTOMER}`, subjectType: "customer", subjectId: CUSTOMER, verificationState: "verified", actorId: "b2-deadline-test", reason: "B2 deadline cancellation regression" });
  const issued = await issuePlatformSession(setup, { bindingId: String(binding.id), identitySource: String(binding.identity_source), principalType: String(binding.principal_type), principalKey: String(binding.principal_key), subjectType: "customer", subjectId: CUSTOMER });
  const db = slowed(d1(sqlite), latencyMs);
  return { sqlite, db, cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}` };
}

function previewRequest(world) {
  return new Request(`${ORIGIN}/api/uat-scheduling`, { method: "POST", headers: { "content-type": "application/json", cookie: world.cookie, origin: ORIGIN },
    body: JSON.stringify({ action: "preview", clientRequestId: `v2-grooming-preview:${crypto.randomUUID()}`, customerId: CUSTOMER, petIds: ["PET-B2-DL"], serviceCode: "grooming",
      cityId: "blr", zoneId: "blr-east", scheduledStart: `${DAY}T05:30:00.000Z`, scheduledEnd: `${DAY}T07:30:00.000Z`, serviceAddress: "12, 100 Feet Road, Indiranagar", servicePincode: "560038" }) });
}

/** The route in the scope worker/index.ts opens for POST /api/uat-scheduling, with the request's waitUntil. */
async function preview(world, { deadlineMs } = {}) {
  enterWorkersDbScope(world.db);
  globalThis.__SCHED_DEADLINE_DB__ = world.db;
  const handedOff = [];
  const request = previewRequest(world);
  const metrics = metricsLib.createRequestD1Metrics(request, true, (promise) => { handedOff.push(promise); });
  const response = await metricsLib.runWithRequestD1Metrics(metrics, () => route.executeGovernedSchedulingRequest(request, undefined, deadlineMs ? { previewDeadlineMs: deadlineMs } : {}));
  return { response, body: await response.clone().json(), handedOff };
}

test("a preview answered at the deadline hands its unfinished work to the request's waitUntil, which then finishes it", async () => {
  const world = await stagingWorld(30);
  const original = console.log; console.log = () => {};
  try {
    const cold = await preview(world, { deadlineMs: 150 });
    assert.equal(cold.response.status, 503, `the cold preview is answered at the deadline: ${JSON.stringify(cold.body)}`);
    assert.equal(cold.response.headers.get("retry-after"), "5");
    assert.equal(cold.handedOff.length, 1, "the unfinished preview work is handed to waitUntil exactly once, so the runtime does not cancel it");
    const outcome = await Promise.race([cold.handedOff[0].then(() => "settled"), sleep(15_000).then(() => "still running")]);
    assert.equal(outcome, "settled", "the handed-off work runs to completion");

    // The isolate is healthy afterwards: the next preview is answered normally, and nothing is handed off.
    const next = await preview(world);
    assert.equal(next.response.status, 200, JSON.stringify(next.body));
    assert.deepEqual(next.body.data.providers.map((provider) => provider.id), ["uatcap_groom_east", "uatcap_groom_ft", "uatcap_groom_east_2"]);
    assert.equal(next.handedOff.length, 0, "a preview answered in time hands nothing off");
  } finally { console.log = original; }
});

test("a schema guard whose first run never finishes (a cancelled request) does not block the next request", async () => {
  // Models the workerd behaviour: the first caller's D1 calls never settle. A later caller on the same
  // database must run the idempotent set-up itself instead of waiting on the first caller's promise.
  for (const [name, ensure] of [["ensureControlRuntimeTables", ensureControlRuntimeTables], ["ensureIdentityBindingTables", ensureIdentityBindingTables], ["ensurePlatformSessionTables", ensurePlatformSessionTables], ["ensureServiceZonesTables", ensureServiceZonesTables]]) {
    const live = d1(new DatabaseSync(":memory:"));
    let cancelled = true;
    const never = new Promise(() => {});
    const statement = (inner) => ({ __raw: inner, bind: (...values) => statement(inner.bind(...values)),
      first: (...args) => cancelled ? never : inner.first(...args), all: () => cancelled ? never : inner.all(), run: () => cancelled ? never : inner.run(), raw: () => cancelled ? never : inner.raw() });
    const db = { prepare: (sql) => statement(live.prepare(sql)), batch: (list) => cancelled ? never : live.batch(list.map((item) => item.__raw ?? item)), exec: (sql) => cancelled ? never : live.exec(sql) };
    ensure(db).catch(() => undefined); // the cancelled request: its set-up never settles
    await sleep(5);
    cancelled = false;
    const outcome = await Promise.race([ensure(db).then(() => "done"), sleep(1_000).then(() => "blocked")]);
    assert.equal(outcome, "done", `${name}: a later request must not wait on a cancelled request's set-up`);
    const before = Date.now();
    await ensure(db);
    assert.ok(Date.now() - before < 50, `${name}: and once it has succeeded it is a no-op`);
  }
});

test("worker/index.ts gives the scheduling request scope the request's ctx.waitUntil", () => {
  const worker = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /runWithRequestD1Metrics\(createRequestD1Metrics\(request,true,promise=>ctx\.waitUntil\(promise\)\),/);
});
