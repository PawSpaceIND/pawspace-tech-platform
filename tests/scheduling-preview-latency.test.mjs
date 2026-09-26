/**
 * Bug B2: the V2 grooming availability preview for the east zone answered with a platform 502 after
 * ~30 s on staging. One warm preview made ~115 D1 queries, ~57 of them strictly one after another, and
 * about 20 were writes; every extra groomer in a zone added five more. At staging's ~250 ms per D1 round
 * trip that is 14 s warm and 30 s on a fresh isolate.
 *
 * These tests EXECUTE the real route, the real gateway modules in worker/index.ts order and the real
 * libraries against node:sqlite loaded with scripts/uat-staging-provider-capacity.sql, with every D1 call
 * counted (and optionally delayed). They pin: the same groomers in the same order as before; a bounded
 * query count that does not grow with the number of groomers; no writes on a warm preview; the 20 s
 * governed 503; the Server-Timing header and the one structured log line; and Smart Placement on staging.
 *
 * No network: fetch is stubbed (and counted) for the only external call on this path, geocoding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__SCHED_PREVIEW_DB__", "__SCHED_PREVIEW_ENV__");
const REPO = new URL("../", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, REPO), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const externalCalls = [];
globalThis.fetch = async (url) => {
  externalCalls.push(String(url).replace(/key=[^&]+/, "key=***"));
  return Response.json({ status: "OK", results: [{ formatted_address: "Test address, Bengaluru", geometry: { location: { lat: 12.9784, lng: 77.6408 } } }] });
};

const route = await import("../app/api/uat-scheduling/route.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const { seedDefaultZones, ensureServiceZonesTables } = await import("../lib/service-zones.ts");
const { seedProviderCapacityDefaults, loadGovernedProviders } = await import("../lib/provider-capacity-governance.ts");
const { filterAssignableProviders } = await import("../lib/provider-assignment-eligibility.ts");
const { currentHomeBase } = await import("../lib/provider-home-base.ts");
const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
const { upsertIdentityBinding, ensureIdentityBindingTables } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, resolvePlatformSession, ensurePlatformSessionTables, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
const { cleanupExpiredReservationLeases } = await import("../lib/scheduling-reservation-leases.ts");
const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
const { requestForAuthorization } = await import("../lib/trusted-workspace-identity.ts");
const { runtimeControlBlock, ensureControlRuntimeTables } = await import("../lib/control-runtime-switches.ts");
const { blockDisabledServiceRequest } = await import("../lib/service-control.ts");
const { ensureFinancialRuntimeSchema } = await import("../lib/financial-runtime-bootstrap.ts");
// Absent before the fix; the suite still runs there so each assertion fails for its own reason.
const metricsLib = await import("../lib/request-d1-metrics.ts").catch(() => null);

const WRITE = /^\s*(BATCH|EXEC|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;
/** Counts every D1 call at the binding, like staging's D1 would see it, with an optional per-call delay. */
function counted(raw, latencyMs = 0) {
  const log = [];
  const call = async (sql, work) => {
    const entry = { sql: sql.replace(/\s+/g, " ").trim(), rows: null };
    log.push(entry);
    if (latencyMs) await sleep(latencyMs / 2);
    const result = await work();
    if (latencyMs) await sleep(latencyMs / 2);
    if (Array.isArray(result?.results)) entry.rows = result.results.length;
    return result;
  };
  const statement = (inner, sql) => ({ __raw: inner, __sql: sql, bind: (...values) => statement(inner.bind(...values), sql),
    first: (...args) => call(sql, () => inner.first(...args)), all: () => call(sql, () => inner.all()), run: () => call(sql, () => inner.run()), raw: () => call(sql, () => inner.raw()) });
  return { log, db: { prepare: (sql) => statement(raw.prepare(sql), sql), batch: (list) => call(`BATCH ${list[0]?.__sql ?? ""}`, () => raw.batch(list.map((item) => item.__raw ?? item))), exec: (sql) => call(`EXEC ${sql}`, () => raw.exec(sql)) } };
}

const CUSTOMER = "CUST-B2-TEST";
const RUNTIME = { PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_MAPS_ENV: "sandbox", GOOGLE_MAPS_SERVER_API_KEY_UAT: "test-not-a-key",
  PAWSPACE_DEPLOYMENT_ENV: "staging", PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "off" };

/** A staging-shaped database: runtime defaults plus the staging roster, one customer with one saved dog. */
async function stagingWorld({ latencyMs = 0, extraEastGroomers = 0 } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const setup = d1(sqlite);
  enterWorkersDbScope(setup);
  globalThis.__SCHED_PREVIEW_DB__ = setup;
  globalThis.__SCHED_PREVIEW_ENV__ = RUNTIME;
  await ensureSecurityTables(setup); await seedDefaultZones(setup); await seedProviderCapacityDefaults(setup); await ensureCustomerAccountTables(setup);
  const roster = read("scripts/uat-staging-provider-capacity.sql").split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  for (const statement of roster.split(/;\s*\n/).map((item) => item.trim()).filter(Boolean)) sqlite.exec(`${statement};`);
  for (let index = 0; index < extraEastGroomers; index++) {
    sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,4.1,70,1,30,4,3,'active',1,'2026-08-01',NULL,'founder_seed',1)")
      .run(`extra_groom_${index}`, "blr", `Extra groomer ${index}`, "full_time", '["grooming"]', '["blr-east"]');
    sqlite.prepare("INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) VALUES (?,?,?,?,?,1,NULL,'test base','test',1)")
      .run(`PHB-extra-${index}`, `extra_groom_${index}`, "East test base", 12.97, 77.64);
  }
  sqlite.prepare("INSERT OR IGNORE INTO canonical_pets(id,customer_id,source_pet_id,name,species,vaccination_status,created_at,updated_at) VALUES ('PET-B2-TEST',?,'PET-B2-TEST','Bruno','dog','verified',?,?)").run(CUSTOMER, Date.now(), Date.now());
  const binding = await upsertIdentityBinding(setup, { identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${CUSTOMER}`, subjectType: "customer", subjectId: CUSTOMER, verificationState: "verified", actorId: "b2-test", reason: "B2 preview latency regression" });
  const issued = await issuePlatformSession(setup, { bindingId: String(binding.id), identitySource: String(binding.identity_source), principalType: String(binding.principal_type), principalKey: String(binding.principal_key), subjectType: "customer", subjectId: CUSTOMER });
  const { log, db } = counted(d1(sqlite), latencyMs);
  enterWorkersDbScope(db);
  globalThis.__SCHED_PREVIEW_DB__ = db;
  return { sqlite, db, log, env: { ...RUNTIME, DB: db }, cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`, token: issued.token, sessionId: issued.session.id };
}

const DAY = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
const SLOT_START = `${DAY}T05:30:00.000Z`, SLOT_END = `${DAY}T07:30:00.000Z`; // 11:00-13:00 IST
const ZONES = { south: ["560068", "blr-south"], east: ["560038", "blr-east"], north: ["560024", "blr-north"], east560017: ["560017", "blr-east"] };
function previewRequest(world, zone) {
  const [pincode, zoneId] = ZONES[zone];
  return new Request(`${ORIGIN}/api/uat-scheduling`, { method: "POST", headers: { "content-type": "application/json", cookie: world.cookie, origin: ORIGIN },
    body: JSON.stringify({ action: "preview", clientRequestId: `v2-grooming-preview:${crypto.randomUUID()}`, customerId: CUSTOMER, petIds: ["PET-B2-TEST"], serviceCode: "grooming",
      cityId: "blr", zoneId, scheduledStart: SLOT_START, scheduledEnd: SLOT_END, serviceAddress: "12, 100 Feet Road, Indiranagar", servicePincode: pincode }) });
}

/** Exactly what worker/index.ts runs for POST /api/uat-scheduling, then the real route. Pinned by the last test. */
async function preview(world, zone, { deadlineMs, startedAgoMs } = {}) {
  // Bind this world's counted database to the caller's async scope before the first await, so the route's
  // own `cloudflare:workers` env.DB is the same counted binding the gateway uses.
  enterWorkersDbScope(world.db);
  globalThis.__SCHED_PREVIEW_DB__ = world.db;
  const request = previewRequest(world, zone);
  const finish = () => deadlineMs ? route.executeGovernedSchedulingRequest(request, undefined, { previewDeadlineMs: deadlineMs }) : route.POST(request);
  const gateway = async (env, leaseCleanup) => {
    const inspection = requestForAuthorization(request, env);
    const sessionAccess = await authorizePlatformSessionRequest(inspection, env.DB).finally(() => leaseCleanup);
    if (sessionAccess instanceof Response) return sessionAccess;
    const access = sessionAccess ?? await authorizeApiRequest(inspection, env);
    if (access instanceof Response) return access;
    const block = await runtimeControlBlock(env.DB, inspection); if (block) return block;
    const service = await blockDisabledServiceRequest(inspection, env.DB); if (service) return service;
    await ensureFinancialRuntimeSchema(env.DB);
    return finish();
  };
  if (!metricsLib) { await cleanupExpiredReservationLeases(world.env.DB); return gateway(world.env, null); }
  const metrics = metricsLib.createRequestD1Metrics(request, true);
  if (startedAgoMs) metrics.startedAt -= startedAgoMs;
  return metricsLib.runWithRequestD1Metrics(metrics, () => {
    const env = metricsLib.withRequestD1MetricsEnv(world.env);
    const leaseCleanup = cleanupExpiredReservationLeases(env.DB); leaseCleanup.catch(() => undefined);
    return gateway(env, leaseCleanup);
  });
}
async function measured(world, zone, options) {
  const from = world.log.length, lines = [], original = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  const startedAt = performance.now();
  let response;
  try { response = await preview(world, zone, options); } finally { console.log = original; }
  const elapsedMs = performance.now() - startedAt, body = await response.clone().json();
  const calls = world.log.slice(from);
  return { response, body, elapsedMs, calls, writes: calls.filter((call) => WRITE.test(call.sql)), ids: (body?.data?.providers ?? []).map((provider) => provider.id), timing: lines.filter((line) => line.includes("scheduling_preview_timing")).map((line) => JSON.parse(line)) };
}
/** Cold isolate, first warm request (the Worker's own lease-schema probe settles here), then steady state. */
async function steadyPreview(world, zone) { await measured(world, zone); await measured(world, zone); return measured(world, zone); }

// Captured from the code before this change on the same roster: the shortlist customers were shown.
const BEFORE = {
  south: ["uatcap_groom_ft", "uatcap_groom_south", "uatcap_groom_south_2"],
  east: ["uatcap_groom_east", "uatcap_groom_ft", "uatcap_groom_east_2"],
  north: ["uatcap_groom_ft", "uatcap_groom_north", "uatcap_groom_north_2"],
  east560017: ["uatcap_groom_east", "uatcap_groom_ft", "uatcap_groom_east_2"],
};

test("previews on the staging roster return the same groomers in the same order as before, cold and warm", async () => {
  for (const zone of Object.keys(BEFORE)) {
    const world = await stagingWorld();
    for (const phase of ["cold", "warm", "steady"]) {
      const result = await measured(world, zone);
      assert.equal(result.response.status, 200, `${zone} ${phase}: ${JSON.stringify(result.body)}`);
      assert.deepEqual(result.ids, BEFORE[zone], `${zone} ${phase} shortlist`);
      assert.equal(result.body.data.reserved, false);
    }
  }
  assert.deepEqual(externalCalls.filter((url) => !url.includes("geocode")), [], "no external call other than one geocode per new address");
});

test("D1 work per warm preview is bounded and does not grow with the number of groomers in the zone", async () => {
  const south = await steadyPreview(await stagingWorld(), "south");       // 10 groomers
  const east = await steadyPreview(await stagingWorld(), "east");         // 13 groomers
  const crowded = await steadyPreview(await stagingWorld({ extraEastGroomers: 40 }), "east"); // 53 groomers
  for (const [label, result] of [["south (10 groomers)", south], ["east (13 groomers)", east], ["east (53 groomers)", crowded]]) {
    assert.equal(result.response.status, 200, label);
    assert.ok(result.calls.length <= 35, `${label}: ${result.calls.length} D1 queries in one warm preview (limit 35)\n${result.calls.map((call) => call.sql.slice(0, 90)).join("\n")}`);
  }
  assert.equal(east.calls.length, south.calls.length, "three more groomers must not add queries");
  assert.equal(crowded.calls.length, east.calls.length, "forty more groomers must not add queries");
  assert.deepEqual(crowded.ids, BEFORE.east, "the extra, lower-rated groomers do not displace the shortlist");
  const cleanupReads = east.calls.filter((call) => call.sql.startsWith("SELECT DISTINCT r.group_id FROM scheduling_reservations r WHERE r.status='assigned'"));
  assert.equal(cleanupReads.length, 1, "lease cleanup runs once per preview request (the Worker's pass), not twice");
  const sessionReads = east.calls.filter((call) => call.sql.startsWith("SELECT s.*,b.status binding_status"));
  assert.equal(sessionReads.length, 1, "the session is read once per request, not once per gateway and again in the route");
});

test("a warm east preview writes nothing: no roster seeding, no schema set-up, no session touch", async () => {
  const world = await stagingWorld();
  const result = await steadyPreview(world, "east");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.writes.map((call) => call.sql.slice(0, 120)), [], "a preview is read-only once the isolate is warm");
  const seeded = world.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_availability WHERE source='uat_roster'").get().n;
  assert.equal(seeded, 0, "the runtime east groomers' roster is served from memory, not written by a preview");
});

test("the in-memory UAT roster answers exactly what the old per-request write would have published", async () => {
  // groom_arun (runtime default, blr-east, staging home base, no published availability) is raised to the
  // top of the ranking, so only the synthetic 09:00-19:00 roster decides whether he is offered.
  const world = await stagingWorld();
  world.sqlite.prepare("UPDATE provider_capacity_profiles SET quality_score=200 WHERE id='groom_arun'").run();
  const offered = await steadyPreview(world, "east");
  assert.equal(offered.response.status, 200);
  assert.ok(offered.ids.includes("groom_arun"), `groom_arun is offered from the in-memory roster: ${offered.ids}`);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_availability WHERE provider_id='groom_arun'").get().n, 0, "and nothing was written for him");

  // Authored availability wins, exactly as before: an Ops row that does not cover 11:00 removes him.
  world.sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES ('ops-arun','groom_arun','blr','blr-east',?,'[\"06:00-07:00\"]','operations',1)").run(DAY);
  assert.ok(!(await measured(world, "east")).ids.includes("groom_arun"), "an authored row is the answer for that date");
  world.sqlite.prepare("DELETE FROM scheduling_availability WHERE id='ops-arun'").run();

  // INSERT OR IGNORE semantics: an existing seeded row keeps its place, so its narrower window decides.
  world.sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,'[\"17:00-19:00\"]','uat_roster',1)").run(`uat_groom_arun_${DAY}_blr-east`, "groom_arun", "blr", "blr-east", DAY);
  assert.ok(!(await measured(world, "east")).ids.includes("groom_arun"), "an already-seeded row is not replaced by the in-memory one");
});

test("the bounded booking read still sees every reservation the evaluator needs", async () => {
  const world = await stagingWorld();
  await measured(world, "east"); // creates the scheduling tables
  const insert = world.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const providers = ["uatcap_groom_east", "uatcap_groom_east_2", "uatcap_groom_ft", "uatcap_groom_east_3"];
  const history = Date.parse(`${DAY}T00:00:00.000Z`) - 400 * 86_400_000;
  for (let index = 0; index < 3000; index++) { const start = new Date(history + index * 3 * 3_600_000); insert.run(`R-old-${index}`, `G-old-${index}`, providers[index % providers.length], "grooming", "blr", "blr-east", "C-OTHER", '["P"]', start.toISOString(), new Date(+start + 7_200_000).toISOString(), "assigned", 1); }
  insert.run("R-conflict", "G-conflict", "uatcap_groom_east", "grooming", "blr", "blr-east", "C-OTHER", '["P"]', `${DAY}T06:00:00.000Z`, `${DAY}T08:00:00.000Z`, "assigned", 1);
  const longStart = new Date(Date.parse(SLOT_START) - 2 * 86_400_000).toISOString();
  insert.run("R-long", "G-long", "uatcap_groom_east_2", "boarding", "blr", "blr-east", "C-OTHER", '["P"]', longStart, `${DAY}T06:00:00.000Z`, "assigned", 1);
  world.sqlite.prepare("UPDATE provider_capacity_profiles SET max_daily_jobs=1 WHERE id='uatcap_groom_ft'").run();
  insert.run("R-same-day", "G-same-day", "uatcap_groom_ft", "grooming", "blr", "blr-east", "C-OTHER", '["P"]', `${DAY}T14:30:00.000Z`, `${DAY}T16:30:00.000Z`, "assigned", 1);
  const result = await measured(world, "east");
  assert.equal(result.response.status, 200);
  for (const excluded of ["uatcap_groom_east", "uatcap_groom_east_2", "uatcap_groom_ft"]) assert.ok(!result.ids.includes(excluded), `${excluded} must be excluded: ${result.ids}`);
  assert.deepEqual(result.ids, BOOKED_EAST, "the same shortlist the unbounded read produced");
  const bookingRead = result.calls.find((call) => /FROM scheduling_reservations WHERE city_id=\?/.test(call.sql));
  assert.ok(bookingRead, "the preview reads reservations");
  assert.ok(bookingRead.rows <= 10, `only reservations near the requested day are read, not the city's history (${bookingRead.rows} rows)`);
});
// Captured from the code before this change (unbounded SELECT * read) on the scenario above.
const BOOKED_EAST = ["groom_arun", "uatcap_groom_east_3", "uatcap_groom_east_4"];

test("set-based provider loading returns exactly what the per-provider composition returned", async () => {
  const world = await stagingWorld();
  const { sqlite, db } = world;
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT,vertical_key TEXT NOT NULL,country_code TEXT NOT NULL,region_code TEXT,city_code TEXT,status TEXT NOT NULL,locale_code TEXT NOT NULL,basic_info_json TEXT NOT NULL,policy_ref TEXT,quiz_version_ref TEXT,verification_status TEXT NOT NULL DEFAULT 'not_started',quiz_status TEXT NOT NULL DEFAULT 'not_started',interview_status TEXT NOT NULL DEFAULT 'not_started',human_decision TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,vertical_key,country_code,status,locale_code,basic_info_json,created_by,created_at,updated_at) VALUES ('APP-east','uatcap_groom_east','grooming','IN','approved','en-IN','{}','test',1,1)").run();
  const profile = sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,4.5,85,1,30,4,3,'active',1,'2026-08-01',NULL,?,1)");
  profile.run("vet_groomer", "blr", "Vet groomer", "full_time", '["grooming","vet_consult"]', '["blr-east"]', "founder_seed");
  profile.run("manual_groomer", "blr", "Manual groomer", "commission", '["grooming"]', '["blr-east"]', "ops_manual");
  const appointment = new Date(SLOT_START), atMs = appointment.getTime();
  sqlite.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES ('LEAVE-1','uatcap_groom_east_2',?,?,'leave','active','test',1,1)").run(new Date(atMs - 3_600_000).toISOString(), new Date(atMs + 3_600_000).toISOString());
  const base = sqlite.prepare("INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) VALUES (?,?,?,?,?,?,NULL,'tie','test',1)");
  base.run("PHB-tie-a", "uatcap_groom_east_3", "A", 12.95, 77.61, 1_700_000_000_000); base.run("PHB-tie-b", "uatcap_groom_east_3", "B", 12.96, 77.62, 1_700_000_000_000);
  base.run("PHB-future", "uatcap_groom_east_4", "Future", 13.5, 78.5, atMs + 86_400_000);

  const legacy = async (cityId, zoneId, serviceCode) => {
    await seedProviderCapacityDefaults(db);
    const date = appointment.toISOString().slice(0, 10), nowIso = appointment.toISOString();
    const rows = (await db.prepare("SELECT * FROM provider_capacity_profiles WHERE city_id=? AND live=1 AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)").bind(cityId, date, date).all()).results;
    const parse = (value) => { try { return JSON.parse(String(value ?? "")); } catch { return []; } };
    const located = await Promise.all(rows.filter((row) => parse(row.services_json).includes(serviceCode) && parse(row.zones_json).includes(zoneId))
      .map(async (row) => { const home = await currentHomeBase(db, String(row.id), atMs); return { id: String(row.id), latitude: home?.latitude, longitude: home?.longitude }; }));
    const blocked = await Promise.all(located.map((provider) => db.prepare("SELECT id FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<=? AND ends_at>? LIMIT 1").bind(provider.id, nowIso, nowIso).first()));
    return (await filterAssignableProviders(db, located.filter((_, index) => !blocked[index]), atMs)).map((provider) => `${provider.id}@${provider.latitude},${provider.longitude}`);
  };
  const current = async (cityId, zoneId, serviceCode) => (await loadGovernedProviders(db, cityId, zoneId, serviceCode, appointment)).map((provider) => `${provider.id}@${provider.latitude},${provider.longitude}`);
  const previous = process.env.PAWSPACE_LOCAL_PREVIEW;
  try {
    for (const mode of ["explicit test fixtures", "deployed UAT (founder_seed only)"]) {
      process.env.PAWSPACE_LOCAL_PREVIEW = mode.startsWith("explicit") ? "on" : "off";
      for (const serviceCode of ["grooming", "dog_training", "pet_sitting", "boarding", "dog_walking", "pet_taxi"]) {
        for (const zoneId of ["blr-east", "blr-south", "blr-north", "blr-west", "blr-central"]) {
          assert.deepEqual(await current("blr", zoneId, serviceCode), await legacy("blr", zoneId, serviceCode), `${mode}: ${serviceCode} in ${zoneId}`);
        }
      }
      const east = await current("blr", "blr-east", "grooming");
      assert.ok(!east.some((entry) => entry.startsWith("vet_groomer@")), "a vet without VCI onboarding is never matched");
      assert.ok(!east.some((entry) => entry.startsWith("uatcap_groom_east_2@")), "a provider on leave at the appointment is not matched");
      assert.ok(!east.some((entry) => entry.startsWith("uatcap_groom_east@")), "an onboarded provider without current verification is not matched");
      assert.equal(east.some((entry) => entry.startsWith("manual_groomer@")), mode.startsWith("explicit"), "non-founder provenance is a test-only exemption");
    }
  } finally { process.env.PAWSPACE_LOCAL_PREVIEW = previous; }
});

test("a preview that runs out of time answers a governed 503 with Retry-After, never a platform 502", async () => {
  const world = await stagingWorld({ latencyMs: 40 });
  await measured(world, "east"); await measured(world, "east");
  const slow = await measured(world, "east", { deadlineMs: 120 });
  assert.equal(slow.response.status, 503, `expected the deadline answer, got ${slow.response.status}`);
  assert.equal(slow.response.headers.get("retry-after"), "5");
  assert.equal(slow.body.code, "SCHEDULING_PREVIEW_TIMEOUT");
  assert.match(slow.body.error, /^Checking availability is taking longer than usual\. Please try again in a moment\.$/, "plain English the V2 page shows as-is");
  assert.ok(slow.elapsedMs < 600, `answered at the deadline (${Math.round(slow.elapsedMs)} ms), not when the work finished`);
  assert.match(slow.response.headers.get("server-timing") ?? "", /d1;dur=/, "the timeout answer carries the same timing");
  assert.equal(slow.timing.length, 1);
  assert.equal(slow.timing[0].status, 503); assert.equal(slow.timing[0].deadlineExceeded, true);

  // The budget is 20 s from the request reaching the Worker, not from the route: time already spent at
  // the edge counts. A request that has already used 25 s is answered at once.
  const fast = await stagingWorld();
  await measured(fast, "east");
  const late = await measured(fast, "east", { startedAgoMs: 25_000 });
  assert.equal(late.response.status, 503);
  assert.ok(late.elapsedMs < 500, `answered immediately (${Math.round(late.elapsedMs)} ms)`);
  const inTime = await measured(fast, "east", { startedAgoMs: 5_000 });
  assert.equal(inTime.response.status, 200, "a request well inside 20 s is answered normally");
  await sleep(150); // let the abandoned read-only work drain before the database closes
});

test("every preview carries Server-Timing and exactly one structured timing line without personal data", async () => {
  const world = await stagingWorld();
  const result = await steadyPreview(world, "east");
  const header = result.response.headers.get("server-timing") ?? "";
  for (const phase of ["pre", "auth", "addr", "setup", "providers", "eval", "total"]) assert.match(header, new RegExp(`(^|, )${phase};dur=\\d`), `phase ${phase} in ${header}`);
  assert.match(header, /d1;dur=[\d.]+;desc="n=\d+ seq=\d+ srv=[\d.]+ms"/);
  assert.equal(result.timing.length, 1, "one line per preview");
  const line = result.timing[0];
  assert.deepEqual(Object.keys(line).sort(), ["colo", "d1Calls", "d1ClientMs", "d1Seq", "d1ServerMs", "d1Writes", "deadlineExceeded", "event", "isolateCold", "maxInflight", "providers", "status", "totalMs", "zone"].sort());
  assert.equal(line.event, "scheduling_preview_timing"); assert.equal(line.zone, "blr-east"); assert.equal(line.status, 200); assert.equal(line.isolateCold, false);
  assert.equal(line.providers, 13, "the 13 east groomers after governance");
  assert.equal(line.d1Calls, result.calls.length, "the per-request wrapper saw every D1 call the database saw");
  assert.equal(line.d1Writes, 0);
  const text = JSON.stringify(line);
  for (const secret of [CUSTOMER, "PET-B2-TEST", world.token, "Indiranagar", "560038", "cookie"]) assert.ok(!text.includes(secret), `timing line must not carry ${secret}`);
});

test("one session lookup per request, and last_seen_at is written at most once a minute", async () => {
  const world = await stagingWorld();
  const request = new Request(`${ORIGIN}/api/uat-scheduling`, { headers: { cookie: world.cookie } });
  const inRequest = (work) => metricsLib ? metricsLib.runWithRequestD1Metrics(metricsLib.createRequestD1Metrics(request), work) : work();
  const sessionCalls = (from) => world.log.slice(from).filter((call) => /platform_identity_sessions/.test(call.sql));
  await ensurePlatformSessionTables(world.db);
  let from = world.log.length;
  await inRequest(async () => { for (let i = 0; i < 3; i++) assert.equal((await resolvePlatformSession(world.db, request))?.subjectId, CUSTOMER); });
  const fresh = sessionCalls(from);
  assert.equal(fresh.length, 1, `one read, no write, for three resolutions of a fresh session: ${fresh.map((call) => call.sql.slice(0, 40))}`);
  assert.ok(fresh[0].sql.startsWith("SELECT s.*,b.status binding_status"));
  world.sqlite.prepare("UPDATE platform_identity_sessions SET last_seen_at=? WHERE id=?").run(Date.now() - 120_000, world.sessionId);
  from = world.log.length;
  await inRequest(async () => { for (let i = 0; i < 3; i++) await resolvePlatformSession(world.db, request); });
  assert.equal(sessionCalls(from).filter((call) => call.sql.startsWith("UPDATE")).length, 1, "a stale marker is touched once");
  from = world.log.length;
  await resolvePlatformSession(world.db, request);
  assert.equal(sessionCalls(from).filter((call) => call.sql.startsWith("UPDATE")).length, 0, "and not again within the minute");
});

test("per-request schema set-up now runs once per isolate, with the control defaults in one batch", async () => {
  const cases = [["ensureControlRuntimeTables", ensureControlRuntimeTables, 2], ["ensureIdentityBindingTables", ensureIdentityBindingTables, 1], ["ensurePlatformSessionTables", ensurePlatformSessionTables, 2], ["ensureServiceZonesTables", ensureServiceZonesTables, 3]];
  for (const [name, ensure, firstLimit] of cases) {
    const fresh = counted(d1(new DatabaseSync(":memory:")));
    await ensure(fresh.db);
    assert.ok(fresh.log.length <= firstLimit, `${name} first run: ${fresh.log.length} D1 calls (limit ${firstLimit})`);
    const before = fresh.log.length;
    await ensure(fresh.db); await ensure(fresh.db);
    assert.equal(fresh.log.length, before, `${name} is a no-op after the first success`);
  }
});

test("the counted D1 wrapper survives instrumentation that patches statement methods in place", async () => {
  if (!metricsLib) assert.fail("lib/request-d1-metrics.ts is missing");
  // Sentry's D1 integration assigns statement.bind/first/... to Proxies of the current values. Written
  // through to the wrapped statement, the wrapper's bind() then called itself until the stack overflowed
  // (seen on the built Worker before the fix); writes must stay on the wrapper.
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1,'one');");
  const db = metricsLib.withRequestD1Metrics(d1(sqlite));
  const patch = (target) => { for (const method of ["bind", "first", "all", "run", "raw"]) target[method] = new Proxy(target[method], { apply: (fn, self, args) => { const out = Reflect.apply(fn, self, args); if (method === "bind") patch(out); return out; } }); return target; };
  const metrics = metricsLib.createRequestD1Metrics();
  const row = await metricsLib.runWithRequestD1Metrics(metrics, () => patch(db.prepare("SELECT v FROM t WHERE id=?")).bind(1).first());
  assert.equal(row?.v, "one");
  assert.equal(metrics.calls, 1, "and the call is still counted once");
});

test("staging runs the Worker with Smart Placement; production config is untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-placement-"));
  fs.mkdirSync(path.join(dir, "dist", "server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "server", "wrangler.json"), JSON.stringify({ name: "x", vars: {} }));
  execFileSync(process.execPath, [new URL("../scripts/stage-config.mjs", import.meta.url).pathname], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, STAGING_D1_ID: "11111111-2222-4333-8444-555555555555", PAWSPACE_UAT_ACCESS_CODE: "a-real-access-code-of-thirty-two-plus", PAWSPACE_UAT_SIGNING_KEY: "0123456789abcdef0123456789abcdef01", PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "fedcba9876543210fedcba9876543210fe" } });
  const config = JSON.parse(fs.readFileSync(path.join(dir, "dist", "server", "wrangler.json"), "utf8"));
  assert.deepEqual(config.placement, { mode: "smart" });
  assert.doesNotMatch(read("scripts/prod-config.mjs"), /placement/, "production placement is a separate decision");
  assert.doesNotMatch(read("wrangler.toml"), /placement/);
});

test("worker/index.ts runs the scheduling request in the counted scope, in the order preview() replays", () => {
  const worker = read("worker/index.ts");
  assert.match(worker, /if\(request\.method==="POST"&&new URL\(request\.url\)\.pathname==="\/api\/uat-scheduling"\)return runWithRequestD1Metrics\(createRequestD1Metrics\(request,true,promise=>ctx\.waitUntil\(promise\)\),\(\)=>worker\.handle\(request,withRequestD1MetricsEnv\(env\),ctx\)\);\s*return worker\.handle\(request,env,ctx\);/);
  assert.doesNotMatch(worker, /=>worker\.fetch\(/, "never re-enter fetch: Sentry.withSentry wraps it and would instrument the counted env again");
  assert.match(worker, /const leaseCleanup=request\.method==="POST"&&\(url\.pathname==="\/api\/uat-scheduling"\|\|url\.pathname==="\/api\/canonical-bookings"\)\?cleanupExpiredReservationLeases\(env\.DB\):null;/);
  assert.match(worker, /const sessionAccess=await authorizePlatformSessionRequest\(inspectionRequest,env\.DB\)\.finally\(\(\)=>leaseCleanup\);/);
  const api = worker.slice(worker.indexOf("const leaseCleanup="));
  const order = ["authorizePlatformSessionRequest(", "authorizeApiRequest(", "runtimeControlBlock(", "blockDisabledServiceRequest(", "ensureFinancialRuntimeSchema(", "handler.fetch(request, env, ctx)"].map((token) => api.indexOf(token));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), `gateway order ${order}`);
});
