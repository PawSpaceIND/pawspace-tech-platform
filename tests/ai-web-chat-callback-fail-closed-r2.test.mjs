/**
 * Proposal 4 revised. Schema, JSON and database errors are not swallowed into a dial.
 * Foreign pet stays 403. Missing pet stays 404. A 409 is not success.
 * Fetch throws. No live telephony and no model spend.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks as installProposalHooks } from "./helpers/module-hooks.mjs";
import { uatVoiceEnv, ALLOWLISTED_PHONE } from "./helpers/voice-harness.mjs";

installProposalHooks("__FAIL_DB__", "__FAIL_ENV__");
const fetches = [];
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || input);
  fetches.push(url);
  throw new Error(`network denied: ${url}`);
};
const control = await import("../lib/ai-first-control-plane.ts");
const route = await import("../app/api/ai-web-chat/route.ts");
const PHONE = `+91${ALLOWLISTED_PHONE}`;
const ORIGIN = "https://app.pawspace.in";

function makeD1(sqlite, reads, fail = {}) {
  const touch = (sql) => { if (/canonical_bookings/i.test(sql)) reads.push(sql); };
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => {
      touch(sql);
      if (fail.pet && /canonical_pets/i.test(sql)) throw new Error("database is locked");
      const row = sqlite.prepare(sql).get(...args);
      return row === undefined ? null : row;
    },
    run: async () => { touch(sql); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => { touch(sql); return { results: sqlite.prepare(sql).all(...args) }; },
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const results = []; for (const item of items) results.push(await item.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}
async function world(env, fail) {
  const reads = [];
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite, reads, fail);
  globalThis.__FAIL_DB__ = db;
  globalThis.__FAIL_ENV__ = env;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
  await ensureSecurityTables(db);
  await ensureCustomerAccountTables(db);
  return { sqlite, db, reads };
}
function seedCustomer(sqlite, customerId, phone, cityId = "blr") {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .run(customerId, cityId, `Customer ${customerId}`, phone, now, now);
}
function seedPet(sqlite, petId, customerId) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)")
    .run(petId, customerId, "Indie", "dog", "Indie", "verified", now, now);
}
function actor() {
  return { email: "customer.callback@pawspace.test", name: "Callback Customer", roleCode: "customer", permissions: ["customers.manage"], developmentPreview: false, identitySource: "customer_app", principalType: "phone", principalKey: PHONE };
}
function seedService(sqlite, serviceCode, cityId) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS catalogue_packages (id TEXT PRIMARY KEY, service_code TEXT NOT NULL, package_code TEXT NOT NULL, city_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)");
  sqlite.prepare("INSERT OR REPLACE INTO catalogue_packages (id, service_code, package_code, city_id, active) VALUES (?,?,?,?,1)").run(`pkg-${serviceCode}-${cityId}`, serviceCode, "standard", cityId);
}
function ensureLaunchSchema(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS city_launch_configs (id TEXT PRIMARY KEY,city_code TEXT NOT NULL UNIQUE,city TEXT NOT NULL,state TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Draft',centre TEXT NOT NULL DEFAULT '',radius_km REAL NOT NULL DEFAULT 15,pincodes TEXT NOT NULL DEFAULT '',gst_included INTEGER NOT NULL DEFAULT 1,services_json TEXT NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_city_launch_status ON city_launch_configs(status)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS city_launch_config_audit (id TEXT PRIMARY KEY,city_config_id TEXT NOT NULL,city TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
}
function seedLaunch(sqlite, cityCode, status, services) {
  ensureLaunchSchema(sqlite);
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO city_launch_configs (id,city_code,city,state,status,centre,radius_km,pincodes,gst_included,services_json,version,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,'',15,'',1,?,1,'fail-closed',?,?)")
    .run(`city-${cityCode}`, cityCode, cityCode, "Test", status, JSON.stringify(services), now, now);
}
function seedBooking(sqlite, customerId, cityId, serviceCode, status) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, city_id TEXT NOT NULL, service_code TEXT NOT NULL, status TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id, customer_id, city_id, service_code, status) VALUES (?,?,?,?,?)").run(`BK-${customerId}-${cityId}-${status}`, customerId, cityId, serviceCode, status);
}
function n(sqlite, name) {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return exists ? Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n) : 0;
}
async function customerCookie(db, customerId, phone) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey: phone,
    subjectType: "customer", subjectId: customerId, cityId: "blr", verificationState: "verified",
    expiresAt: null, metadata: {}, actorId: "test", reason: "fail closed",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}
async function post(db, env, body, cookie) {
  globalThis.__FAIL_DB__ = db;
  globalThis.__FAIL_ENV__ = env;
  const request = new Request(`${ORIGIN}/api/ai-web-chat`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const response = await route.POST(request);
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

test("foreign pet stays 403 and missing pet stays 404 even when a live booking exists", async () => {
  const env = uatVoiceEnv();
  const foreign = await world(env);
  seedCustomer(foreign.sqlite, "CUS-PET", PHONE, "blr");
  seedCustomer(foreign.sqlite, "CUS-OTHER", "+919000000066", "hyd");
  seedPet(foreign.sqlite, "PET-FOREIGN", "CUS-OTHER");
  seedBooking(foreign.sqlite, "CUS-PET", "hyd", "boarding", "confirmed");
  seedService(foreign.sqlite, "boarding", "hyd");
  const before = foreign.reads.length;
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(foreign.db, env, { actor: actor(), customerId: "CUS-PET", message: "Please call me back", idempotencyKey: "fail-foreign", cityId: "hyd", serviceCode: "boarding", petId: "PET-FOREIGN" }),
    (error) => error instanceof Response && error.status === 403,
  );
  assert.equal(foreign.reads.length - before, 0);
  assert.equal(n(foreign.sqlite, "voice_call_orders"), 0);
  assert.equal(n(foreign.sqlite, "voice_call_consents"), 0);

  const missing = await world(env);
  seedCustomer(missing.sqlite, "CUS-MISS", PHONE, "blr");
  seedBooking(missing.sqlite, "CUS-MISS", "hyd", "boarding", "confirmed");
  const beforeMiss = missing.reads.length;
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(missing.db, env, { actor: actor(), customerId: "CUS-MISS", message: "Please call me back", idempotencyKey: "fail-missing", cityId: "hyd", serviceCode: "boarding", petId: "PET-NOPE" }),
    (error) => error instanceof Response && error.status === 404,
  );
  assert.equal(missing.reads.length - beforeMiss, 0);
  assert.equal(n(missing.sqlite, "voice_call_orders"), 0);
  assert.equal(n(missing.sqlite, "ai_callback_request_context"), 0);
});

test("enabled false, broken JSON, a short catalogue and a database error are not success", async () => {
  const env = uatVoiceEnv();
  const disabled = await world(env);
  seedCustomer(disabled.sqlite, "CUS-OFF", PHONE, "blr");
  seedService(disabled.sqlite, "grooming", "hyd");
  seedService(disabled.sqlite, "grooming", "blr");
  seedLaunch(disabled.sqlite, "hyd", "Live", { Grooming: { enabled: false, price: 0 } });
  seedBooking(disabled.sqlite, "CUS-OFF", "hyd", "grooming", "confirmed");
  const before = disabled.reads.length;
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(disabled.db, env, { actor: actor(), customerId: "CUS-OFF", message: "Please call me back", idempotencyKey: "fail-disabled", cityId: "hyd", serviceCode: "grooming" }),
    (error) => error instanceof Response && error.status === 409,
  );
  assert.equal(disabled.reads.length - before, 0);
  assert.equal(n(disabled.sqlite, "voice_call_orders"), 0);
  assert.equal(n(disabled.sqlite, "voice_call_consents"), 0);

  const broken = await world(env);
  seedCustomer(broken.sqlite, "CUS-BROKEN", PHONE, "blr");
  seedService(broken.sqlite, "grooming", "blr");
  broken.sqlite.exec("CREATE TABLE city_launch_configs (id TEXT PRIMARY KEY, city_code TEXT NOT NULL, status TEXT NOT NULL, services_json TEXT NOT NULL)");
  broken.sqlite.prepare("INSERT INTO city_launch_configs (id, city_code, status, services_json) VALUES ('bad','blr','Live',?)").run("not-json");
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(broken.db, env, { actor: actor(), customerId: "CUS-BROKEN", message: "Please call me back", idempotencyKey: "fail-json", serviceCode: "grooming" }),
    (error) => !(error && error.matched === true),
  );
  assert.equal(n(broken.sqlite, "voice_call_orders"), 0);
  assert.equal(n(broken.sqlite, "voice_call_consents"), 0);

  const narrow = await world(env);
  seedCustomer(narrow.sqlite, "CUS-NARROW", PHONE, "blr");
  narrow.sqlite.exec("CREATE TABLE catalogue_packages (id TEXT PRIMARY KEY)");
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(narrow.db, env, { actor: actor(), customerId: "CUS-NARROW", message: "Please call me back", idempotencyKey: "fail-column", serviceCode: "dog_walking" }),
    (error) => !(error && error.matched === true) && !(error instanceof Response && error.status === 200),
  );
  assert.equal(n(narrow.sqlite, "voice_call_orders"), 0);
  assert.equal(n(narrow.sqlite, "voice_call_consents"), 0);

  const locked = await world(env, { pet: true });
  seedCustomer(locked.sqlite, "CUS-LOCK", PHONE, "blr");
  seedPet(locked.sqlite, "PET-LOCK", "CUS-LOCK");
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(locked.db, env, { actor: actor(), customerId: "CUS-LOCK", message: "Please call me back", idempotencyKey: "fail-db", petId: "PET-LOCK" }),
    (error) => error instanceof Error && !(error instanceof Response) && /database is locked/.test(error.message),
  );
  assert.equal(n(locked.sqlite, "voice_call_orders"), 0);
  assert.equal(n(locked.sqlite, "voice_call_consents"), 0);
  assert.deepEqual(fetches, []);
});

test("the route keeps a 409 policy denial and does not report success", async () => {
  const env = uatVoiceEnv();
  const paused = await world(env);
  seedCustomer(paused.sqlite, "CUS-PAUSE", PHONE, "blr");
  seedService(paused.sqlite, "grooming", "hyd");
  seedLaunch(paused.sqlite, "hyd", "Paused", { Grooming: { enabled: true, price: 1349 } });
  seedBooking(paused.sqlite, "CUS-PAUSE", "hyd", "grooming", "confirmed");
  const cookie = await customerCookie(paused.db, "CUS-PAUSE", PHONE);
  const response = await post(paused.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "fail-route-paused", cityId: "hyd", serviceCode: "grooming",
  }, cookie);
  assert.equal(response.status, 409, JSON.stringify(response.payload));
  assert.notEqual(response.payload?.data?.callback?.matched, true);
  assert.equal(n(paused.sqlite, "voice_call_orders"), 0);
  assert.equal(n(paused.sqlite, "voice_call_consents"), 0);

  const foreign = await world(env);
  seedCustomer(foreign.sqlite, "CUS-PET", PHONE, "blr");
  seedCustomer(foreign.sqlite, "CUS-OTHER", "+919000000055", "hyd");
  seedPet(foreign.sqlite, "PET-FOREIGN", "CUS-OTHER");
  const foreignCookie = await customerCookie(foreign.db, "CUS-PET", PHONE);
  const foreignRes = await post(foreign.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "fail-route-pet", petId: "PET-FOREIGN",
  }, foreignCookie);
  assert.equal(foreignRes.status, 403);
  assert.equal(n(foreign.sqlite, "voice_call_orders"), 0);

  const missing = await world(env);
  seedCustomer(missing.sqlite, "CUS-MISS", PHONE, "blr");
  const missingCookie = await customerCookie(missing.db, "CUS-MISS", PHONE);
  const missingRes = await post(missing.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "fail-route-miss", petId: "PET-NOPE",
  }, missingCookie);
  assert.equal(missingRes.status, 404);
  assert.equal(n(missing.sqlite, "voice_call_orders"), 0);
  assert.deepEqual(fetches, []);
});
