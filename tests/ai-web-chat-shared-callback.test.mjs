/**
 * Shared callback context and cancel adapter. Fetch is mocked. No live telephony or model spend.
 * Does not change tests/ai-web-chat-callback-handoff.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";
import { uatVoiceEnv, ALLOWLISTED_PHONE } from "./helpers/voice-harness.mjs";

installWorkersHooks("__SHARED_CB_DB__", "__SHARED_CB_ENV__");

const fetches = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || input);
  fetches.push(url);
  throw new Error(`unexpected network fetch blocked: ${url}`);
};

const control = await import("../lib/ai-first-control-plane.ts");
const gov = await import("../lib/voice-outbound-governance.ts");
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
  globalThis.__SHARED_CB_DB__ = db;
  globalThis.__SHARED_CB_ENV__ = env;
  // The first cloudflare:workers shim in a combined run bakes its own env global.
  globalThis.__CHAT_CB_ENV__ = env;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
  await ensureSecurityTables(db);
  await ensureCustomerAccountTables(db);
  return { sqlite, db };
}

function seedCustomer(sqlite, customerId, phone) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .run(customerId, "blr", `Customer ${customerId}`, phone, now, now);
}

function actor(permissions = ["customers.manage"], principalKey = PHONE) {
  return {
    email: "customer.callback@pawspace.test",
    name: "Callback Customer",
    roleCode: "customer",
    permissions,
    developmentPreview: false,
    identitySource: "customer_app",
    principalType: "phone",
    principalKey,
  };
}


function seedLead(sqlite, leadId, customerId) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT)");
  sqlite.prepare("INSERT INTO lead_work_items (id, customer_id) VALUES (?,?)").run(leadId, customerId);
}
function seedPet(sqlite, petId, customerId) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)")
    .run(petId, customerId, "Indie", "dog", "Indie", "verified", now, now);
}
function seedService(sqlite, serviceCode, cityId = "blr") {
  sqlite.exec("CREATE TABLE IF NOT EXISTS catalogue_packages (id TEXT PRIMARY KEY, service_code TEXT NOT NULL, package_code TEXT NOT NULL, city_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)");
  sqlite.prepare("INSERT OR REPLACE INTO catalogue_packages (id, service_code, package_code, city_id, active) VALUES (?,?,?,?,1)")
    .run(`pkg-${serviceCode}-${cityId}`, serviceCode, "standard", cityId);
}
function seedCityService(sqlite, cityCode, services, status = "Live") {
  sqlite.exec("CREATE TABLE IF NOT EXISTS city_launch_configs (id TEXT PRIMARY KEY,city_code TEXT NOT NULL UNIQUE,city TEXT NOT NULL DEFAULT 'Test',state TEXT NOT NULL DEFAULT 'Test',status TEXT NOT NULL,centre TEXT NOT NULL DEFAULT '',radius_km REAL NOT NULL DEFAULT 15,pincodes TEXT NOT NULL DEFAULT '',gst_included INTEGER NOT NULL DEFAULT 1,services_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL DEFAULT 'test',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT OR REPLACE INTO city_launch_configs (id, city_code, status, services_json) VALUES (?,?,?,?)")
    .run(`city-${cityCode}`, cityCode, status, JSON.stringify(services));
}
function n(sqlite, name) {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return exists ? Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n) : 0;
}

function liveFetches() {
  return fetches.filter((url) => /exotel|elevenlabs|twilio|telephony|api\.openai/i.test(url));
}

async function customerCookie(db, customerId, phone) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey: phone,
    subjectType: "customer", subjectId: customerId, cityId: "blr", verificationState: "verified",
    expiresAt: null, metadata: {}, actorId: "test", reason: "shared callback",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function post(db, body, headers = {}) {
  const request = new Request(ENDPOINT, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const response = await runWithWorkersDb(db, () => route.POST(request));
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

const future = () => new Date(Date.now() + 3 * 86400000).toISOString();
const past = () => new Date(Date.now() - 3 * 86400000).toISOString();

test("invalid requestedStart does not dial and a valid one is bound and readable", async () => {
  const env = uatVoiceEnv();
  const bad = await world(env);
  seedCustomer(bad.sqlite, "CUS-BAD", PHONE);
  const before = fetches.length;
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(bad.db, env, {
      actor: actor(), customerId: "CUS-BAD", message: "Please call me back", idempotencyKey: "sched-bad",
      requestedStart: "11am-1pm", petId: "PET-1", serviceCode: "grooming", leadId: "LEAD-1",
    }),
    (error) => error instanceof Response && error.status === 400,
  );
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(bad.db, env, {
      actor: actor(), customerId: "CUS-BAD", message: "Please call me back", idempotencyKey: "sched-past",
      requestedStart: past(),
    }),
    (error) => error instanceof Response && error.status === 400,
  );
  assert.equal(n(bad.sqlite, "voice_call_orders"), 0);
  assert.equal(n(bad.sqlite, "voice_call_consents"), 0);
  assert.equal(n(bad.sqlite, "ai_callback_request_context"), 0);
  assert.equal(fetches.length, before);

  const soon = await world(env);
  seedCustomer(soon.sqlite, "CUS-BAD", PHONE);
  const immediate = await control.requestGovernedCustomerCallback(soon.db, env, {
    actor: actor(), customerId: "CUS-BAD", message: "Please call me back", idempotencyKey: "sched-now-word",
    requestedStart: "now",
  });
  assert.equal(immediate.matched, true);
  assert.equal(immediate.requestedStart, null);
  assert.equal(soon.sqlite.prepare("SELECT requested_start FROM ai_callback_request_context").get().requested_start, null);

  const good = await world(env);
  seedCustomer(good.sqlite, "CUS-GOOD", PHONE);
  seedLead(good.sqlite, "LEAD-9", "CUS-GOOD");
  seedPet(good.sqlite, "PET-9", "CUS-GOOD");
  seedService(good.sqlite, "pet_taxi", "blr");
  const placed = await control.requestGovernedCustomerCallback(good.db, env, {
    actor: actor(), customerId: "CUS-GOOD", message: "Please call me back", idempotencyKey: "sched-good",
    requestedStart: Date.now() + 5_000, petId: "PET-9", serviceCode: "pet_taxi", leadId: "LEAD-9",
  });
  assert.equal(placed.matched, true);
  assert.equal(placed.callback.dialled, true);
  assert.equal(placed.callback.productionCall, false);
  assert.equal(placed.requestedStart, null);
  assert.equal(placed.petId, "PET-9");
  assert.equal(placed.serviceCode, "pet_taxi");
  assert.equal(placed.leadId, "LEAD-9");
  const order = good.sqlite.prepare("SELECT lead_id,state,production_call FROM voice_call_orders").get();
  assert.equal(order.lead_id, "LEAD-9");
  assert.equal(order.state, "dialing");
  assert.equal(order.production_call, 0);
  const bound = good.sqlite.prepare("SELECT requested_start,pet_id,service_code,lead_id FROM ai_callback_request_context").get();
  assert.equal(bound.requested_start, null);
  assert.equal(bound.pet_id, "PET-9");
  assert.equal(bound.service_code, "pet_taxi");
  assert.equal(bound.lead_id, "LEAD-9");
  assert.equal(n(good.sqlite, "voice_call_orders"), 1);
  assert.equal(n(good.sqlite, "voice_call_consents"), 1);
  assert.deepEqual(liveFetches(), []);
});

test("ownership refusal writes no consent or call; opt-out still blocks an immediate callback", async () => {
  const env = uatVoiceEnv();
  const denied = await world(env);
  seedCustomer(denied.sqlite, "CUS-OWN", PHONE);
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(denied.db, env, {
      actor: actor([]), customerId: "CUS-OWN", message: "Please call me back", idempotencyKey: "own-1",
      requestedStart: future(),
    }),
    (error) => error instanceof Response && error.status === 403,
  );
  assert.equal(n(denied.sqlite, "voice_call_orders"), 0);
  assert.equal(n(denied.sqlite, "voice_call_consents"), 0);

  const opted = await world(env);
  seedCustomer(opted.sqlite, "CUS-OPT", PHONE);
  seedLead(opted.sqlite, "LEAD-OPT", "CUS-OPT");
  seedPet(opted.sqlite, "PET-OPT", "CUS-OPT");
  seedService(opted.sqlite, "grooming", "blr");
  await gov.ensureVoiceCallTables(opted.db);
  await gov.recordVoiceOptOut(opted.db, { phone: PHONE, source: "customer_stop", reason: "do not call", actorId: "customer", asOf: Date.now() - 1000 });
  const blocked = await control.requestGovernedCustomerCallback(opted.db, env, {
    actor: actor(), customerId: "CUS-OPT", message: "Please call me back", idempotencyKey: "opt-1",
    requestedStart: "now", petId: "PET-OPT", serviceCode: "grooming", leadId: "LEAD-OPT",
  });
  assert.equal(blocked.callback.dialled, false);
  assert.equal(blocked.callback.state, "blocked_opt_out");
  assert.equal(opted.sqlite.prepare("SELECT state,dialed_at FROM voice_call_orders").get().dialed_at, null);
  assert.equal(blocked.petId, "PET-OPT");
  assert.equal(n(opted.sqlite, "voice_call_orders"), 1);
  assert.deepEqual(liveFetches(), []);
});

test("identical idempotency key does not create a second call; cancel then replay stays cancelled", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-RE", PHONE);
  seedLead(ctx.sqlite, "LEAD-RE", "CUS-RE");
  seedPet(ctx.sqlite, "PET-RE", "CUS-RE");
  seedService(ctx.sqlite, "boarding", "blr");
  const input = {
    actor: actor(), customerId: "CUS-RE", message: "Please call me back", idempotencyKey: "replay-1",
    requestedStart: Date.now(), petId: "PET-RE", serviceCode: "boarding", leadId: "LEAD-RE",
  };
  const first = await control.requestGovernedCustomerCallback(ctx.db, env, input);
  const again = await control.requestGovernedCustomerCallback(ctx.db, env, input);
  assert.equal(first.callback.dialled, true);
  assert.equal(again.callback.duplicatePrevented, true);
  assert.equal(again.callback.callId, first.callback.callId);
  assert.equal(again.requestedStart, first.requestedStart);
  assert.equal(n(ctx.sqlite, "voice_call_orders"), 1);
  assert.equal(n(ctx.sqlite, "ai_callback_request_context"), 1);

  const before = fetches.length;
  const providerBefore = ctx.sqlite.prepare("SELECT provider_call_id FROM voice_call_orders").get().provider_call_id;
  const cancelled = await control.cancelGovernedCustomerCallback(ctx.db, {
    actor: actor(), customerId: "CUS-RE", callId: first.callback.callId, reason: "customer_cancelled_in_chat",
  });
  assert.equal(cancelled.to, "cancelled");
  const row = ctx.sqlite.prepare("SELECT state,failure_reason_class,provider_call_id,production_call FROM voice_call_orders").get();
  assert.equal(row.state, "cancelled");
  assert.equal(row.failure_reason_class, "cancelled_by_operator");
  assert.equal(row.provider_call_id, providerBefore);
  assert.equal(row.production_call, 0);
  const replay = await control.requestGovernedCustomerCallback(ctx.db, env, input);
  assert.equal(replay.callback.duplicatePrevented, true);
  assert.equal(replay.callback.callId, first.callback.callId);
  assert.equal(replay.callback.state, "cancelled");
  assert.equal(n(ctx.sqlite, "voice_call_orders"), 1);
  assert.equal(fetches.length, before);
  assert.deepEqual(liveFetches(), []);

  await assert.rejects(
    () => control.cancelGovernedCustomerCallback(ctx.db, { actor: actor(), customerId: "CUS-OTHER", callId: first.callback.callId }),
    (error) => error instanceof Response && error.status === 403,
  );
  await assert.rejects(
    () => control.cancelGovernedCustomerCallback(ctx.db, { actor: actor([]), customerId: "CUS-RE", callId: first.callback.callId }),
    (error) => error instanceof Response && error.status === 403,
  );
  await assert.rejects(
    () => control.cancelGovernedCustomerCallback(ctx.db, { actor: actor(), customerId: "CUS-RE", callId: "VCALL-missing" }),
    (error) => error instanceof Response && error.status === 404,
  );
  assert.equal(ctx.sqlite.prepare("SELECT state FROM voice_call_orders").get().state, "cancelled");
  assert.equal(n(ctx.sqlite, "voice_call_orders"), 1);
});

test("a blocked provider still hands off on the route, and the route forwards context and cancel", async () => {
  const env = { ...uatVoiceEnv(), PAWSPACE_VOICE_TRANSPORT: "", PAWSPACE_VOICE_RUNTIME: "not_a_provider" };
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-ROUTE", PHONE);
  seedLead(ctx.sqlite, "LEAD-ROUTE", "CUS-ROUTE");
  seedPet(ctx.sqlite, "PET-ROUTE", "CUS-ROUTE");
  seedService(ctx.sqlite, "grooming", "blr");
  const cookie = await customerCookie(ctx.db, "CUS-ROUTE", PHONE);
  await post(ctx.db, { mode: "authenticated", bot: true, start: true }, { cookie });
  const response = await post(ctx.db, {
    mode: "authenticated", bot: true, choiceId: "request_call", message: "", idempotencyKey: "route-prov-1",
    requestedStart: "now", petId: "PET-ROUTE", serviceCode: "grooming", leadId: "LEAD-ROUTE",
  }, { cookie });
  assert.equal(response.status, 201, JSON.stringify(response.payload));
  assert.equal(response.payload.data.callbackOutcome, "not_placed");
  assert.equal(response.payload.data.callback.callback.dialled, false);
  assert.equal(response.payload.data.callback.callback.blockedBy, "provider_configured");
  assert.equal(response.payload.data.callback.requestedStart, null);
  assert.equal(response.payload.data.callback.petId, "PET-ROUTE");
  assert.equal(response.payload.data.callback.serviceCode, "grooming");
  assert.equal(response.payload.data.callback.leadId, "LEAD-ROUTE");
  assert.equal(ctx.sqlite.prepare("SELECT lead_id,state FROM voice_call_orders").get().lead_id, "LEAD-ROUTE");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs").get().n, 1);
  assert.equal(ctx.sqlite.prepare("SELECT reason FROM ai_handoffs").get().reason, "provider_unavailable");
  const callId = response.payload.data.callback.callback.callId;

  const dialEnv = await world(uatVoiceEnv());
  seedCustomer(dialEnv.sqlite, "CUS-CANCEL", PHONE);
  const dialCookie = await customerCookie(dialEnv.db, "CUS-CANCEL", PHONE);
  await post(dialEnv.db, { mode: "authenticated", bot: true, start: true }, { cookie: dialCookie });
  const placed = await post(dialEnv.db, {
    mode: "authenticated", bot: true, choiceId: "request_call", message: "", idempotencyKey: "route-cancel-1",
  }, { cookie: dialCookie });
  assert.equal(placed.payload.data.callback.callback.dialled, true, JSON.stringify(placed.payload));
  const id = placed.payload.data.callback.callback.callId;
  const before = fetches.length;
  const cancelled = await post(dialEnv.db, { mode: "authenticated", cancelCallId: id }, { cookie: dialCookie });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.payload));
  assert.equal(cancelled.payload.data.callbackOutcome, "cancelled");
  assert.equal(cancelled.payload.data.cancelled.to, "cancelled");
  assert.equal(dialEnv.sqlite.prepare("SELECT state FROM voice_call_orders WHERE id=?").get(id).state, "cancelled");
  // The bot key is already stored, so a second tap is a chat duplicate and does not redial.
  // The message path re-enters the voice engine with the same ai-callback key.
  const replay = await post(dialEnv.db, {
    mode: "authenticated", message: "Please call me back", idempotencyKey: "route-cancel-1:call",
  }, { cookie: dialCookie });
  assert.equal(replay.status, 201, JSON.stringify(replay.payload));
  assert.equal(replay.payload.data.callback.callback.duplicatePrevented, true);
  assert.equal(replay.payload.data.callback.callback.state, "cancelled");
  assert.equal(dialEnv.sqlite.prepare("SELECT COUNT(*) n FROM voice_call_orders").get().n, 1);
  assert.equal(fetches.length, before);
  const foreign = await post(dialEnv.db, { mode: "authenticated", cancelCallId: callId }, { cookie: dialCookie });
  assert.equal(foreign.status, 404);
  assert.deepEqual(liveFetches(), []);
});

function tableExists(sqlite, name) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

const IST_MS = 330 * 60_000;
function istHour(ms) {
  return new Date(ms + IST_MS).getUTCHours();
}
function inQuietHour(hour) {
  return hour >= 21 || hour < 9;
}
function nextOppositeWindow(from, wantQuiet) {
  for (let t = from + 60 * 60_000; t < from + 50 * 3600_000; t += 15 * 60_000) {
    if (inQuietHour(istHour(t)) === wantQuiet) return t;
  }
  throw new Error("no opposite quiet-hours window");
}

test("fresh chat ensure path has no ai_callback_request_context until the callback binds a call id", async () => {
  const env = uatVoiceEnv();
  const fresh = await world(env);
  assert.equal(tableExists(fresh.sqlite, "ai_callback_request_context"), false);
  seedCustomer(fresh.sqlite, "CUS-SCHEMA", PHONE);
  assert.equal(tableExists(fresh.sqlite, "ai_callback_request_context"), false);
  const unmatched = await control.requestGovernedCustomerCallback(fresh.db, env, {
    actor: actor(), customerId: "CUS-SCHEMA", message: "What time do you open?", idempotencyKey: "schema-miss",
  });
  assert.equal(unmatched.matched, false);
  assert.equal(tableExists(fresh.sqlite, "ai_callback_request_context"), false);
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(fresh.db, env, {
      actor: actor(), customerId: "CUS-SCHEMA", message: "Please call me back", idempotencyKey: "schema-bad",
      requestedStart: "tomorrow morning",
    }),
    (error) => error instanceof Response && error.status === 400,
  );
  assert.equal(tableExists(fresh.sqlite, "ai_callback_request_context"), false);
  assert.equal(n(fresh.sqlite, "voice_call_orders"), 0);
  const futureRejected = await control.requestGovernedCustomerCallback(fresh.db, env, {
    actor: actor(), customerId: "CUS-SCHEMA", message: "Please call me back", idempotencyKey: "schema-future",
    requestedStart: future(),
  });
  assert.equal(futureRejected.matched, false);
  assert.equal(futureRejected.scheduling, "unsupported");
  assert.equal(tableExists(fresh.sqlite, "ai_callback_request_context"), false);
  assert.equal(n(fresh.sqlite, "voice_call_orders"), 0);
  assert.equal(n(fresh.sqlite, "voice_call_consents"), 0);
  const placed = await control.requestGovernedCustomerCallback(fresh.db, env, {
    actor: actor(), customerId: "CUS-SCHEMA", message: "Please call me back", idempotencyKey: "schema-ok",
  });
  assert.equal(placed.matched, true);
  assert.ok(placed.callback.callId);
  assert.equal(tableExists(fresh.sqlite, "ai_callback_request_context"), true);
  assert.equal(n(fresh.sqlite, "ai_callback_request_context"), 1);
});

test("future requestedStart is rejected before consent; immediate callbacks keep quiet-hours policy", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-SCHED", PHONE);
  const nowQuiet = inQuietHour(istHour(Date.now()));
  const whenMs = nextOppositeWindow(Date.now(), !nowQuiet);
  const when = new Date(whenMs).toISOString();
  const rejected = await control.requestGovernedCustomerCallback(ctx.db, env, {
    actor: actor(), customerId: "CUS-SCHED", message: "Please call me back", idempotencyKey: "sched-future",
    requestedStart: when,
  });
  assert.equal(rejected.matched, false);
  assert.equal(rejected.scheduling, "unsupported");
  assert.equal(rejected.reason, "unsupported_scheduling");
  assert.equal(rejected.requestedStart, when);
  assert.equal(rejected.notice, "Scheduling is not available.");
  assert.doesNotMatch(rejected.notice, /queued|connected|dialling|dialing|scheduled/i);
  const again = await control.requestGovernedCustomerCallback(ctx.db, env, {
    actor: actor(), customerId: "CUS-SCHED", message: "Please call me back", idempotencyKey: "sched-future",
    requestedStart: Date.now() + 90_000,
  });
  assert.equal(again.scheduling, "unsupported");
  assert.equal(n(ctx.sqlite, "voice_call_orders"), 0);
  assert.equal(n(ctx.sqlite, "voice_call_consents"), 0);
  assert.equal(n(ctx.sqlite, "ai_callback_request_context"), 0);
  assert.equal(n(ctx.sqlite, "voice_call_policy_decisions"), 0);
  assert.equal(tableExists(ctx.sqlite, "ai_callback_request_context"), false);

  const started = Date.now();
  const placed = await control.requestGovernedCustomerCallback(ctx.db, env, {
    actor: actor(), customerId: "CUS-SCHED", message: "Please call me back", idempotencyKey: "sched-window",
    requestedStart: new Date().toISOString(),
  });
  assert.equal(placed.matched, true);
  assert.equal(placed.requestedStart, null);
  const order = ctx.sqlite.prepare("SELECT state, quiet_hours_decision, requested_at, dialed_at FROM voice_call_orders").get();
  const cols = ctx.sqlite.prepare("PRAGMA table_info(voice_call_orders)").all().map((column) => column.name);
  assert.equal(cols.includes("requested_start"), false);
  assert.equal(order.quiet_hours_decision, nowQuiet ? "inside" : "outside");
  assert.ok(Math.abs(order.requested_at - started) < 20_000, `requested_at ${order.requested_at} is not the call clock`);
  assert.ok(Math.abs(order.requested_at - whenMs) > 30 * 60_000, "requested_at followed requestedStart");
  const detail = ctx.sqlite.prepare("SELECT detail FROM voice_call_policy_decisions WHERE check_code='quiet_hours'").get();
  assert.match(detail.detail, new RegExp(`Local hour ${istHour(order.requested_at)}\\b`));
  if (istHour(whenMs) !== istHour(order.requested_at)) {
    assert.doesNotMatch(detail.detail, new RegExp(`Local hour ${istHour(whenMs)}\\b`));
  }
  if (nowQuiet) {
    assert.equal(placed.callback.dialled, false);
    assert.equal(order.state, "blocked_quiet_hours");
    assert.equal(order.dialed_at, null);
  } else {
    assert.equal(placed.callback.dialled, true);
    assert.equal(order.state, "dialing");
  }
  assert.equal(ctx.sqlite.prepare("SELECT requested_start FROM ai_callback_request_context").get().requested_start, null);
  assert.deepEqual(liveFetches(), []);
});

test("foreign or missing pet and unconfigured service write nothing; leadId is still refused before dial", async () => {
  const env = uatVoiceEnv();
  const foreignLead = await world(env);
  seedCustomer(foreignLead.sqlite, "CUS-LEAD-A", PHONE);
  seedCustomer(foreignLead.sqlite, "CUS-LEAD-B", "+919000000001");
  seedLead(foreignLead.sqlite, "LEAD-FOREIGN", "CUS-LEAD-B");
  const now = Date.now();
  foreignLead.sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("PET-FOREIGN", "CUS-LEAD-B", "Other", "dog", now, now);
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(foreignLead.db, env, {
      actor: actor(), customerId: "CUS-LEAD-A", message: "Please call me back", idempotencyKey: "lead-foreign",
      requestedStart: future(), petId: "PET-FOREIGN", serviceCode: "grooming", leadId: "LEAD-FOREIGN",
    }),
    (error) => error instanceof Error && /Lead\/customer ownership mismatch/.test(error.message),
  );
  assert.equal(n(foreignLead.sqlite, "voice_call_orders"), 0);
  assert.equal(tableExists(foreignLead.sqlite, "ai_callback_request_context"), false);

  const missingLead = await world(env);
  seedCustomer(missingLead.sqlite, "CUS-LEAD-MISS", PHONE);
  seedLead(missingLead.sqlite, "LEAD-REAL", "CUS-LEAD-MISS");
  await assert.rejects(
    () => control.requestGovernedCustomerCallback(missingLead.db, env, {
      actor: actor(), customerId: "CUS-LEAD-MISS", message: "Please call me back", idempotencyKey: "lead-missing",
      leadId: "LEAD-NOT-OURS",
    }),
    (error) => error instanceof Error && /Lead is not linked to a canonical customer/.test(error.message),
  );
  assert.equal(n(missingLead.sqlite, "voice_call_orders"), 0);
  assert.equal(tableExists(missingLead.sqlite, "ai_callback_request_context"), false);

  async function refuses(db, sqlite, input, status) {
    await assert.rejects(
      () => control.requestGovernedCustomerCallback(db, env, input),
      (error) => error instanceof Response && error.status === status,
    );
    assert.equal(n(sqlite, "voice_call_orders"), 0);
    assert.equal(n(sqlite, "voice_call_consents"), 0);
    assert.equal(n(sqlite, "ai_callback_request_context"), 0);
    assert.equal(tableExists(sqlite, "ai_callback_request_context"), false);
  }
  const foreignPet = await world(env);
  seedCustomer(foreignPet.sqlite, "CUS-PET", PHONE);
  seedCustomer(foreignPet.sqlite, "CUS-PET-OTHER", "+919000000002");
  seedPet(foreignPet.sqlite, "PET-FOREIGN", "CUS-PET-OTHER");
  seedService(foreignPet.sqlite, "grooming", "blr");
  await refuses(foreignPet.db, foreignPet.sqlite, {
    actor: actor(), customerId: "CUS-PET", message: "Please call me back", idempotencyKey: "pet-foreign",
    requestedStart: "now", petId: "PET-FOREIGN", serviceCode: "grooming",
  }, 403);

  const missingPet = await world(env);
  seedCustomer(missingPet.sqlite, "CUS-PET-MISS", PHONE);
  seedService(missingPet.sqlite, "grooming", "blr");
  await refuses(missingPet.db, missingPet.sqlite, {
    actor: actor(), customerId: "CUS-PET-MISS", message: "Please call me back", idempotencyKey: "pet-missing",
    petId: "PET-NOPE", serviceCode: "grooming",
  }, 404);

  const missingService = await world(env);
  seedCustomer(missingService.sqlite, "CUS-SVC", PHONE);
  seedPet(missingService.sqlite, "PET-SVC", "CUS-SVC");
  await refuses(missingService.db, missingService.sqlite, {
    actor: actor(), customerId: "CUS-SVC", message: "Please call me back", idempotencyKey: "svc-missing",
    requestedStart: future(), petId: "PET-SVC", serviceCode: "not-a-real-service",
  }, 409);

  const otherCity = await world(env);
  seedCustomer(otherCity.sqlite, "CUS-CITY", PHONE);
  seedPet(otherCity.sqlite, "PET-CITY", "CUS-CITY");
  seedService(otherCity.sqlite, "pet_taxi", "del");
  await refuses(otherCity.db, otherCity.sqlite, {
    actor: actor(), customerId: "CUS-CITY", message: "Please call me back", idempotencyKey: "svc-city",
    petId: "PET-CITY", serviceCode: "pet_taxi",
  }, 409);

  const disabled = await world(env);
  seedCustomer(disabled.sqlite, "CUS-OFF", PHONE);
  seedService(disabled.sqlite, "grooming", "blr");
  seedCityService(disabled.sqlite, "blr", { Grooming: { enabled: false, price: 0 } });
  await refuses(disabled.db, disabled.sqlite, {
    actor: actor(), customerId: "CUS-OFF", message: "Please call me back", idempotencyKey: "svc-off",
    serviceCode: "grooming",
  }, 409);

  const owned = await world(env);
  seedCustomer(owned.sqlite, "CUS-OWNED", PHONE);
  seedPet(owned.sqlite, "PET-OWNED", "CUS-OWNED");
  seedCityService(owned.sqlite, "blr", { Grooming: { enabled: true, price: 1349 } });
  const placed = await control.requestGovernedCustomerCallback(owned.db, env, {
    actor: actor(), customerId: "CUS-OWNED", message: "Please call me back", idempotencyKey: "pet-owned",
    requestedStart: "now", petId: "PET-OWNED", serviceCode: "grooming",
  });
  assert.equal(placed.matched, true);
  assert.equal(placed.callback.dialled, true);
  assert.equal(placed.petId, "PET-OWNED");
  assert.equal(placed.serviceCode, "grooming");
  assert.equal(placed.requestedStart, null);
  const bound = owned.sqlite.prepare("SELECT pet_id, service_code, requested_start, lead_id FROM ai_callback_request_context").get();
  assert.equal(bound.pet_id, "PET-OWNED");
  assert.equal(bound.service_code, "grooming");
  assert.equal(bound.requested_start, null);
  assert.equal(bound.lead_id, null);
  assert.equal(n(owned.sqlite, "voice_call_orders"), 1);
  assert.equal(n(owned.sqlite, "voice_call_consents"), 1);
  assert.deepEqual(liveFetches(), []);
});

test("a future requestedStart is handed to the team and is not queued", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-FUT", PHONE);
  seedPet(ctx.sqlite, "PET-FUT", "CUS-FUT");
  seedService(ctx.sqlite, "grooming", "blr");
  const cookie = await customerCookie(ctx.db, "CUS-FUT", PHONE);
  await post(ctx.db, { mode: "authenticated", bot: true, start: true }, { cookie });
  const when = future();
  const before = fetches.length;
  const response = await post(ctx.db, {
    mode: "authenticated", bot: true, choiceId: "request_call", message: "", idempotencyKey: "route-future-1",
    requestedStart: when, petId: "PET-FUT", serviceCode: "grooming",
  }, { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.data.callback.matched, false);
  assert.equal(response.payload.data.callback.scheduling, "unsupported");
  assert.equal(response.payload.data.callback.reason, "unsupported_scheduling");
  assert.equal(response.payload.data.callbackOutcome, "unsupported_scheduling");
  assert.equal(response.payload.data.callbackNotice, "Scheduling is not available. The PawSpace team has been asked to follow up.");
  assert.doesNotMatch(response.payload.data.callbackNotice, /queued|connected|dialling|dialing/i);
  assert.equal(response.payload.data.callbackNotice.includes("scheduled"), false);
  assert.equal(ctx.sqlite.prepare("SELECT reason FROM ai_handoffs").get().reason, "customer_requested_human");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs").get().n, 1);
  assert.equal(n(ctx.sqlite, "voice_call_orders"), 0);
  assert.equal(n(ctx.sqlite, "voice_call_consents"), 0);
  assert.equal(n(ctx.sqlite, "ai_callback_request_context"), 0);
  assert.equal(fetches.length, before);
  assert.deepEqual(liveFetches(), []);
});


test("phone collision without lead is refused before consent", async () => {
 const env=uatVoiceEnv(),ctx=await world(env);
 seedCustomer(ctx.sqlite,"CUS-COLLISION-A",PHONE);
 seedCustomer(ctx.sqlite,"CUS-COLLISION-B",PHONE);
 await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,env,{
  actor:actor(),customerId:"CUS-COLLISION-A",message:"Please call me back",idempotencyKey:"collision-no-lead",
 }),/not uniquely owned/);
 assert.equal(n(ctx.sqlite,"voice_call_consents"),0);
 assert.equal(n(ctx.sqlite,"voice_call_orders"),0);
 assert.equal(n(ctx.sqlite,"ai_callback_request_context"),0);
});

test("future callback without a thread does not claim team handoff", async () => {
 const env=uatVoiceEnv(),ctx=await world(env);
 seedCustomer(ctx.sqlite,"CUS-NO-THREAD",PHONE);
 const cookie=await customerCookie(ctx.db,"CUS-NO-THREAD",PHONE);
 const response=await post(ctx.db,{mode:"authenticated",message:"Please call me back",idempotencyKey:"future-no-thread",requestedStart:future()},{cookie});
 assert.equal(response.status,200,JSON.stringify(response.payload));
 assert.equal(response.payload.data.callbackOutcome,"unsupported_scheduling");
 assert.equal(response.payload.data.callbackNotice,"Scheduling is not available. Open the customer app to contact the PawSpace team.");
 assert.equal(response.payload.data.callback.notice,"Scheduling is not available.");
 assert.equal(n(ctx.sqlite,"ai_handoffs"),0);
 assert.equal(n(ctx.sqlite,"voice_call_consents"),0);
 assert.equal(n(ctx.sqlite,"voice_call_orders"),0);
});

for(const existingContext of [true,false])test(`foreign legacy idempotency key with ${existingContext?"existing":"missing"} context cannot bind or expose another customer's call`,async()=>{
 const env=uatVoiceEnv(),ctx=await world(env),secondPhone="+919900002222";
 seedCustomer(ctx.sqlite,"CUS-KEY-A",PHONE);seedCustomer(ctx.sqlite,"CUS-KEY-B",secondPhone);
 seedPet(ctx.sqlite,"PET-KEY-A","CUS-KEY-A");seedPet(ctx.sqlite,"PET-KEY-B","CUS-KEY-B");
 const inputA={actor:actor(),customerId:"CUS-KEY-A",message:"Please call me back",idempotencyKey:"shared-key",petId:"PET-KEY-A"};
 const first=await control.requestGovernedCustomerCallback(ctx.db,env,inputA);
 const original=ctx.sqlite.prepare("SELECT * FROM ai_callback_request_context WHERE call_id=?").get(first.callback.callId);
 ctx.sqlite.prepare("UPDATE voice_call_orders SET idempotency_key=? WHERE id=?").run("ai-callback:shared-key",first.callback.callId);
 ctx.sqlite.prepare("UPDATE ai_callback_request_context SET idempotency_key=? WHERE call_id=?").run("ai-callback:shared-key",first.callback.callId);
 if(!existingContext)ctx.sqlite.prepare("DELETE FROM ai_callback_request_context WHERE call_id=?").run(first.callback.callId);
 const secondInput={actor:actor(["customers.manage"],secondPhone),customerId:"CUS-KEY-B",message:"Please call me back",idempotencyKey:"shared-key",petId:"PET-KEY-B"};
 const second=await control.requestGovernedCustomerCallback(ctx.db,env,secondInput);
 assert.notEqual(second.callback.callId,first.callback.callId);
 assert.equal(second.petId,"PET-KEY-B");assert.equal(second.contextCustomerId,"CUS-KEY-B");
 const foreign=ctx.sqlite.prepare("SELECT * FROM ai_callback_request_context WHERE call_id=?").get(first.callback.callId);
 if(existingContext){assert.equal(foreign.customer_id,"CUS-KEY-A");assert.equal(foreign.pet_id,original.pet_id);}else assert.equal(foreign,undefined);
 const replay=await control.requestGovernedCustomerCallback(ctx.db,env,secondInput);
 assert.equal(replay.callback.callId,second.callback.callId);assert.equal(replay.callback.duplicatePrevented,true);
 const legacyReplay=await control.requestGovernedCustomerCallback(ctx.db,env,inputA);
 assert.equal(legacyReplay.callback.callId,first.callback.callId);assert.equal(legacyReplay.callback.duplicatePrevented,true);
 assert.equal(n(ctx.sqlite,"voice_call_orders"),2);assert.deepEqual(liveFetches(),[]);
});

test("a foreign call occupying the scoped key fails closed before consent or context insertion",async()=>{
 const env=uatVoiceEnv(),ctx=await world(env),secondPhone="+919900002222";
 seedCustomer(ctx.sqlite,"CUS-SCOPE-A",PHONE);seedCustomer(ctx.sqlite,"CUS-SCOPE-B",secondPhone);
 const first=await control.requestGovernedCustomerCallback(ctx.db,env,{actor:actor(),customerId:"CUS-SCOPE-A",message:"Please call me back",idempotencyKey:"first"});
 ctx.sqlite.prepare("UPDATE voice_call_orders SET idempotency_key=? WHERE id=?").run(`ai-callback:v2:${JSON.stringify(["CUS-SCOPE-B","collision"])}`,first.callback.callId);
 ctx.sqlite.prepare("DELETE FROM ai_callback_request_context WHERE call_id=?").run(first.callback.callId);
 const before=n(ctx.sqlite,"voice_call_consents");
 await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,env,{actor:actor(["customers.manage"],secondPhone),customerId:"CUS-SCOPE-B",message:"Please call me back",idempotencyKey:"collision"}),error=>error instanceof Response&&error.status===403);
 assert.equal(n(ctx.sqlite,"voice_call_consents"),before);assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.equal(n(ctx.sqlite,"ai_callback_request_context"),0);
});

test("an owned call with foreign stored context refuses replay without returning context",async()=>{
 const env=uatVoiceEnv(),ctx=await world(env);
 seedCustomer(ctx.sqlite,"CUS-CONTEXT-A",PHONE);seedCustomer(ctx.sqlite,"CUS-CONTEXT-B","+919900002222");
 const input={actor:actor(),customerId:"CUS-CONTEXT-A",message:"Please call me back",idempotencyKey:"context-poison"};
 const first=await control.requestGovernedCustomerCallback(ctx.db,env,input);
 ctx.sqlite.prepare("UPDATE ai_callback_request_context SET customer_id=?,pet_id=? WHERE call_id=?").run("CUS-CONTEXT-B","SECRET-PET-B",first.callback.callId);
 const before=ctx.sqlite.prepare("SELECT * FROM voice_call_consents").get();
 await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,env,input),error=>error instanceof Response&&error.status===403);
 assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM voice_call_consents").get(),before);
 assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.equal(ctx.sqlite.prepare("SELECT customer_id,pet_id FROM ai_callback_request_context").get().pet_id,"SECRET-PET-B");
});

test("returned foreign call is refused even if the voice engine replays after preflight",async()=>{
 const env=uatVoiceEnv(),ctx=await world(env),secondPhone="+919900002222";
 seedCustomer(ctx.sqlite,"CUS-RETURN-A",PHONE);seedCustomer(ctx.sqlite,"CUS-RETURN-B",secondPhone);
 const first=await control.requestGovernedCustomerCallback(ctx.db,env,{actor:actor(),customerId:"CUS-RETURN-A",message:"call me",idempotencyKey:"first-return"});
 const originalContext=ctx.sqlite.prepare("SELECT * FROM ai_callback_request_context WHERE call_id=?").get(first.callback.callId);
 const originalPrepare=ctx.db.prepare.bind(ctx.db);
 ctx.db.prepare=sql=>sql==="SELECT * FROM voice_call_orders WHERE idempotency_key=?"?{bind:()=>({first:async()=>ctx.sqlite.prepare("SELECT * FROM voice_call_orders WHERE id=?").get(first.callback.callId)})}:originalPrepare(sql);
 await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,env,{actor:actor(["customers.manage"],secondPhone),customerId:"CUS-RETURN-B",message:"call me",idempotencyKey:"second-return"}),error=>error instanceof Response&&error.status===403);
 assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM ai_callback_request_context WHERE call_id=?").get(first.callback.callId),originalContext);
 assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.equal(n(ctx.sqlite,"ai_callback_request_context"),1);assert.deepEqual(liveFetches(),[]);
});
