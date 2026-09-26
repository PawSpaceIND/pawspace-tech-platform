/**
 * A staging-shaped world for timing the Boarding, Pet Sitting and Pet Taxi booking paths, the way
 * tests/scheduling-preview-latency.test.mjs times the grooming preview (PR #1105).
 *
 * Every route runs for real against node:sqlite loaded with scripts/uat-staging-provider-capacity.sql,
 * behind the same gateway modules worker/index.ts runs, in the same order. Every D1 call is counted at
 * the binding and can be delayed, so a test can pin how many calls a request makes and how long it takes
 * at staging's per-call latency. Parallel calls overlap, exactly as they do against D1.
 *
 * The caller owns the cloudflare:workers shim: it calls installWorkersHooks(dbGlobal, envGlobal) and
 * passes the same two global names to stayWorld().
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { enterWorkersDbScope } from "./module-hooks.mjs";
import { d1, ORIGIN } from "./execution-harness.mjs";

const REPO = new URL("../../", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, REPO), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const WRITE = /^\s*(BATCH|EXEC|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;

/** Counts every D1 call at the binding, like staging's D1 would see it, with an optional per-call delay. */
export function counted(raw, latency = { ms: 0 }) {
  const log = [];
  let inflight = 0;
  const call = async (sql, work) => {
    // `sequential`: this call started while no other call was in flight, i.e. it added a full round trip.
    const entry = { sql: sql.replace(/\s+/g, " ").trim(), rows: null, sequential: inflight === 0 };
    log.push(entry);
    inflight += 1;
    try {
      if (latency.ms) await sleep(latency.ms / 2);
      const result = await work();
      if (latency.ms) await sleep(latency.ms / 2);
      if (Array.isArray(result?.results)) entry.rows = result.results.length;
      return result;
    } finally { inflight -= 1; }
  };
  const statement = (inner, sql) => ({ __raw: inner, __sql: sql, bind: (...values) => statement(inner.bind(...values), sql),
    first: (...args) => call(sql, () => inner.first(...args)), all: () => call(sql, () => inner.all()), run: () => call(sql, () => inner.run()), raw: () => call(sql, () => inner.raw()) });
  return { log, db: { prepare: (sql) => statement(raw.prepare(sql), sql), batch: (list) => call(`BATCH ${list[0]?.__sql ?? ""}`, () => raw.batch(list.map((item) => item.__raw ?? item))), exec: (sql) => call(`EXEC ${sql}`, () => raw.exec(sql)) } };
}

export const CUSTOMER = "CUST-STAY-LATENCY";
export const PETS = { dog: "PET-STAY-DOG", cat: "PET-STAY-CAT" };
export const RUNTIME = { PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_MAPS_ENV: "sandbox", GOOGLE_MAPS_SERVER_API_KEY_UAT: "test-not-a-key",
  PAWSPACE_DEPLOYMENT_ENV: "staging", PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "off" };

/** Geocoding is the only external call on these paths; it is stubbed and counted. */
export const externalCalls = [];
export function stubGeocoding() {
  globalThis.fetch = async (url) => {
    externalCalls.push(String(url).replace(/key=[^&]+/, "key=***"));
    return Response.json({ status: "OK", results: [{ formatted_address: "Test address, Bengaluru", geometry: { location: { lat: 12.9784, lng: 77.6408 } } }] });
  };
}

const PROFILE = "INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,3,'active',1,'2026-01-01',NULL,'founder_seed',1)";
const HOST = "INSERT OR IGNORE INTO boarding_host_profiles (provider_id,city_id,zone_id,area,species_json,max_guest_pets,one_family_only,medication_support,resident_pets,home_verified,kyc_status,background_check_status,active,version,updated_by,updated_at) VALUES (?,?,?,?,'[\"dog\",\"cat\"]',8,?,1,'none',1,'verified','verified',1,1,'founder_seed',1)";

/**
 * A Boarding and Pet Sitting roster the test owns, so a later edit to the staging seed cannot move an
 * expectation: every seeded blr host and sitter is taken off the live roster and these join blr-east with
 * the capacities, family rules, ratings and travel buffers set here. Hosts: [id, maxGuestPets, oneFamily,
 * rating]; sitters: [id, capacity, travelBufferMinutes, rating]. Everyone lives in Indiranagar.
 */
export const OWN_ROSTER = {
  hosts: [["stay_host_one_family", 2, 1, 4.9], ["stay_host_small", 2, 1, 4.8], ["stay_host_large", 4, 0, 4.7], ["stay_host_mid", 3, 0, 4.6]],
  sitters: [["stay_sit_top", 1, 30, 4.9], ["stay_sit_second", 1, 30, 4.8], ["stay_sit_third", 2, 30, 4.7], ["stay_sit_fourth", 1, 45, 4.6]],
};
const GUEST_HOST = "INSERT OR REPLACE INTO boarding_host_profiles (provider_id,city_id,zone_id,area,species_json,max_guest_pets,one_family_only,medication_support,resident_pets,home_verified,kyc_status,background_check_status,active,version,updated_by,updated_at) VALUES (?,'blr','blr-east','Indiranagar','[\"dog\",\"cat\"]',?,?,1,'none',1,'verified','verified',1,1,'founder_seed',1)";
const HOME = "INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) VALUES (?,?,'Test base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'stay latency test roster','founder_seed',1)";
function ownStayRoster(sqlite) {
  sqlite.exec("UPDATE provider_capacity_profiles SET live=0 WHERE city_id='blr' AND (services_json LIKE '%\"boarding\"%' OR services_json LIKE '%\"pet_sitting\"%')");
  for (const [id, guests, oneFamily, rating] of OWN_ROSTER.hosts) {
    sqlite.prepare(PROFILE).run(id, "blr", `Test host ${id}`, "commission", '["boarding"]', '["blr-east"]', rating, 90, guests, 0, 12);
    sqlite.prepare(GUEST_HOST).run(id, guests, oneFamily);
    sqlite.prepare(HOME).run(`PHB-${id}`, id);
  }
  for (const [id, capacity, buffer, rating] of OWN_ROSTER.sitters) {
    sqlite.prepare(PROFILE).run(id, "blr", `Test sitter ${id}`, "commission", '["pet_sitting"]', '["blr-east"]', rating, 90, capacity, buffer, 6);
    sqlite.prepare(HOME).run(`PHB-${id}`, id);
  }
}

/**
 * Staging as it is: runtime tables first, then the deploy's roster seed, then (optionally) extra
 * providers in blr-east so a test can show the query count does not grow with the roster.
 */
export async function stayWorld({ dbGlobal, envGlobal, extra = 0, ownRoster = false, seedFile = process.env.STAY_LATENCY_SEED || "scripts/uat-staging-provider-capacity.sql" } = {}) {
  const { ensureSecurityTables } = await import("../../lib/server-auth.ts");
  const { seedDefaultZones } = await import("../../lib/service-zones.ts");
  const { seedProviderCapacityDefaults } = await import("../../lib/provider-capacity-governance.ts");
  const { ensureCustomerAccountTables } = await import("../../lib/customer-account.ts");
  const { ensureBoardingStayLifecycleTables } = await import("../../lib/boarding-stay-lifecycle.ts");
  const { ensureTaxiFleetTables } = await import("../../lib/taxi-fleet-governance.ts");
  const { ensureBoardingGovernanceTables } = await import("../../lib/boarding-governance.ts");
  const { upsertIdentityBinding } = await import("../../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../../lib/platform-session.ts");
  const sqlite = new DatabaseSync(":memory:");
  const setup = d1(sqlite);
  enterWorkersDbScope(setup);
  globalThis[dbGlobal] = setup;
  globalThis[envGlobal] = RUNTIME;
  await ensureSecurityTables(setup); await seedDefaultZones(setup); await seedProviderCapacityDefaults(setup); await ensureCustomerAccountTables(setup);
  await ensureBoardingGovernanceTables(setup); await ensureBoardingStayLifecycleTables(setup); await ensureTaxiFleetTables(setup);
  const seedPath = seedFile.startsWith("/") ? seedFile : new URL(seedFile, REPO);
  const roster = fs.readFileSync(seedPath, "utf8").split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  for (const statement of roster.split(/;\s*\n/).map((item) => item.trim()).filter(Boolean)) sqlite.exec(`${statement};`);
  if (ownRoster) ownStayRoster(sqlite);
  for (let index = 0; index < extra; index++) {
    sqlite.prepare(PROFILE).run(`extra_host_${index}`, "blr", `Extra host ${index}`, "commission", '["boarding"]', '["blr-east"]', 4.0, 60, 8, 0, 12);
    sqlite.prepare(HOST).run(`extra_host_${index}`, "blr", "blr-east", "Extra area", 0);
    sqlite.prepare(PROFILE).run(`extra_sit_${index}`, "blr", `Extra sitter ${index}`, "commission", '["pet_sitting"]', '["blr-east"]', 4.0, 60, 4, 30, 6);
    sqlite.prepare(PROFILE).run(`extra_taxi_${index}`, "blr", `Extra driver ${index}`, "full_time", '["pet_taxi"]', '["blr-east"]', 4.0, 60, 1, 20, 16);
  }
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,'customer_app','{}',?,?)").run(CUSTOMER, "blr", "Stay Latency", "9000099001", now, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const pet = sqlite.prepare("INSERT OR IGNORE INTO canonical_pets(id,customer_id,source_pet_id,name,species,vaccination_status,created_at,updated_at) VALUES (?,?,?,?,?,'verified',?,?)");
  pet.run(PETS.dog, CUSTOMER, PETS.dog, "Bruno", "dog", now, now); pet.run(PETS.cat, CUSTOMER, PETS.cat, "Misty", "cat", now, now);
  const binding = await upsertIdentityBinding(setup, { identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${CUSTOMER}`, subjectType: "customer", subjectId: CUSTOMER, verificationState: "verified", actorId: "stay-latency", reason: "stay/taxi latency regression" });
  const issued = await issuePlatformSession(setup, { bindingId: String(binding.id), identitySource: String(binding.identity_source), principalType: String(binding.principal_type), principalKey: String(binding.principal_key), subjectType: "customer", subjectId: CUSTOMER });
  const latency = { ms: 0 };
  const { log, db } = counted(d1(sqlite), latency);
  enterWorkersDbScope(db);
  globalThis[dbGlobal] = db;
  return { sqlite, db, log, latency, dbGlobal, env: { ...RUNTIME, DB: db }, cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}` };
}

let gatewayModules = null;
async function gateway() {
  if (gatewayModules) return gatewayModules;
  gatewayModules = {
    metrics: await import("../../lib/request-d1-metrics.ts"),
    leases: await import("../../lib/scheduling-reservation-leases.ts"),
    session: await import("../../lib/session-api-gateway.ts"),
    api: await import("../../lib/api-gateway.ts"),
    trusted: await import("../../lib/trusted-workspace-identity.ts"),
    control: await import("../../lib/control-runtime-switches.ts"),
    service: await import("../../lib/service-control.ts"),
    finance: await import("../../lib/financial-runtime-bootstrap.ts"),
  };
  return gatewayModules;
}

const COUNTED_POST_PATHS = new Set(["/api/uat-scheduling", "/api/canonical-bookings", "/api/taxi-ride-bookings"]);
/** Exactly what worker/index.ts runs for an /api/ request, then the real route handler. */
export async function viaWorker(world, request, handler) {
  enterWorkersDbScope(world.db);
  globalThis[world.dbGlobal] = world.db;
  const m = await gateway();
  const url = new URL(request.url);
  const run = async (env) => {
    const leaseCleanup = request.method === "POST" && (url.pathname === "/api/uat-scheduling" || url.pathname === "/api/canonical-bookings") ? m.leases.cleanupExpiredReservationLeases(env.DB) : null;
    leaseCleanup?.catch(() => undefined);
    const inspection = m.trusted.requestForAuthorization(request, env);
    const sessionAccess = await m.session.authorizePlatformSessionRequest(inspection, env.DB).finally(() => leaseCleanup);
    if (sessionAccess instanceof Response) return sessionAccess;
    const access = sessionAccess ?? await m.api.authorizeApiRequest(inspection, env);
    if (access instanceof Response) return access;
    const block = await m.control.runtimeControlBlock(env.DB, inspection); if (block) return block;
    const service = await m.service.blockDisabledServiceRequest(inspection, env.DB); if (service) return service;
    await m.finance.ensureFinancialRuntimeSchema(env.DB);
    return handler(request);
  };
  if (request.method === "POST" && COUNTED_POST_PATHS.has(url.pathname)) {
    const metrics = m.metrics.createRequestD1Metrics(request, true);
    return m.metrics.runWithRequestD1Metrics(metrics, () => run(m.metrics.withRequestD1MetricsEnv(world.env)));
  }
  return run(world.env);
}

/** One request through the gateway, timed and with its own slice of the D1 log. */
export async function timed(world, request, handler) {
  const from = world.log.length, lines = [], original = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  const startedAt = performance.now();
  let response;
  try { response = await viaWorker(world, request, handler); } finally { console.log = original; }
  const elapsedMs = performance.now() - startedAt;
  let body = null; try { body = await response.clone().json(); } catch { body = null; }
  const calls = world.log.slice(from);
  return { response, status: response.status, body, elapsedMs, calls, sequential: calls.filter((call) => call.sequential).length, writes: calls.filter((call) => WRITE.test(call.sql)), lines };
}

/** A local IST wall-clock time `days` from now, as the UTC instant the booking APIs carry. */
export function ist(days, hour, minute = 0) {
  const day = new Date(Date.now() + 5.5 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
  return new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`).toISOString();
}

// Cloudflare stamps every request with its own cf-ray, and the session memo keys on it; so do these requests.
let rays = 0;
const ray = () => `stay-latency-ray-${++rays}`;
const json = (world, path, body, method = "POST") => new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", cookie: world.cookie, origin: ORIGIN, "cf-ray": ray() }, body: JSON.stringify(body) });
export const ADDRESS = { serviceAddress: "12, 100 Feet Road, Indiranagar", servicePincode: "560038" };

export function boardingSearchRequest(world, { scheduledStart, scheduledEnd, petCount = 1, species = ["dog"], zoneId = "blr-east" }) {
  const query = new URLSearchParams({ cityId: "blr", zoneId, scheduledStart, scheduledEnd, petCount: String(petCount), species: species.join(",") });
  return new Request(`${ORIGIN}/api/boarding-commercial?${query}`, { headers: { cookie: world.cookie, "cf-ray": ray() } });
}
export const boardingQuoteRequest = (world, body) => json(world, "/api/boarding-commercial", { paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east", ...body });
export const schedulingRequest = (world, body) => json(world, "/api/uat-scheduling", { customerId: CUSTOMER, cityId: "blr", zoneId: "blr-east", ...ADDRESS, ...body });
export const canonicalBookingRequest = (world, body) => json(world, "/api/canonical-bookings", body);
export const taxiRideBookingRequest = (world, body) => json(world, "/api/taxi-ride-bookings", body);
