/**
 * PawSpace Total Journey Audit, Wave 2 — cross-tenant read exposure.
 *
 * Four routes shared one root cause: a branch written as "staff can see everything" authorised on a
 * bare permission that the service_provider role ALSO holds. bookings.view and scheduling.view are both
 * default service_provider permissions, so every branch gated on them alone admitted any onboarded
 * provider to the whole platform's records.
 *
 * The existing route-authorization sweep structurally cannot see this class. It probes anonymous and
 * the LEAST-privileged role; a provider reading another provider's - or another customer's - row is a
 * valid role holding the required permission, so the sweep never presents a provider identity at all.
 * Every case here issues a REAL partner_otp platform session and drives the real route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_XT_DB__", "__PTJA_XT_ENV__");

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

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_XT_DB__ = db;
  globalThis.__PTJA_XT_ENV__ = env;
  return { sqlite, db };
}

async function providerCookie(db, providerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "partner_otp", principalType: "identity_subject", principalKey: `provider:${providerId}`,
    subjectType: "provider", subjectId: providerId, verificationState: "verified",
    actorId: "ptja-w2", reason: "PTJA cross-tenant read regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "partner_otp",
    principalType: "identity_subject", principalKey: String(binding.principal_key),
    subjectType: "provider", subjectId: providerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const STAFF = {
  "oai-authenticated-user-email": "ops.admin@pawspace.test",
  "oai-authenticated-user-full-name": "Ops%20admin",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};

async function get(modulePath, path, headers) {
  const route = await import(modulePath);
  const response = await route.GET(new Request(`https://uat.pawspace.in${path}`, { headers }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

async function securityWorld() {
  const { sqlite, db } = world();
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-XT-ADMIN','ops.admin@pawspace.test','Ops admin','admin','active',?,?)").bind(now, now).run();
  return { sqlite, db, now };
}

// =====================================================================================================
// PTJA-W2-XT-01 (ledger W2-17-F03) — any provider session reads every customer's funeral/memorial case
// PTJA-W2-XT-02 (ledger W2-17-F04) — and every customer's pet-relocation case
//
// MEASURED, both routes, same shape: the gateway ALLOWED on permission=bookings.view for
// role=service_provider, and the handler returned 200 with the whole table.
//   funeral-memorial: {"customer_id":"CUST-VICTIM-A","pet_name":"Bruno","pickup_address":"12 Victim
//     Lane, Indiranagar, Bengaluru 560038","alternate_contact":"+919800000001",...} - the home pickup
//     address and alternate contact phone of a bereavement case, to a party with no relationship to it.
//   relocation: origin and destination city/country plus target_travel_date - enough to know when a
//     named customer's home is empty.
//
// The branches are written for STAFF; bookings.view simply does not say "staff", because the
// service_provider role holds it too. customers.view does: founder, superuser, admin, manager and
// associate hold it; service_provider, customer, finance and auditor do not. Naming the capability the
// branch actually needs is not a new rule - it is the one the platform already defines for reading
// customer records.
// =====================================================================================================

const SENSITIVE_CASE_ROUTES = [
  {
    label: "funeral-memorial", module: "../app/api/funeral-memorial/route.ts", path: "/api/funeral-memorial",
    caseId: "FUN-A-1", secret: "12 Victim Lane, Indiranagar, Bengaluru 560038",
    tables: async (db) => (await import("../lib/funeral-memorial-governance.ts")).ensureFuneralMemorialTables(db),
    seed: (sqlite, now) => {
      sqlite.prepare("INSERT INTO funeral_cases (id,customer_id,pet_name,pet_species,pickup_address,alternate_contact,service_type,memorial_option,urgency,status,created_at,updated_at) VALUES ('FUN-A-1','CUST-VICTIM-A','Bruno','dog','12 Victim Lane, Indiranagar, Bengaluru 560038','+919800000001','cremation_private','urn','urgent','urgent_request',?,?)").run(now, now);
    },
  },
  {
    label: "relocation", module: "../app/api/relocation/route.ts", path: "/api/relocation",
    caseId: "RELO-A-1", secret: "Dubai",
    tables: async (db) => (await import("../lib/relocation-governance.ts")).ensureRelocationTables(db),
    seed: (sqlite, now) => {
      sqlite.prepare("INSERT INTO relocation_cases (id,customer_id,pet_name,breed,age_years,size_class,travel_mode,origin_country,origin_city,destination_country,destination_city,target_travel_date,crate_requirement,status,regulation_status,created_at,updated_at) VALUES ('RELO-A-1','CUST-VICTIM-A','Bruno','Golden Retriever',4,'large','air','IN','Bengaluru','AE','Dubai','2026-10-01','iata_500','lead','manual_verification_required',?,?)").run(now, now);
    },
  },
];

for (const route of SENSITIVE_CASE_ROUTES) {
  test(`W2-XT (${route.label}): a provider session cannot read another customer's case`, async () => {
    const { sqlite, db, now } = await securityWorld();
    await route.tables(db);
    route.seed(sqlite, now);
    const cookie = await providerCookie(db, "PRV-ATTACKER-B");

    const list = await get(route.module, route.path, { cookie });
    assert.notEqual(list.status, 200,
      `the unscoped list must not serve a provider session: ${JSON.stringify(list).slice(0, 400)}`);
    assert.doesNotMatch(JSON.stringify(list.body ?? {}), new RegExp(route.secret),
      "and must not leak the record either way");

    const single = await get(route.module, `${route.path}?caseId=${route.caseId}`, { cookie });
    assert.notEqual(single.status, 200,
      `nor may it be fetched by id: ${JSON.stringify(single).slice(0, 400)}`);
    assert.doesNotMatch(JSON.stringify(single.body ?? {}), new RegExp(route.secret),
      "and the record must not appear in the refusal");
  });

  test(`W2-XT (${route.label}): staff can still read the case`, async () => {
    // Non-vacuity. Closing the branch entirely would satisfy the case above and break the ops workflow
    // the branch exists for.
    const { sqlite, db, now } = await securityWorld();
    await route.tables(db);
    route.seed(sqlite, now);

    const list = await get(route.module, route.path, STAFF);
    assert.equal(list.status, 200, `staff must still see the list: ${JSON.stringify(list).slice(0, 300)}`);
    assert.match(JSON.stringify(list.body ?? {}), new RegExp(route.secret), "with the record in it");

    const single = await get(route.module, `${route.path}?caseId=${route.caseId}`, STAFF);
    assert.equal(single.status, 200, `and still fetch one by id: ${JSON.stringify(single).slice(0, 300)}`);
  });
}

// =====================================================================================================
// PTJA-W2-XT-03 (ledger W2-17-F02) — food-fulfilment refuses ?customerId and then serves the same row
// for ?orderId
//
// The staff branch runs requireCustomerOwnership only when the caller supplies customerId. Supplying
// orderId instead reaches listFoodOrders with no ownership predicate at all: the guard was attached to
// the request PARAMETER rather than to the record that comes back.
//
// MEASURED, same session, same handler, both allowed by the gateway on permission=bookings.view for
// role=service_provider:
//   GET ?customerId=CUST-VICTIM-A -> 403 {"error":"Customer ownership denied"}
//   GET ?orderId=FOOD-A-1         -> 200 with the identical row it had just refused, plus its lines,
//                                    reservation, fulfilment, payment and event trail.
//
// The sibling routes already do this correctly - walking-lifecycle, taxi-lifecycle and sitting-lifecycle
// all resolve the record first and then check ownership on it. This applies that same convention.
// =====================================================================================================

async function foodWorld() {
  const { sqlite, db, now } = await securityWorld();
  const food = await import("../lib/food-fulfilment-governance.ts");
  await food.ensureFoodFulfilmentTables(db);
  sqlite.prepare("INSERT INTO food_orders (id,idempotency_key,customer_id,city_id,zone_id,status,commercial_status,inventory_mode,delivery_status,total_amount,currency,created_by,created_at,updated_at) VALUES ('FOOD-A-1','idem-a-1','CUST-VICTIM-A','blr','blr-east','confirmed','uat_only','uat_seed','fulfilment_review_required',1497,'INR','CUST-VICTIM-A',?,?)").run(now, now);
  // listFoodOrders JOINs lines and the inventory reservation, so an order without them is invisible.
  sqlite.prepare("INSERT INTO food_order_lines (id,order_id,sku,item_name,item_version,quantity,unit_price,line_total,currency) VALUES ('FL-1','FOOD-A-1','food-uat-cat-adult-1kg','Adult Cat Food 1kg',1,3,499,1497,'INR')").run();
  sqlite.prepare("INSERT INTO food_inventory_reservations (id,order_id,sku,zone_id,quantity,status,inventory_mode,created_at,updated_at) VALUES ('FR-1','FOOD-A-1','food-uat-cat-adult-1kg','blr-east',3,'reserved','uat_seed',?,?)").run(now, now);
  return { sqlite, db };
}

test("W2-XT (food-fulfilment): ?orderId is guarded exactly as ?customerId is", async () => {
  const { db } = await foodWorld();
  const cookie = await providerCookie(db, "PRV-ATTACKER-B");

  const byCustomer = await get("../app/api/food-fulfilment/route.ts", "/api/food-fulfilment?customerId=CUST-VICTIM-A", { cookie });
  assert.equal(byCustomer.status, 403, `the customerId form is already refused: ${JSON.stringify(byCustomer).slice(0, 250)}`);

  const byOrder = await get("../app/api/food-fulfilment/route.ts", "/api/food-fulfilment?orderId=FOOD-A-1", { cookie });
  assert.notEqual(byOrder.status, 200,
    `and the orderId form must not serve the row it just refused: ${JSON.stringify(byOrder).slice(0, 400)}`);
  assert.doesNotMatch(JSON.stringify(byOrder.body ?? {}), /CUST-VICTIM-A/, "the record must not leak either way");
});

test("W2-XT (food-fulfilment): staff still read any order, and a customer still reads their own", async () => {
  // Non-vacuity in both directions.
  const { db } = await foodWorld();

  const staff = await get("../app/api/food-fulfilment/route.ts", "/api/food-fulfilment?orderId=FOOD-A-1", STAFF);
  assert.equal(staff.status, 200, `staff must still read any order: ${JSON.stringify(staff).slice(0, 300)}`);
  assert.match(JSON.stringify(staff.body ?? {}), /FOOD-A-1/, "with the order in it");

  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: "customer:CUST-VICTIM-A",
    subjectType: "customer", subjectId: "CUST-VICTIM-A", verificationState: "verified",
    actorId: "ptja-w2", reason: "PTJA cross-tenant read regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_otp", principalType: "identity_subject",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: "CUST-VICTIM-A",
  });
  const owner = await get("../app/api/food-fulfilment/route.ts", "/api/food-fulfilment?scope=customer&orderId=FOOD-A-1", {
    cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`,
  });
  assert.equal(owner.status, 200, `the order's own customer must still read it: ${JSON.stringify(owner).slice(0, 300)}`);
});

// =====================================================================================================
// PTJA-W2-XT-04 (ledger W2-17-F01) — a provider session reads every competitor's commercial standing
//
// GET /api/provider-capacity-control authorised on the bare permission `scheduling.view`, which every
// service_provider session holds, and then returned the whole city's provider roster with no ownership
// filter of any kind.
//
// MEASURED: the gateway ALLOWED {"roleCode":"service_provider","permission":"scheduling.view"} and the
// handler returned 200 with data.profiles = 20 rows - every capacity profile in the city, with rating,
// quality_score, capacity and live/status for each - plus data.performance carrying
// provider_performance_events whose detail_json holds free-text complaint notes and customer
// identifiers, data.recovery, and data.audit carrying the operator email and reason text for every
// stand-down.
//
// This is the capacity CONTROL console. Its PATCH already requires scheduling.manage; only the GET was
// lower, and nothing in app/** calls that GET - there is no provider-facing consumer to preserve. So the
// read is raised to the same permission the write already demands, at BOTH gates: the gateway mapping
// and the handler. Nothing is invented and no provider loses a surface they were using.
// =====================================================================================================

test("W2-XT (provider-capacity-control): a provider session cannot read the city roster", async () => {
  const { db } = await securityWorld();
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.seedProviderCapacityDefaults(db);
  const cookie = await providerCookie(db, "PRV-ATTACKER-B");

  // Gate one: the gateway must not map this read to a permission every provider holds.
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  // authorizeApiRequest signals denial by RETURNING a Response, not by throwing.
  const gateway = await authorizeApiRequest(
    new Request("https://uat.pawspace.in/api/provider-capacity-control?cityId=blr", { headers: { cookie } }),
    { DB: db },
  );
  assert.ok(gateway instanceof Response,
    `the gateway must refuse a provider session on this console, got an allow: ${JSON.stringify(gateway).slice(0, 300)}`);
  assert.equal(gateway.status, 403, "with a 403");

  // Gate two: and so must the handler, independently.
  const handler = await get("../app/api/provider-capacity-control/route.ts", "/api/provider-capacity-control?cityId=blr", { cookie });
  assert.notEqual(handler.status, 200,
    `nor may the handler serve it: ${JSON.stringify(handler).slice(0, 300)}`);
  assert.doesNotMatch(JSON.stringify(handler.body ?? {}), /quality_score|profiles/,
    "and no roster may appear in the refusal");
});

test("W2-XT (provider-capacity-control): the staff console still works", async () => {
  // Non-vacuity: this is an operations console and it must keep working for the people who run it.
  const { db } = await securityWorld();
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.seedProviderCapacityDefaults(db);

  const staff = await get("../app/api/provider-capacity-control/route.ts", "/api/provider-capacity-control?cityId=blr", STAFF);
  assert.equal(staff.status, 200, `staff must still load the console: ${JSON.stringify(staff).slice(0, 300)}`);
  assert.ok(Array.isArray(staff.body?.data?.profiles), "with the roster in it");
});
