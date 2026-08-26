/**
 * PawSpace Total Journey Audit, Wave 2 Batch B — two more branches written for "staff" that a
 * service_provider session walks straight through, because they are gated on a permission that role
 * holds by default.
 *
 * This is the fifth and sixth instance of the same class in this audit. bookings.view,
 * scheduling.view and communications.call are ALL default service_provider permissions
 * (lib/platform-security.ts), so none of them means "staff".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_CMA_DB__", "__PTJA_CMA_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const STAFF = {
  "content-type": "application/json",
  "oai-authenticated-user-email": "ops.admin@pawspace.test",
  "oai-authenticated-user-full-name": "Ops%20admin",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};

async function baseWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_CMA_DB__ = db;
  globalThis.__PTJA_CMA_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-ADMIN','ops.admin@pawspace.test','Ops admin','admin','active',?,?)").bind(now, now).run();
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "partner_otp", principalType: "identity_subject", principalKey: "provider:PRV-ATTACKER-B",
    subjectType: "provider", subjectId: "PRV-ATTACKER-B", verificationState: "verified",
    actorId: "ptja-w2b", reason: "PTJA Wave 2B authorization regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "partner_otp", principalType: "identity_subject",
    principalKey: String(binding.principal_key), subjectType: "provider", subjectId: "PRV-ATTACKER-B",
  });
  return { sqlite, db, now, providerCookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}` };
}

// =====================================================================================================
// PTJA-W2B-M01 — any onboarded provider reads every customer's Food proof snapshot
//
// The non-customer branch of GET /api/food-proof asks for bookings.view and nothing else, and
// bookings.view is a default service_provider permission - so the branch written for staff admits every
// onboarded provider. The four sibling proof routes (walking, sitting, taxi, boarding) each bind the
// caller to the record with requireProviderOwnership; food-proof has no provider binding at all, and
// food orders carry no provider column to bind to.
//
// MEASURED: gateway ALLOW on bookings.view for role service_provider, handler 200, returning the order,
// its customer id, and quality incidents whose free text carried the customer's name, street address
// and phone number verbatim.
//
// Gated on customers.view, the capability the platform already defines for reading customer records -
// held by founder, superuser, admin, manager and associate, and NOT by service_provider. Same
// correction as the funeral-memorial and relocation routes earlier in this audit.
// =====================================================================================================

test("W2B-M01: a provider session cannot read another customer's food proof", async () => {
  const { sqlite, db, providerCookie, now } = await baseWorld();
  const food = await import("../lib/food-fulfilment-governance.ts");
  await food.ensureFoodFulfilmentTables(db);
  sqlite.prepare("INSERT INTO food_orders (id,idempotency_key,customer_id,city_id,zone_id,status,commercial_status,inventory_mode,delivery_status,total_amount,currency,created_by,created_at,updated_at) VALUES ('FOOD-VICTIM-1','idem-v1','CUST-VICTIM-A','blr','blr-east','confirmed','uat_only','uat_seed','delivered',1497,'INR','CUST-VICTIM-A',?,?)").run(now, now);
  // the proof read joins lines and the inventory reservation, so an order without them is invisible
  sqlite.prepare("INSERT INTO food_order_lines (id,order_id,sku,item_name,item_version,quantity,unit_price,line_total,currency) VALUES ('FL-1','FOOD-VICTIM-1','food-uat-cat-adult-1kg','Adult Cat Food 1kg',1,3,499,1497,'INR')").run();
  sqlite.prepare("INSERT INTO food_inventory_reservations (id,order_id,sku,zone_id,quantity,status,inventory_mode,created_at,updated_at) VALUES ('FR-1','FOOD-VICTIM-1','food-uat-cat-adult-1kg','blr-east',3,'reserved','uat_seed',?,?)").run(now, now);

  const route = await import("../app/api/food-proof/route.ts");
  const response = await route.GET(new Request("https://uat.pawspace.in/api/food-proof?orderId=FOOD-VICTIM-1", { headers: { cookie: providerCookie } }));
  assert.notEqual(response.status, 200,
    `a provider with no relationship to the order must not read its proof: ${response.status} ${(await response.clone().text()).slice(0, 250)}`);
});

test("W2B-M01: staff still read the food proof", async () => {
  // Non-vacuity. Closing the branch entirely would satisfy the case above and break the ops workflow.
  const { sqlite, db, now } = await baseWorld();
  const food = await import("../lib/food-fulfilment-governance.ts");
  await food.ensureFoodFulfilmentTables(db);
  sqlite.prepare("INSERT INTO food_orders (id,idempotency_key,customer_id,city_id,zone_id,status,commercial_status,inventory_mode,delivery_status,total_amount,currency,created_by,created_at,updated_at) VALUES ('FOOD-VICTIM-1','idem-v1','CUST-VICTIM-A','blr','blr-east','confirmed','uat_only','uat_seed','delivered',1497,'INR','CUST-VICTIM-A',?,?)").run(now, now);
  // the proof read joins lines and the inventory reservation, so an order without them is invisible
  sqlite.prepare("INSERT INTO food_order_lines (id,order_id,sku,item_name,item_version,quantity,unit_price,line_total,currency) VALUES ('FL-1','FOOD-VICTIM-1','food-uat-cat-adult-1kg','Adult Cat Food 1kg',1,3,499,1497,'INR')").run();
  sqlite.prepare("INSERT INTO food_inventory_reservations (id,order_id,sku,zone_id,quantity,status,inventory_mode,created_at,updated_at) VALUES ('FR-1','FOOD-VICTIM-1','food-uat-cat-adult-1kg','blr-east',3,'reserved','uat_seed',?,?)").run(now, now);

  const route = await import("../app/api/food-proof/route.ts");
  const response = await route.GET(new Request("https://uat.pawspace.in/api/food-proof?orderId=FOOD-VICTIM-1", { headers: STAFF }));
  assert.equal(response.status, 200, `staff must still read it: ${(await response.clone().text()).slice(0, 250)}`);
});

// =====================================================================================================
// PTJA-W2B-M03 — a provider session opts out and closes any CRM lead through the bot-call path
//
// POST /api/bot-call-outcomes action=record is gated on communications.call at BOTH gates, and
// communications.call is a default service_provider permission. The equivalent HUMAN action - logging an
// Opt-out attempt through /api/revenue-crm - requires customers.manage and refuses the same session at
// the gateway with a 403.
//
// MEASURED: gateway ALLOW, handler 201 {"leadId":"LEAD-VICTIM-1","contactId":"CUST-VICTIM-A",
// "primaryTag":"do_not_call","crmOutcome":"Opt-out","contacted":true,"optedOut":true} - a permanent
// do-not-call and a closed lead written by a provider with no relationship to either. The identical
// intent through the human path was refused 403.
//
// The bot path now requires customers.manage, exactly what the human path it writes the same rows
// through already requires. Nothing new is decided: the two paths simply stop disagreeing.
// =====================================================================================================

test("W2B-M03: a provider session cannot opt out a lead through the bot-call path", async () => {
  const { db, providerCookie } = await baseWorld();
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const body = JSON.stringify({
    action: "record", idempotencyKey: "bot-run1", leadId: "LEAD-VICTIM-1", phone: "+919800000001",
    channel: "voice", botProvider: "pawspace_voice_bot", callRef: "CALL-1", primaryTag: "do_not_call",
    notes: "Marked do-not-call by an unrelated provider",
  });
  const request = () => new Request("https://uat.pawspace.in/api/bot-call-outcomes", {
    method: "POST", headers: { "content-type": "application/json", cookie: providerCookie }, body,
  });

  const gateway = await authorizeApiRequest(request(), { DB: db });
  assert.ok(gateway instanceof Response,
    `the gateway must refuse a provider session on this write, got an allow: ${JSON.stringify(gateway).slice(0, 250)}`);
  assert.equal(gateway.status, 403, "with a 403");

  const route = await import("../app/api/bot-call-outcomes/route.ts");
  const response = await route.POST(request());
  assert.notEqual(response.status, 201,
    `nor may the handler record it: ${response.status} ${(await response.clone().text()).slice(0, 250)}`);
});

// =====================================================================================================
// PTJA-W2B-C10 — unauthenticated meet & greet has no volume control
//
// The anonymous branch mints a brand-new synthetic customer id per call
// (`MGENQ-${crypto.randomUUID()...}`), and createMeetGreetRequest's only volume control is keyed to
// that identity - one open request per (customer, host) - so a fresh id per call meant the cap could
// never fire.
//
// MEASURED: ten identical anonymous POSTs from one IP against a named host, all ten 201, and the staff
// directory then showed ten requests queued against that host. Any live boarding host or pet-sitting
// provider is individually targetable by id.
//
// Gated with the per-origin abuse gate app/api/public-contact/route.ts already carries - the one an
// audit probe independently confirmed is exact at its limit and fails closed with no IP - on its own
// table so the two public endpoints do not consume each other's budget.
// =====================================================================================================

test("W2B-C10: anonymous meet & greet requests from one origin are bounded", async () => {
  const { sqlite, db, now } = await baseWorld();
  const mg = await import("../lib/meet-and-greet.ts");
  await mg.ensureMeetGreetTables?.(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,name TEXT,city_id TEXT,services_json TEXT,zones_json TEXT,status TEXT,live INTEGER DEFAULT 1,capacity INTEGER DEFAULT 5,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,name,city_id,services_json,zones_json,status,live,updated_at) VALUES ('PRV-HOST-1','Host One','blr','[\"pet_sitting\"]','[\"blr-east\"]','active',1,?)").run(now);

  const route = await import("../app/api/meet-and-greet/route.ts");
  const attempt = (index) => route.POST(new Request("https://uat.pawspace.in/api/meet-and-greet", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify({ format: "phone", hostProviderId: "PRV-HOST-1", preferredAt: now + 7 * 86400000 + index * 60000, notes: `probe ${index}` }),
  }));

  const statuses = [];
  for (let index = 0; index < 10; index += 1) statuses.push((await attempt(index)).status);
  assert.ok(statuses.includes(429),
    `ten anonymous requests from one origin must not all be accepted: ${JSON.stringify(statuses)}`);
});

test("W2B-C10: a caller with no determinable origin is refused, and the first few still work", async () => {
  // Non-vacuity in both directions: the endpoint must still serve genuine anonymous enquiries, and an
  // unattributable caller is exactly who a volume control exists for.
  const { sqlite, db, now } = await baseWorld();
  const mg = await import("../lib/meet-and-greet.ts");
  await mg.ensureMeetGreetTables?.(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,name TEXT,city_id TEXT,services_json TEXT,zones_json TEXT,status TEXT,live INTEGER DEFAULT 1,capacity INTEGER DEFAULT 5,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,name,city_id,services_json,zones_json,status,live,updated_at) VALUES ('PRV-HOST-1','Host One','blr','[\"pet_sitting\"]','[\"blr-east\"]','active',1,?)").run(now);
  const route = await import("../app/api/meet-and-greet/route.ts");

  const first = await route.POST(new Request("https://uat.pawspace.in/api/meet-and-greet", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
    body: JSON.stringify({ format: "phone", hostProviderId: "PRV-HOST-1", preferredAt: now + 7 * 86400000, notes: "a genuine enquiry" }),
  }));
  assert.notEqual(first.status, 429, `a genuine first enquiry is not rate limited: ${(await first.clone().text()).slice(0, 200)}`);

  const noOrigin = await route.POST(new Request("https://uat.pawspace.in/api/meet-and-greet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "phone", hostProviderId: "PRV-HOST-1", preferredAt: now + 7 * 86400000, notes: "no origin" }),
  }));
  assert.equal(noOrigin.status, 429, "a caller with no determinable origin is refused, not waved through");
});

// =====================================================================================================
// PTJA-W2B-M07 — the WhatsApp webhook trusts a caller-supplied customerId over the contradicting phone
//
// resolveWhatsAppUatCustomer short-circuits on the claimed id:
//   if(input.customerId) return {customerId: await canonicalCustomer(db, ...), identitySource:"canonical_customer_id"}
// canonicalCustomer only checks the id EXISTS. input.providerIdentity - the phone the message actually
// came from - is never compared with it and is then dropped. The STRICT path is the very next three
// lines: resolve by phone, require exactly one canonical match, otherwise open a
// whatsapp_uat_identity_reviews row and refuse 409.
//
// MEASURED: a correctly signed inbound event carrying customerId CUST-VICTIM-A and phone
// +919800000999 - which is a DIFFERENT customer's primary phone - returned 201 with
// identitySource:"canonical_customer_id", filed the message on the victim's canonical thread, opened
// that customer's 24-hour outbound session window, and escalated "Please confirm the refund to my new
// account" to a human as a refund dispute on the victim's thread.
//
// The phone is the one datum the sender demonstrably controls at the transport level. When both are
// present they must AGREE; a contradiction goes to the same governed review the strict path already
// uses, rather than the claim silently winning.
// =====================================================================================================

test("W2B-M07: a claimed customerId that contradicts the sending phone is refused", async () => {
  const { sqlite, db, now } = await baseWorld();
  const adapter = await import("../lib/whatsapp-uat-adapter.ts");
  await adapter.ensureWhatsAppUatTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('CUST-VICTIM-A','blr','Victim','+919800000001',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('CUST-ATTACKER-Z','blr','Attacker','+919800000999',?,?)").run(now, now);

  const attempt = await adapter.resolveWhatsAppUatCustomer(db, {
    provider: "sandbox_simulator", customerId: "CUST-VICTIM-A", providerIdentity: "+919800000999",
  }).then((value) => ({ ok: true, value }), async (error) => ({
    ok: false, status: error instanceof Response ? error.status : 0,
    message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error),
  }));
  assert.equal(attempt.ok, false,
    `a claimed id contradicted by the sending phone must not resolve: ${JSON.stringify(attempt)}`);
});

test("W2B-M07: an agreeing claim, and a phone-only message, both still resolve", async () => {
  // Non-vacuity in both directions: the claim path must keep working when it agrees with the phone, and
  // the strict phone-only path must be untouched.
  const { sqlite, db, now } = await baseWorld();
  const adapter = await import("../lib/whatsapp-uat-adapter.ts");
  await adapter.ensureWhatsAppUatTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('CUST-VICTIM-A','blr','Victim','+919800000001',?,?)").run(now, now);

  const agreeing = await adapter.resolveWhatsAppUatCustomer(db, {
    provider: "sandbox_simulator", customerId: "CUST-VICTIM-A", providerIdentity: "+919800000001",
  });
  assert.equal(String(agreeing.customerId), "CUST-VICTIM-A", "an agreeing claim still resolves");

  const phoneOnly = await adapter.resolveWhatsAppUatCustomer(db, {
    provider: "sandbox_simulator", providerIdentity: "+919800000001",
  });
  assert.equal(String(phoneOnly.customerId), "CUST-VICTIM-A", "and so does a phone-only message");
  assert.equal(String(phoneOnly.identitySource), "verified_phone_match", "through the strict path, unchanged");
});
