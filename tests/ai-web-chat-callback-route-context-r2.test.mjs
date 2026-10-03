/**
 * Proposal 2 revised. The route forwards canonical context, including serviceDate and bookingId.
 * It does not use a service whitelist. A client identity and a replay callId are not trusted.
 * Fetch throws. No live telephony and no model spend.
 * Binding checks on callId replay stay with a908ca48; this test does not require that fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks as installProposalHooks } from "./helpers/module-hooks.mjs";
import { uatVoiceEnv, ALLOWLISTED_PHONE } from "./helpers/voice-harness.mjs";

installProposalHooks("__ROUTE_CTX_DB__", "__ROUTE_CTX_ENV__");
const fetches = [];
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || input);
  fetches.push(url);
  throw new Error(`network denied: ${url}`);
};
const route = await import("../app/api/ai-web-chat/route.ts");
const ORIGIN = "https://app.pawspace.in";
const ENDPOINT = `${ORIGIN}/api/ai-web-chat`;
const PHONE = `+91${ALLOWLISTED_PHONE}`;

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const results = []; for (const item of items) results.push(await item.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}
async function world(env) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__ROUTE_CTX_DB__ = db;
  globalThis.__ROUTE_CTX_ENV__ = env;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
  await ensureSecurityTables(db);
  await ensureCustomerAccountTables(db);
  return { sqlite, db };
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
function seedService(sqlite, serviceCode, cityId) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS catalogue_packages (id TEXT PRIMARY KEY, service_code TEXT NOT NULL, package_code TEXT NOT NULL, city_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)");
  sqlite.prepare("INSERT OR REPLACE INTO catalogue_packages (id, service_code, package_code, city_id, active) VALUES (?,?,?,?,1)").run(`pkg-${serviceCode}-${cityId}`, serviceCode, "standard", cityId);
}
function seedLead(sqlite, leadId, customerId) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT)");
  sqlite.prepare("INSERT INTO lead_work_items (id, customer_id) VALUES (?,?)").run(leadId, customerId);
}
function seedBooking(sqlite, id, customerId, cityId, serviceCode, status) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, city_id TEXT NOT NULL, service_code TEXT NOT NULL, status TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id, customer_id, city_id, service_code, status) VALUES (?,?,?,?,?)").run(id, customerId, cityId, serviceCode, status);
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
    expiresAt: null, metadata: {}, actorId: "test", reason: "route context",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}
async function post(db, env, body, cookie) {
  globalThis.__ROUTE_CTX_DB__ = db;
  globalThis.__ROUTE_CTX_ENV__ = env;
  const request = new Request(ENDPOINT, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const response = await route.POST(request);
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

test("canonical session context is forwarded and a client identity is refused", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-HYD", PHONE, "hyd");
  seedCustomer(ctx.sqlite, "CUS-OTHER", "+919000000099", "del");
  seedPet(ctx.sqlite, "PET-HYD", "CUS-HYD");
  seedService(ctx.sqlite, "grooming", "hyd");
  seedLead(ctx.sqlite, "LEAD-HYD", "CUS-HYD");
  const cookie = await customerCookie(ctx.db, "CUS-HYD", PHONE);
  const placed = await post(ctx.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-canon",
    petId: "PET-HYD", serviceCode: "grooming", leadId: "LEAD-HYD",
  }, cookie);
  assert.equal(placed.status, 201, JSON.stringify(placed.payload));
  assert.equal(placed.payload.data.callback.matched, true);
  assert.equal(placed.payload.data.callback.petId, "PET-HYD");
  assert.equal(placed.payload.data.callback.serviceCode, "grooming");
  assert.equal(placed.payload.data.callback.leadId, "LEAD-HYD");
  assert.equal(placed.payload.data.callback.cityId, "hyd");
  const order = ctx.sqlite.prepare("SELECT city_id, customer_id FROM voice_call_orders").get();
  assert.equal(order.city_id, "hyd");
  assert.notEqual(order.city_id, "blr");
  assert.equal(order.customer_id, "CUS-HYD");
  const bound = ctx.sqlite.prepare("SELECT customer_id, pet_id, service_code, lead_id, city_id FROM ai_callback_request_context").get();
  assert.equal(bound.customer_id, "CUS-HYD");
  assert.equal(bound.pet_id, "PET-HYD");
  assert.equal(bound.service_code, "grooming");
  assert.equal(bound.lead_id, "LEAD-HYD");
  assert.equal(bound.city_id, "hyd");

  const before = n(ctx.sqlite, "voice_call_orders");
  const spoofed = await post(ctx.db, env, {
    mode: "authenticated", customerId: "CUS-OTHER", message: "Please call me back", idempotencyKey: "route-spoof",
  }, cookie);
  assert.equal(spoofed.status, 403);
  assert.match(JSON.stringify(spoofed.payload), /not accepted/i);
  assert.equal(n(ctx.sqlite, "voice_call_orders"), before);
});

test("a replay-owned callId is not used as context and binding checks stay with the owner", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-HYD", PHONE, "hyd");
  seedCustomer(ctx.sqlite, "CUS-OTHER", "+919000000088", "del");
  seedPet(ctx.sqlite, "PET-MINE", "CUS-HYD");
  ctx.sqlite.exec("CREATE TABLE ai_callback_request_context (call_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, customer_id TEXT NOT NULL, requested_start TEXT, pet_id TEXT, service_code TEXT, lead_id TEXT, city_id TEXT, created_at INTEGER NOT NULL)");
  ctx.sqlite.prepare("INSERT INTO ai_callback_request_context (call_id,idempotency_key,customer_id,requested_start,pet_id,service_code,lead_id,city_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("VCALL-FOREIGN", "ai-callback:foreign", "CUS-OTHER", null, "PET-FOREIGN", "boarding", "LEAD-FOREIGN", "del", Date.now());
  const cookie = await customerCookie(ctx.db, "CUS-HYD", PHONE);
  const placed = await post(ctx.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-ignore-call",
    callId: "VCALL-FOREIGN", petId: "PET-MINE",
  }, cookie);
  assert.equal(placed.status, 201, JSON.stringify(placed.payload));
  assert.equal(placed.payload.data.callback.petId, "PET-MINE");
  assert.notEqual(placed.payload.data.callback.petId, "PET-FOREIGN");
  assert.equal(placed.payload.data.callback.cityId, "hyd");
  const foreign = ctx.sqlite.prepare("SELECT customer_id, pet_id, city_id FROM ai_callback_request_context WHERE call_id='VCALL-FOREIGN'").get();
  assert.equal(foreign.customer_id, "CUS-OTHER");
  assert.equal(foreign.pet_id, "PET-FOREIGN");
  assert.equal(foreign.city_id, "del");
  const order = ctx.sqlite.prepare("SELECT customer_id, city_id FROM voice_call_orders").get();
  assert.equal(order.customer_id, "CUS-HYD");
  assert.equal(order.city_id, "hyd");
  assert.deepEqual(fetches, []);
});

test("foreign pet, missing pet, and an ineligible city are not forwarded into a dial", async () => {
  const env = uatVoiceEnv();
  const foreign = await world(env);
  seedCustomer(foreign.sqlite, "CUS-HYD", PHONE, "hyd");
  seedCustomer(foreign.sqlite, "CUS-OTHER", "+919000000077", "del");
  seedPet(foreign.sqlite, "PET-FOREIGN", "CUS-OTHER");
  const foreignCookie = await customerCookie(foreign.db, "CUS-HYD", PHONE);
  const foreignRes = await post(foreign.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-foreign-pet", petId: "PET-FOREIGN",
  }, foreignCookie);
  assert.equal(foreignRes.status, 403);
  assert.equal(n(foreign.sqlite, "voice_call_orders"), 0);
  assert.equal(n(foreign.sqlite, "voice_call_consents"), 0);

  const missing = await world(env);
  seedCustomer(missing.sqlite, "CUS-HYD", PHONE, "hyd");
  const missingCookie = await customerCookie(missing.db, "CUS-HYD", PHONE);
  const missingRes = await post(missing.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-missing-pet", petId: "PET-NOPE",
  }, missingCookie);
  assert.equal(missingRes.status, 404);
  assert.equal(n(missing.sqlite, "voice_call_orders"), 0);

  const city = await world(env);
  seedCustomer(city.sqlite, "CUS-HYD", PHONE, "hyd");
  seedBooking(city.sqlite, "BK-CANCEL", "CUS-HYD", "del", "boarding", "cancelled");
  const cityCookie = await customerCookie(city.db, "CUS-HYD", PHONE);
  const denied = await post(city.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-bad-city", cityId: "del",
  }, cityCookie);
  assert.equal(denied.status, 409);
  assert.equal(n(city.sqlite, "voice_call_orders"), 0);
  assert.equal(n(city.sqlite, "voice_call_consents"), 0);

  const walked = await world(env);
  seedCustomer(walked.sqlite, "CUS-HYD", PHONE, "hyd");
  seedService(walked.sqlite, "dog_walking", "maa");
  const walkedCookie = await customerCookie(walked.db, "CUS-HYD", PHONE);
  const allowed = await post(walked.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-walk",
    cityId: "maa", serviceCode: "dog_walking",
  }, walkedCookie);
  assert.equal(allowed.status, 201, JSON.stringify(allowed.payload));
  assert.equal(allowed.payload.data.callback.cityId, "maa");
  assert.equal(allowed.payload.data.callback.serviceCode, "dog_walking");
  assert.equal(walked.sqlite.prepare("SELECT city_id FROM canonical_customers WHERE id='CUS-HYD'").get().city_id, "hyd");

  const food = await world(env);
  seedCustomer(food.sqlite, "CUS-HYD", PHONE, "hyd");
  const foodCookie = await customerCookie(food.db, "CUS-HYD", PHONE);
  const foodRes = await post(food.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-food", cityId: "hyd", serviceCode: "fresh_food",
  }, foodCookie);
  assert.equal(foodRes.status, 409);
  assert.equal(n(food.sqlite, "voice_call_orders"), 0);
  const move = await world(env);
  seedCustomer(move.sqlite, "CUS-HYD", PHONE, "hyd");
  const moveCookie = await customerCookie(move.db, "CUS-HYD", PHONE);
  const moveRes = await post(move.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-move", cityId: "hyd", serviceCode: "relocation",
  }, moveCookie);
  assert.equal(moveRes.status, 409);
  assert.equal(n(move.sqlite, "voice_call_orders"), 0);
  assert.deepEqual(fetches, []);
});

test("serviceDate is persisted and a future requestedStart is not dialled", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-HYD", PHONE, "hyd");
  const cookie = await customerCookie(ctx.db, "CUS-HYD", PHONE);
  const dated = await post(ctx.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-service-date", serviceDate: "01/12/2026",
  }, cookie);
  assert.equal(dated.status, 201, JSON.stringify(dated.payload));
  assert.equal(dated.payload.data.callback.serviceDate, "01/12/2026");
  assert.equal(dated.payload.data.callback.requestedStart, null);
  assert.notEqual(dated.payload.data.callback.scheduling, "unsupported");
  assert.equal(ctx.sqlite.prepare("SELECT service_date, city_id FROM ai_callback_request_context").get().service_date, "01/12/2026");
  assert.equal(ctx.sqlite.prepare("SELECT city_id FROM voice_call_orders").get().city_id, "hyd");
  assert.notEqual(dated.payload.data.callbackOutcome, "unsupported_scheduling");
  if (dated.payload.data.callbackOutcome === "accepted") assert.match(dated.payload.data.callbackNotice, /accepted/i);
  else assert.doesNotMatch(String(dated.payload.data.callbackNotice), /accepted/i);

  const later = await world(env);
  seedCustomer(later.sqlite, "CUS-HYD", PHONE, "hyd");
  const laterCookie = await customerCookie(later.db, "CUS-HYD", PHONE);
  const dmy = await post(later.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-dmy", requestedStart: "01/12/2026",
  }, laterCookie);
  assert.equal(dmy.status, 200, JSON.stringify(dmy.payload));
  assert.equal(dmy.payload.data.callback.scheduling, "unsupported");
  assert.equal(dmy.payload.data.callback.serviceDate, null);
  assert.equal(dmy.payload.data.callbackOutcome, "unsupported_scheduling");
  assert.equal(n(later.sqlite, "voice_call_orders"), 0);
  assert.equal(n(later.sqlite, "voice_call_consents"), 0);
  const handoffTable = later.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_handoffs'").get();
  const handoffs = handoffTable ? Number(later.sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs").get().n) : 0;
  if (handoffs > 0) assert.equal(dmy.payload.data.callbackNotice, "Scheduling is not available. The PawSpace team has been asked to follow up.");
  else {
    assert.equal(dmy.payload.data.callbackNotice, "Scheduling is not available. Open the customer app to contact the PawSpace team.");
    assert.doesNotMatch(dmy.payload.data.callbackNotice, /has been asked/i);
  }

  const booked = await world(env);
  seedCustomer(booked.sqlite, "CUS-HYD", PHONE, "hyd");
  seedBooking(booked.sqlite, "BK-MAA", "CUS-HYD", "maa", "boarding", "confirmed");
  const bookedCookie = await customerCookie(booked.db, "CUS-HYD", PHONE);
  const allowed = await post(booked.db, env, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-active-city", bookingId: "BK-MAA",
  }, bookedCookie);
  assert.equal(allowed.status, 201, JSON.stringify(allowed.payload));
  assert.equal(allowed.payload.data.callback.cityId, "maa");
  assert.equal(allowed.payload.data.callback.serviceCode, "boarding");
  assert.equal(allowed.payload.data.callback.bookingId, "BK-MAA");
  assert.equal(booked.sqlite.prepare("SELECT city_id FROM canonical_customers WHERE id='CUS-HYD'").get().city_id, "hyd");
  assert.deepEqual(fetches, []);
});
