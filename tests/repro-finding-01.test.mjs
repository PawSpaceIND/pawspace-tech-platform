import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ===========================================================================
// FINDING 1 (P1 SECURITY) — REPRODUCTION ONLY. Do not fix; produce evidence.
//
// service_provider and associate both hold `bookings.view` (lib/platform-security.ts:25 / :23).
// The gateway maps GET /api/booking-command-center -> bookings.view (lib/api-gateway.ts:118) and
// GET /api/canonical-bookings -> bookings.view (lib/api-gateway.ts:110). So a field service_provider
// (role description: "Sees assigned jobs only") is GRANTED both platform-wide reads at the gateway.
//
//   * booking-command-center GET returns up to 150 bookings JOINed to canonical_customers, exposing
//     customer primary_phone / email, payment method/mode/status/detail, plus operational events,
//     notifications, refunds (amount + gateway reference), CX tickets and admin actions.
//   * canonical-bookings GET reads platform-wide with NO provider-ownership filter and its handler
//     performs NO auth of its own (GET() takes no Request) — the gateway mapping is the only gate.
//
// This suite tests through the REAL gateway with REAL roles. It deliberately uses the non-localhost
// host https://uat.pawspace.in/... — a localhost host short-circuits authorizeApiRequest to a
// dev-preview superuser (lib/api-gateway.ts:143) and every check would pass for the wrong reason.
// app_users + role_definitions are seeded from defaultRoles so roles resolve exactly as in production.
// ===========================================================================
installWorkersHooks("__CC_DB__", "__CC_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

// ---------------------------------------------------------------------------
// Identifiable customer PII and booking secrets. The booking is owned by PRV-OTHER — a provider the
// service_provider actor has no relationship to — so any of these reaching it is a platform-wide leak.
// ---------------------------------------------------------------------------
const C = {
  customerId: "CUS-LEAK-1",
  customerName: "Ritu Malhotra",
  primaryPhone: "+919812345678",
  secondaryPhone: "+919812345699",
  email: "ritu.malhotra@leaktest.example",
  bookingId: "BK-LEAK-1",
  providerId: "PRV-OTHER",
  paymentMethod: "upi",
  paymentMode: "prepaid",
  paymentStatus: "captured",
  paymentDetailMarker: "rzp_pay_LEAKTEST_0001",
  refundReason: "Refund for the missed grooming slot",
  refundGatewayRef: "rzp_refund_LEAK_7777",
  notification: "Customer Ritu was told the groomer is 45 minutes late",
  ticketSubject: "Groomer no-show complaint from Ritu",
};
// Everything that must never reach a field service_provider through booking-command-center.
const CC_SECRETS = [
  C.primaryPhone, C.secondaryPhone, C.email, C.customerName,
  C.paymentMethod, C.paymentMode, C.paymentStatus, C.paymentDetailMarker,
  C.refundReason, C.refundGatewayRef, C.notification, C.ticketSubject,
];

async function seed() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CC_DB__ = db;
  // PAWSPACE_UAT_LOGIN unset on purpose: the staging sign-in path must not be what authenticates here.
  globalThis.__CC_ENV__ = { FOUNDER_EMAIL: "" };

  // Security tables + role catalogue (seed both, as the finding requires).
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,permissions_json TEXT NOT NULL,system_role INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");

  // Tables the two GET handlers read and that we seed rows into (exact route DDL; the handlers'
  // own CREATE TABLE IF NOT EXISTS then becomes a no-op).
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_experience_tickets (id TEXT PRIMARY KEY,customer_id TEXT,booking_id TEXT,lead_id TEXT,category TEXT NOT NULL,priority TEXT NOT NULL,subject TEXT NOT NULL,detail TEXT NOT NULL,owner TEXT NOT NULL,manager TEXT NOT NULL,sla_due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',escalation_level INTEGER NOT NULL DEFAULT 0,customer_status TEXT NOT NULL DEFAULT 'We received your request',resolution TEXT,root_cause TEXT,resolution_evidence TEXT,reopened_count INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,resolved_at INTEGER)");

  const { defaultRoles } = await import("../lib/platform-security.ts");
  const now = Date.now();
  for (const role of defaultRoles) {
    sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)")
      .run(role.code, role.name, role.description, JSON.stringify(role.permissions), 1, now);
  }
  // Real staff/field identities that resolve through resolveActor and the gateway header path.
  const users = [
    ["u-sp", "provider@pawspace.in", "Field Provider", "service_provider"],
    ["u-assoc", "associate@pawspace.in", "Associate", "associate"],
    ["u-mgr", "manager@pawspace.in", "Ops Manager", "manager"],
    ["u-founder", "founder@pawspace.in", "Founder", "founder"],
    ["u-fin", "finance@pawspace.in", "Finance", "finance"],
  ];
  for (const [id, email, name, role] of users) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, email, name, role, "active", now, now);
  }

  // The seeded booking, owned by PRV-OTHER, carrying identifiable PII across every read the command
  // center performs.
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(C.customerId, "CITY-BLR", C.customerName, C.primaryPhone, C.secondaryPhone, C.email, now, now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,total_amount,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(C.bookingId, "IDEMP-1", C.customerId, "[]", "[]", "CITY-BLR", "ZONE-1", "grooming", "GRM-BASIC", "Basic Groom", "SG-1", C.providerId, "2026-12-01T09:00:00.000Z", "2026-12-01T10:00:00.000Z", 1499.0, "system", now, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("WO-1", C.bookingId, "SG-1", C.providerId, "Provider Other", "commission", "grooming", "2026-12-01T09:00:00.000Z", "2026-12-01T10:00:00.000Z", now, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("PAY-1", C.bookingId, C.customerId, 1499.0, 1499.0, C.paymentMethod, C.paymentMode, C.paymentStatus, "PAY-IDEMP-1", JSON.stringify({ gateway_txn: C.paymentDetailMarker }), now, now);
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,gateway_reference,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("RF-1", C.bookingId, "PAY-1", 1499.0, C.refundReason, "requested", C.providerId, C.refundGatewayRef, now, now);
  sqlite.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("NT-1", C.bookingId, C.customerId, "whatsapp", "order_running_late", C.notification, "queued", "EV-1", now);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,category,priority,subject,detail,owner,manager,sla_due_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("CX-1", C.customerId, C.bookingId, "service", "high", C.ticketSubject, "Customer reported the groomer never arrived.", "cx.owner@pawspace.in", "manager@pawspace.in", now + 3600000, "system", now, now);

  return { sqlite, db };
}

const CC_URL = "https://uat.pawspace.in/api/booking-command-center";
const CB_URL = "https://uat.pawspace.in/api/canonical-bookings";
const asRole = (url, email) => new Request(url, { headers: { "oai-authenticated-user-email": email } });

const EMAIL = {
  service_provider: "provider@pawspace.in",
  associate: "associate@pawspace.in",
  manager: "manager@pawspace.in",
  founder: "founder@pawspace.in",
  finance: "finance@pawspace.in",
};

// ===========================================================================
// PART A — the gateway grant. This is the reproduction: authorizeApiRequest RESOLVES bookings.view and
// GRANTS a service_provider (and associate) forwarded identity for both platform-wide reads.
// ===========================================================================
async function gateway(url, email) {
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  return authorizeApiRequest(asRole(url, email), { DB: globalThis.__CC_DB__, FOUNDER_EMAIL: "" });
}

test("GATEWAY: service_provider is GRANTED GET /api/booking-command-center with bookings.view (mapping api-gateway.ts:118) — THE BUG", async () => {
  await seed();
  const resolved = await gateway(CC_URL, EMAIL.service_provider);
  assert.ok(!(resolved instanceof Response), `gateway refused (a Response) instead of granting — got ${resolved instanceof Response ? await resolved.clone().text() : ""}`);
  assert.equal(resolved.permission, "bookings.view", "GET must resolve to bookings.view");
  assert.equal(resolved.actor.roleCode, "service_provider", "the granted actor really is a service_provider");
  assert.ok(resolved.actor.permissions.includes("bookings.view"));
});

test("GATEWAY: service_provider is GRANTED GET /api/canonical-bookings with bookings.view (mapping api-gateway.ts:110) — THE BUG", async () => {
  await seed();
  const resolved = await gateway(CB_URL, EMAIL.service_provider);
  assert.ok(!(resolved instanceof Response), "gateway refused instead of granting the platform-wide read");
  assert.equal(resolved.permission, "bookings.view");
  assert.equal(resolved.actor.roleCode, "service_provider");
});

test("GATEWAY: associate is ALSO GRANTED both reads with bookings.view (finding names associate too)", async () => {
  await seed();
  for (const url of [CC_URL, CB_URL]) {
    const resolved = await gateway(url, EMAIL.associate);
    assert.ok(!(resolved instanceof Response), `associate refused for ${url}`);
    assert.equal(resolved.permission, "bookings.view");
    assert.equal(resolved.actor.roleCode, "associate");
  }
});

test("GATEWAY baseline: manager and founder are granted (legitimate cross-booking staff)", async () => {
  await seed();
  for (const role of ["manager", "founder"]) {
    for (const url of [CC_URL, CB_URL]) {
      const resolved = await gateway(url, EMAIL[role]);
      assert.ok(!(resolved instanceof Response), `${role} unexpectedly refused for ${url}`);
      assert.equal(resolved.permission, "bookings.view");
    }
  }
});

test("GATEWAY discriminates: finance (no bookings.view) is REFUSED 403 — proves the grant above is real, not fail-open", async () => {
  await seed();
  for (const url of [CC_URL, CB_URL]) {
    const resolved = await gateway(url, EMAIL.finance);
    assert.ok(resolved instanceof Response, `finance should be refused for ${url}`);
    assert.equal(resolved.status, 403);
  }
});

// ===========================================================================
// PART B — the permission catalogue that makes the grant happen.
// ===========================================================================
test("PERMISSIONS: service_provider and associate hold bookings.view; service_provider lacks the manage permissions (platform-security.ts:25/:23)", async () => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const sp = defaultRoles.find((r) => r.code === "service_provider");
  const assoc = defaultRoles.find((r) => r.code === "associate");
  assert.ok(sp.permissions.includes("bookings.view"), "service_provider holds bookings.view (platform-security.ts:25)");
  assert.ok(assoc.permissions.includes("bookings.view"), "associate holds bookings.view (platform-security.ts:23)");
  for (const priv of ["bookings.manage", "providers.manage", "grooming.manage"]) {
    assert.ok(!sp.permissions.includes(priv), `service_provider must NOT hold ${priv} — it is a field role, "sees assigned jobs only"`);
  }
});

// ===========================================================================
// PART C — the concrete data exposure. Run the REAL route handlers with the service_provider identity
// and assert the seeded customer PII leaks.
// ===========================================================================
const payload = (body) => JSON.stringify(body ?? {});

test("LEAK — booking-command-center: a service_provider receives the customer's exact phone + email + payment + refund/notification/ticket", async () => {
  await seed();
  const { GET } = await import("../app/api/booking-command-center/route.ts");
  const response = await GET(asRole(CC_URL, EMAIL.service_provider));
  const body = await response.json();
  const dump = payload(body);

  assert.equal(response.status, 200, `service_provider must be allowed by the route: ${dump.slice(0, 200)}`);
  assert.ok(Array.isArray(body.bookings) && body.bookings.length === 1, `expected the seeded booking back, got ${body.bookings?.length}`);

  // The load-bearing assertion: the exact customer PII strings appear in what a field provider received.
  const leaked = CC_SECRETS.filter((secret) => dump.includes(secret));
  assert.deepEqual(
    leaked.slice().sort(),
    CC_SECRETS.slice().sort(),
    `every seeded secret must appear in the service_provider's response. Present: ${leaked.join(" | ")}`
  );
  // Spell out the two that matter most, individually, so the evidence is unambiguous.
  assert.ok(dump.includes(C.primaryPhone), "customer primary phone leaked to service_provider");
  assert.ok(dump.includes(C.email), "customer email leaked to service_provider");

  const bk = body.bookings[0];
  assert.equal(bk.primary_phone, C.primaryPhone, "phone is a first-class field on the returned booking");
  assert.equal(bk.customer_email, C.email, "email is a first-class field on the returned booking");
  assert.equal(bk.payment_method, C.paymentMethod);
  assert.equal(bk.payment_status, C.paymentStatus);
  assert.equal(bk.refunds[0].gateway_reference, C.refundGatewayRef, "refund gateway reference exposed");
  assert.equal(bk.notifications[0].message, C.notification, "customer notification body exposed");
  assert.equal(bk.tickets[0].subject, C.ticketSubject, "CX ticket exposed");
});

test("LEAK — canonical-bookings: the handler does NO auth of its own; the gateway grant hands a service_provider a platform-wide booking it does not own", async () => {
  await seed();
  // 1) The gateway is the only gate, and it grants the service_provider (proven again here concretely).
  const resolved = await gateway(CB_URL, EMAIL.service_provider);
  assert.ok(!(resolved instanceof Response) && resolved.permission === "bookings.view", "service_provider granted at the gateway");

  // 2) The handler ignores identity entirely (GET() takes no Request) and returns platform-wide data
  //    with no provider-ownership filter. The seeded booking is owned by PRV-OTHER.
  const { GET } = await import("../app/api/canonical-bookings/route.ts");
  const response = await GET();
  const body = await response.json();
  const dump = payload(body);

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.bookings) && body.bookings.length === 1, "platform-wide read returns the booking regardless of ownership");
  const bk = body.bookings[0];
  assert.equal(bk.customer_name, C.customerName, "identifiable customer name exposed platform-wide");
  assert.equal(bk.provider_id, C.providerId, "the booking belongs to PRV-OTHER — no ownership filter was applied");
  assert.equal(bk.payment_status, C.paymentStatus);
  assert.equal(bk.gateway, "uat_sandbox");
  assert.ok(dump.includes(C.customerName), "customer name present in the platform-wide response");
  // Honest scope note: this projection selects c.name (not phone/email). The disclosure here is the
  // identifiable customer name + booking/payment detail read platform-wide with no ownership filter,
  // granted to a field service_provider by the gateway mapping at api-gateway.ts:110.
});
