/*
 * R3-C / F2 (P0) — a lead created in the CRM could not be converted, nor could the page's own fixtures.
 * R3-C / F3 (P1) — a conversion that DID succeed never closed the lead.
 *
 * MEASURED, superuser preview off:
 *   A. /crm -> "Add lead" with a pet -> "Book this customer →" -> the screen asks the operator to
 *      "Confirm the missing pet species" -> "Create" -> 403 "Pet ownership denied".
 *   B. /assisted-booking with no customerId - its OWN fixture Meera Shah / Bruno - the same 403. All
 *      three UAT fixtures have no canonical_pets row, so the demo path was dead too.
 *   C. after a conversion that did work, lead_work_items still read status:"active" with
 *      converted_booking_id:null and crm_contacts.stage still "New lead", while the same customer
 *      already showed that booking's lifetime value and latest_booking_id.
 *
 * ROOT CAUSE, proved below: /api/uat-scheduling resolves ownership with
 *   SELECT customer_id,species FROM canonical_pets WHERE id=?            (app/api/uat-scheduling/route.ts:242)
 * and a CRM-only lead has no canonical_pets row at all, so the row the operator was asked to confirm
 * did not exist. /api/assisted-orders created pets only LATER, inside /api/canonical-bookings - after
 * the scheduler had already refused.
 *
 * The scheduler is represented here by a stub that runs THAT EXACT QUERY and returns THAT EXACT 403,
 * because the real handler additionally needs a provider roster, a service zone and a geocoded address
 * - none of which is what this defect is about. Every assertion about the fix is made against the real
 * database afterwards, so the stub can only refuse, never manufacture a pass.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__R3C_CONV_DB__", "__R3C_CONV_ENV__");

const ORIGIN = "https://uat.pawspace.in";
const STAFF = { "oai-authenticated-user-email": "ops.admin@pawspace.test" };

async function world() {
  const harness = freshCountingD1();
  const { sqlite, db } = harness;
  enterWorkersDbScope(db);
  globalThis.__R3C_CONV_DB__ = db;
  globalThis.__R3C_CONV_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-ADMIN',?,?,'admin','active',?,?)")
    .bind(STAFF["oai-authenticated-user-email"], "Ops Admin", now, now).run();
  const { seedDefaultGroomingTaxPolicy } = await import("../lib/grooming-invoice.ts");
  await seedDefaultGroomingTaxPolicy(db, "blr");
  return harness;
}

/**
 * The internal chain. /api/uat-scheduling enforces the REAL ownership rule; /api/canonical-bookings
 * writes the canonical_bookings row its real counterpart writes, because the lead closure reads that
 * row's service_code and total_amount back.
 */
function chain(sqlite, { bookingId = "BK-R3C-0001", serviceCode = "grooming", total = 1899 } = {}) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push({ url, body });
    if (url.includes("/api/uat-scheduling")) {
      // app/api/uat-scheduling/route.ts, verbatim.
      const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_pets'").get();
      if (!table) return Response.json({ error: "Save your pet before reserving a service." }, { status: 409 });
      for (const petId of body.petIds ?? []) {
        const pet = sqlite.prepare("SELECT customer_id,species FROM canonical_pets WHERE id=?").get(petId);
        if (!pet || String(pet.customer_id) !== body.customerId) return Response.json({ error: "Pet ownership denied" }, { status: 403 });
      }
      return Response.json({ data: { groupId: body.clientRequestId, provider: { id: "PRV-1", name: "UAT Groomer", model: "full_time" } } });
    }
    if (url.includes("/api/canonical-bookings")) {
      // created_by is bound to the CUSTOMER id by the real /api/canonical-bookings, for every caller.
      sqlite.prepare("INSERT OR IGNORE INTO canonical_bookings (id,customer_id,service_code,status,total_amount,currency,channel,provider_id,schedule_group_id,scheduled_start,created_by,created_at,updated_at) VALUES (?,?,?,'confirmed',?,'INR','customer_app',?,?,?,?,?,?)")
        .run(bookingId, body.customer.id, serviceCode, total, body.provider.id, body.scheduleGroupId, String(body.scheduledStart), body.customer.id, Date.now(), Date.now());
      sqlite.prepare("INSERT OR IGNORE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,'assigned','{}',?,?)")
        .run(`WO-${bookingId}`, bookingId, body.scheduleGroupId, body.provider.id, body.provider.name, body.provider.model, serviceCode, String(body.scheduledStart), String(body.scheduledEnd), Date.now(), Date.now());
      return Response.json({ data: { bookingId } });
    }
    throw new Error(`unexpected internal call: ${url}`);
  };
  return { sent, restore: () => { globalThis.fetch = original; }, to: (path) => sent.find((call) => call.url.includes(path)) };
}

const schema = (sqlite) => sqlite.exec(`
  CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT,primary_phone TEXT,secondary_phone TEXT,email TEXT,source TEXT,consent_json TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,status TEXT,total_amount REAL,currency TEXT,channel TEXT,provider_id TEXT,schedule_group_id TEXT,scheduled_start TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,schedule_group_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,occurrence_count INTEGER,status TEXT,assignment_json TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT,event_type TEXT,entity_type TEXT,entity_id TEXT,actor_id TEXT,detail_json TEXT,occurred_at INTEGER);
`);

const order = (overrides = {}) => new Request(`${ORIGIN}/api/assisted-orders`, {
  method: "POST", headers: { ...STAFF, "content-type": "application/json" },
  body: JSON.stringify({
    idempotencyKey: `r3c-${Math.random().toString(36).slice(2)}`,
    customer: { id: "UAT-CUST-ASSIST-001", name: "Meera Shah", primaryPhone: "+919800000101" },
    pets: [{ sourceId: "UAT-PET-BRUNO", name: "Bruno", species: "dog" }],
    cityId: "blr", zoneId: "blr-east", packageCode: "dog-basic",
    scheduledStart: "2026-10-01T04:30:00.000Z", scheduledEnd: "2026-10-01T06:30:00.000Z",
    consent: { captured: true, method: "recorded_call", reference: "UAT-CALL-REF-001" },
    ...overrides,
  }),
});

/** A lead created the way a rep really creates one: through the real POST /api/crm. */
async function crmLead(sqlite, { name = "Priya Nair", phone = "9845012345", pet = "Simba", service = "Grooming" } = {}) {
  const crm = await import("../app/api/crm/route.ts");
  const response = await crm.POST(new Request(`${ORIGIN}/api/crm`, {
    method: "POST", headers: { ...STAFF, "content-type": "application/json" },
    body: JSON.stringify({ name, primaryPhone: phone, petNames: pet, service, source: "Staff CRM" }),
  }));
  assert.equal(response.status, 201, `the CRM must create the lead: ${(await response.clone().text()).slice(0, 300)}`);
  const created = await response.json();
  // NON-VACUITY: the lead really has no canonical pet, which is the whole defect.
  const pets = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_pets'").get()
    ? sqlite.prepare("SELECT COUNT(*) c FROM canonical_pets WHERE customer_id=?").get(created.id).c : 0;
  assert.equal(pets, 0, "fixture error: a CRM lead must start with no canonical pet");
  return created;
}

test("CONV-01 (F2, repro A): a CRM lead with a confirmed pet converts - the pet becomes a real canonical pet first", async () => {
  const harness = await world();
  schema(harness.sqlite);
  const lead = await crmLead(harness.sqlite);
  const link = chain(harness.sqlite, { bookingId: "BK-R3C-CRM" });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const response = await route.POST(order({
      customer: { id: lead.id, name: "Priya Nair", primaryPhone: "9845012345" },
      // Exactly what /assisted-booking submits for a CRM-only lead: the NAME as the source id, plus the
      // species the operator confirmed on screen.
      pets: [{ sourceId: "Simba", name: "Simba", species: "dog" }],
    }));
    const body = await response.json();
    assert.equal(response.status, 201, `the conversion must succeed: ${JSON.stringify(body).slice(0, 400)}`);

    // The scheduler was actually reached and actually accepted - the stub above refuses on the real rule.
    const scheduling = link.to("/api/uat-scheduling");
    assert.ok(scheduling, "the scheduler was called");
    const petId = scheduling.body.petIds[0];
    const row = harness.sqlite.prepare("SELECT id,customer_id,name,species FROM canonical_pets WHERE id=?").get(petId);
    assert.ok(row, "the pet id sent to the scheduler resolves to a real canonical_pets row");
    assert.equal(row.customer_id, lead.id, "owned by the customer being booked - this is the check that answered 403");
    assert.equal(row.name, "Simba", "with the name the operator confirmed");
    assert.equal(row.species, "dog", "and the species the screen asked them for");
    assert.equal(harness.sqlite.prepare("SELECT COUNT(*) c FROM canonical_pets WHERE customer_id=?").get(lead.id).c, 1,
      "exactly one pet, not a duplicate per booking");
  } finally { link.restore(); }
});

test("CONV-02 (F2, repro B): the page's own fixture customer converts too", async () => {
  const harness = await world();
  schema(harness.sqlite);
  const link = chain(harness.sqlite, { bookingId: "BK-R3C-FIX" });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const response = await route.POST(order());
    const body = await response.json();
    assert.equal(response.status, 201, `the demo path must work: ${JSON.stringify(body).slice(0, 400)}`);
    const petId = link.to("/api/uat-scheduling").body.petIds[0];
    const row = harness.sqlite.prepare("SELECT customer_id,name FROM canonical_pets WHERE id=?").get(petId);
    assert.equal(row?.customer_id, "UAT-CUST-ASSIST-001");
    assert.equal(row?.name, "Bruno");
  } finally { link.restore(); }
});

test("CONV-03 (F2): a pet that really belongs to somebody else is refused, and the refusal says so", async () => {
  // NON-VACUITY FOR THE FIX: "create the pet if it is missing" must not become "book any pet id at all".
  const harness = await world();
  schema(harness.sqlite);
  harness.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  harness.sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("PET-SOMEONE-ELSE", "CU-OTHER", "Rocky", "dog", null, "verified", "rocky", 1, 1);
  const link = chain(harness.sqlite);
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const response = await route.POST(order({ pets: [{ sourceId: "rocky", canonicalId: "PET-SOMEONE-ELSE", name: "Rocky", species: "dog" }] }));
    const body = await response.json();
    assert.equal(response.status, 403, JSON.stringify(body).slice(0, 300));
    assert.match(body.error, /registered to a different customer/, "the refusal names the real reason");
    assert.match(body.error, /Rocky/, "and the pet it is talking about");
    assert.equal(link.to("/api/uat-scheduling"), undefined, "no provider was held for a refused order");
    assert.equal(harness.sqlite.prepare("SELECT customer_id c FROM canonical_pets WHERE id=?").get("PET-SOMEONE-ELSE").c, "CU-OTHER",
      "and the other customer's pet is untouched");
  } finally { link.restore(); }
});

test("CONV-04 (F3): converting a lead CLOSES it and records the booking against it", async () => {
  const harness = await world();
  schema(harness.sqlite);
  const lead = await crmLead(harness.sqlite, { name: "Ravi Menon", phone: "9845012399", pet: "Coco" });
  const link = chain(harness.sqlite, { bookingId: "BK-R3C-LEAD" });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const before = harness.sqlite.prepare("SELECT status,converted_booking_id FROM lead_work_items WHERE customer_id=?").get(lead.id);
    assert.equal(before.status, "active", "fixture: the lead starts open");
    assert.equal(before.converted_booking_id, null);

    const response = await route.POST(order({
      customer: { id: lead.id, name: "Ravi Menon", primaryPhone: "9845012399" },
      pets: [{ sourceId: "Coco", name: "Coco", species: "dog" }],
    }));
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body).slice(0, 400));

    const after = harness.sqlite.prepare("SELECT status,lifecycle_state,converted_booking_id FROM lead_work_items WHERE customer_id=?").get(lead.id);
    assert.equal(after.converted_booking_id, "BK-R3C-LEAD", "the booking is recorded against the lead");
    assert.equal(after.status, "converted", "the lead card can no longer render ACTIVE");
    assert.equal(after.lifecycle_state, "converted");
    const contact = harness.sqlite.prepare("SELECT stage FROM crm_contacts WHERE id=?").get(lead.id);
    assert.notEqual(contact.stage, "New lead", "and the CRM board stops showing a new lead");
    assert.equal(contact.stage, "Active customer");
    assert.equal(body.data.lead.converted, true, "the operator's screen is told the lead closed");
    assert.equal(body.data.lead.leadId, after_leadId(harness, lead.id));

    const attribution = harness.sqlite.prepare("SELECT attribution_type,lead_id FROM booking_attribution WHERE booking_id=?").get("BK-R3C-LEAD");
    assert.equal(attribution?.attribution_type, "lead", "the booking is attributed to the lead, not counted as a walk-in");
  } finally { link.restore(); }
});

function after_leadId(harness, customerId) {
  return harness.sqlite.prepare("SELECT id FROM lead_work_items WHERE customer_id=?").get(customerId).id;
}

test("CONV-05 (F3): a customer with no open lead still books, and says so rather than failing", async () => {
  const harness = await world();
  schema(harness.sqlite);
  const link = chain(harness.sqlite, { bookingId: "BK-R3C-NOLEAD" });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const response = await route.POST(order());
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body).slice(0, 300));
    assert.equal(body.data.lead.converted, false);
    assert.equal(body.data.lead.reason, "no_open_lead_for_this_customer");
  } finally { link.restore(); }
});

test("CONV-06 (F6): a replayed order describes the order it is replaying", async () => {
  const harness = await world();
  schema(harness.sqlite);
  const link = chain(harness.sqlite, { bookingId: "BK-R3C-DUP", total: 1899 });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const request = order();
    const first = await route.POST(request.clone());
    assert.equal(first.status, 201, (await first.clone().text()).slice(0, 300));
    const replay = await route.POST(request);
    const body = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(body.data.duplicatePrevented, true);
    assert.equal(body.data.bookingId, "BK-R3C-DUP");
    // The two fields the screen rendered unconditionally, and crashed on when they were absent.
    assert.equal(body.data.provider?.name, "UAT Groomer", "the replay carries the provider that was assigned");
    assert.equal(body.data.totalAmount, 1899, "and the governed total of the existing booking");
    assert.equal(harness.sqlite.prepare("SELECT COUNT(*) c FROM assisted_orders").get().c, 1, "no second order was created");
  } finally { link.restore(); }
});

test("CONV-07 (F10): a staff-created booking records the STAFF member as its creator, not the customer", async () => {
  const harness = await world();
  schema(harness.sqlite);
  const link = chain(harness.sqlite, { bookingId: "BK-R3C-WHO" });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const response = await route.POST(order());
    assert.equal(response.status, 201, (await response.clone().text()).slice(0, 300));
    const row = harness.sqlite.prepare("SELECT channel,created_by FROM canonical_bookings WHERE id='BK-R3C-WHO'").get();
    assert.equal(row.channel, "assisted_staff", "the channel says a staff member created it");
    assert.equal(row.created_by, STAFF["oai-authenticated-user-email"],
      "and created_by agrees - it used to be the customer id, so the ledger said the customer booked themselves");
  } finally { link.restore(); }
});

test("CONV-08 (F10): a MASKED customer name never reaches the canonical booking either", async () => {
  // The phone was already resolved server-side for exactly this reason; the name travels in the same
  // object, is masked by the same policy, and canonical-bookings upserts name=excluded.name. MEASURED
  // on the live UAT database after a staff conversion: the customer's OWN /api/customer-account read
  // returned {"name":"R•• C• C•","primaryPhone":"9811100144"} - a destroyed name beside a real phone.
  const harness = await world();
  schema(harness.sqlite);
  const lead = await crmLead(harness.sqlite, { name: "Meenakshi Pillai", phone: "9845012345", pet: "Simba" });
  const link = chain(harness.sqlite, { bookingId: "BK-R3C-NAME" });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const response = await route.POST(order({
      // Exactly what /assisted-booking carries from /api/customer-360's masked list read.
      customer: { id: lead.id, name: "M•••••••• P•", primaryPhone: "+91 ••••••2345" },
      pets: [{ sourceId: "Simba", name: "Simba", species: "dog" }],
    }));
    assert.equal(response.status, 201, (await response.clone().text()).slice(0, 300));
    const sent = link.to("/api/canonical-bookings").body.customer;
    assert.equal(sent.name, "Meenakshi Pillai", "the real stored name is what the booking upsert receives");
    assert.equal(/[•*]/.test(sent.name), false, "a masked display value must never be written over a real name");
    assert.equal(sent.primaryPhone, "9845012345", "and the phone rule is unchanged");
  } finally { link.restore(); }
});

test("CONV-09 (F10): a name that is masked with nothing on file is refused, not stored", async () => {
  const harness = await world();
  schema(harness.sqlite);
  const link = chain(harness.sqlite);
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const response = await route.POST(order({ customer: { id: "CU-UNKNOWN-NAME", name: "A•••• B•", primaryPhone: "9845012345" } }));
    const body = await response.json();
    assert.equal(response.status, 422, JSON.stringify(body).slice(0, 300));
    assert.match(body.error, /masked display value, not a real name/);
    assert.equal(link.to("/api/uat-scheduling"), undefined, "nothing was scheduled");
  } finally { link.restore(); }
});
