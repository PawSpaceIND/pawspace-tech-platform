/**
 * STAFF-01. POST /api/assisted-orders sent each pet's SOURCE id ('account-huadq1', or a CRM lead's pet name) to
 * /api/uat-scheduling as petIds. The scheduler holds capacity only for saved canonical_pets ids owned by the
 * customer, so every assisted order - an existing customer's or a CRM lead's - was refused 403 "Pet ownership
 * denied", and the page showed that refusal in the green info box used for guidance, not as an alert.
 *
 * These run the real assisted-orders, scheduling and canonical-booking routes against one in-memory D1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupJourney } from "./helpers/grooming-journey-harness.mjs";

const assisted = await import("../app/api/assisted-orders/route.ts");
const scheduling = await import("../app/api/uat-scheduling/route.ts");
const canonicalBookings = await import("../app/api/canonical-bookings/route.ts");
const account = await import("../lib/customer-account.ts");
const leads = await import("../lib/lead-conversion-attribution.ts");
const lifecycle = await import("../lib/lead-lifecycle-governance.ts");

const FOUNDER = { "oai-authenticated-user-email": "closure-admin@pawspace.test", "oai-authenticated-user-full-name": "Grooming%20closure%20operator", "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8" };
const ASSOCIATE = { "oai-authenticated-user-email": "assisted-associate@pawspace.test" };
const CUSTOMER_A = "UAT-AUDIT-CUSTOMER-A", BRUNO = "PET-UATAUDITCUSTOMERA-ACCOUNTHUADQ1", REX = "PET-UATAUDITCUSTOMERB-ACCOUNTB1", LEAD = "CU-25300";
const crmDdl = readFileSync(new URL("../app/api/crm/route.ts", import.meta.url), "utf8").match(/CREATE TABLE IF NOT EXISTS crm_contacts [^"]+/)[0];

// 10:00-12:00 IST, days ahead so every order has its own free window.
const slot = (days) => { const day = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10); return { scheduledStart: `${day}T04:30:00.000Z`, scheduledEnd: `${day}T06:30:00.000Z` }; };
const rows = (sqlite, sql, ...args) => { try { return sqlite.prepare(sql).all(...args); } catch (error) { if (/no such table/.test(String(error.message))) return []; throw error; } };

async function world(t) {
  const w = await setupJourney(); t.after(() => w.close());
  // internalPost reaches the scheduler and the booking ledger over fetch; hand those calls to the real handlers.
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const handlers = { "/api/uat-scheduling": scheduling.POST, "/api/canonical-bookings": canonicalBookings.POST };
  globalThis.fetch = async (url, init) => { const target = new URL(String(url)); const handler = handlers[target.pathname]; if (!handler) throw new Error(`unexpected fetch ${target}`); return handler(new Request(target, init)); };
  const { sqlite, db } = w, now = Date.now();
  await account.ensureCustomerAccountTables(db);
  for (const [id, name, phone, email] of [[CUSTOMER_A, "UAT Audit Customer A", "+919876500841", "customer.a@pawspace.test"], ["UAT-AUDIT-CUSTOMER-B", "UAT Audit Customer B", "+919876500842", "customer.b@pawspace.test"]])
    sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,'blr',?,?,?,'customer_app_otp','{}',?,?)").run(id, name, phone, email, now, now);
  // Saved exactly as the customer app's pet manager saves them: id PET-<customer>-<source>, source 'account-...'.
  await account.mutateCustomerAccount(db, { customerId: CUSTOMER_A, action: "upsert_pet", idempotencyKey: "seed-bruno", pet: { sourceId: "account-huadq1", name: "Bruno", species: "dog", vaccinationStatus: "verified" } });
  await account.mutateCustomerAccount(db, { customerId: "UAT-AUDIT-CUSTOMER-B", action: "upsert_pet", idempotencyKey: "seed-rex", pet: { sourceId: "account-b1", name: "Rex", species: "dog", vaccinationStatus: "verified" } });
  // A lead captured in /crm: a CRM contact plus an open lead work item, and nothing canonical yet.
  sqlite.exec(crmDdl);
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,area,pet_names,pet_summary,stage,owner,source,created_at,updated_at) VALUES (?,'Staff UAT Lead 97928','9876597928','Bangalore','Tiger','Profile incomplete','New lead','Unassigned','Manual CRM',?,?)").run(LEAD, now, now);
  await leads.ensureLeadWorkItemsTable(db);
  const lead = await lifecycle.ensureInboundLead(db, { customerId: LEAD, source: "Manual CRM", service: "Grooming", owner: "Unassigned" });
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-ASSISTED-ASSOCIATE','assisted-associate@pawspace.test','Assisted associate','associate','active',?,?)").run(now, now);
  return { ...w, leadId: lead.leadId };
}

async function order(body, headers = FOUNDER) {
  const response = await assisted.POST(new Request("https://uat.pawspace.in/api/assisted-orders", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
}
// The payload the page builds. Customer 360 serves it masked contact details, so those are what it submits.
const payload = (key, customer, pets, days, extra = {}) => ({ idempotencyKey: key, customer, pets, cityId: "blr", zoneId: "blr-east", packageCode: "dog-bath", ...slot(days), consent: { captured: true, method: "recorded_call", reference: `CALL-${key}` }, ...extra });
const customerA = { id: CUSTOMER_A, name: "UAT Audit Customer A", primaryPhone: "+91 ••••••0841", email: "•••@pawspace.test" };

test("STAFF-01 an existing customer's selected pet resolves to its canonical id and the assisted order is created", async (t) => {
  const { sqlite } = await world(t);
  const created = await order(payload("uat-custA-bruno", customerA, [{ sourceId: "account-huadq1", canonicalId: BRUNO, name: "Bruno", species: "dog", vaccinationStatus: "verified" }], 8));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const booking = sqlite.prepare("SELECT customer_id,pet_ids_json,channel,schedule_group_id FROM canonical_bookings WHERE id=?").get(created.body.data.bookingId);
  assert.deepEqual(JSON.parse(booking.pet_ids_json), [BRUNO], "the booking binds the saved pet, not a fresh row");
  assert.equal(booking.channel, "assisted_staff");
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT pet_ids_json FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(booking.schedule_group_id).pet_ids_json), [BRUNO], "capacity is held for the canonical pet");
  assert.equal(rows(sqlite, "SELECT id FROM assisted_orders").length, 1);

  // A pet sent by its source id alone resolves server-side to the same saved row.
  const bySource = await order(payload("uat-custA-bruno-source", customerA, [{ sourceId: "account-huadq1", name: "Bruno", species: "dog" }], 9));
  assert.equal(bySource.status, 201, JSON.stringify(bySource.body));
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT pet_ids_json FROM canonical_bookings WHERE id=?").get(bySource.body.data.bookingId).pet_ids_json), [BRUNO]);
  assert.deepEqual(rows(sqlite, "SELECT id FROM canonical_pets WHERE customer_id=?", CUSTOMER_A).map((row) => row.id), [BRUNO], "no duplicate pet is minted");
  const stored = sqlite.prepare("SELECT primary_phone,email FROM canonical_customers WHERE id=?").get(CUSTOMER_A);
  assert.deepEqual({ ...stored }, { primary_phone: "+919876500841", email: "customer.a@pawspace.test" }, "the masked contact details the page holds never overwrite the stored ones");
});

test("STAFF-01 a pet that belongs to another customer is still refused 403 before anything is held or written", async (t) => {
  const { sqlite } = await world(t);
  const refused = await order(payload("uat-custA-foreign", customerA, [{ sourceId: "account-b1", canonicalId: REX, name: "Rex", species: "dog", vaccinationStatus: "verified" }], 8));
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Pet ownership denied");
  for (const table of ["scheduling_reservations", "scheduling_assignment_decisions", "canonical_bookings", "assisted_orders"]) assert.equal(rows(sqlite, `SELECT * FROM ${table}`).length, 0, table);
  assert.equal(sqlite.prepare("SELECT customer_id FROM canonical_pets WHERE id=?").get(REX).customer_id, "UAT-AUDIT-CUSTOMER-B", "the other customer's pet is untouched");
  assert.deepEqual(rows(sqlite, "SELECT id FROM canonical_pets WHERE customer_id=?", CUSTOMER_A).map((row) => row.id), [BRUNO], "no pet is minted for the requesting customer");
});

test("STAFF-01 a CRM lead becomes a canonical customer with its staff-confirmed pet, and the booking is attributed to the lead", async (t) => {
  const { sqlite, leadId } = await world(t);
  const lead = { id: LEAD, name: "Staff UAT Lead 97928", primaryPhone: "+91 ••••••7928" };
  // An associate may book but may not create customer records, so the conversion is refused before any write.
  const associate = await order(payload("uat-lead-associate", lead, [{ sourceId: "Tiger", name: "Tiger", species: "dog" }], 8), ASSOCIATE);
  assert.equal(associate.status, 403, JSON.stringify(associate.body));
  assert.equal(associate.body.error, "Customer ownership denied", "a governed refusal reaches the screen as its message, not as nested JSON");
  assert.equal(rows(sqlite, "SELECT id FROM canonical_customers WHERE id=?", LEAD).length, 0);
  assert.equal(rows(sqlite, "SELECT id FROM canonical_pets WHERE customer_id=?", LEAD).length, 0);

  const created = await order(payload("uat-lead-tiger", lead, [{ sourceId: "Tiger", name: "Tiger", species: "dog" }], 8, { serviceAddress: "12 Test Street, Indiranagar", servicePincode: "560038" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const customer = sqlite.prepare("SELECT name,primary_phone FROM canonical_customers WHERE id=?").get(LEAD);
  assert.deepEqual({ ...customer }, { name: "Staff UAT Lead 97928", primary_phone: "9876597928" }, "the canonical customer keeps the CRM id and the CRM's real phone");
  const pets = rows(sqlite, "SELECT id,source_pet_id,name,species FROM canonical_pets WHERE customer_id=?", LEAD);
  assert.equal(pets.length, 1); assert.equal(pets[0].source_pet_id, "Tiger"); assert.equal(pets[0].species, "dog");
  const booking = sqlite.prepare("SELECT customer_id,pet_ids_json,channel,schedule_group_id FROM canonical_bookings WHERE id=?").get(created.body.data.bookingId);
  assert.equal(booking.customer_id, LEAD); assert.deepEqual(JSON.parse(booking.pet_ids_json), [pets[0].id]); assert.equal(booking.channel, "assisted_staff");
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT pet_ids_json FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(booking.schedule_group_id).pet_ids_json), [pets[0].id]);
  assert.ok(rows(sqlite, "SELECT id FROM customer_addresses WHERE customer_id=? AND postal_code='560038'", LEAD).length, "the service address staff entered is saved through the governed address check");
  const work = sqlite.prepare("SELECT initiated_booking_id,lifecycle_state,converted_booking_id FROM lead_work_items WHERE id=?").get(leadId);
  assert.equal(work.initiated_booking_id, created.body.data.bookingId); assert.equal(work.lifecycle_state, "qualified", "pay-after-service: the lead converts when the payment is captured");
  assert.equal(sqlite.prepare("SELECT primary_phone FROM crm_contacts WHERE id=?").get(LEAD).primary_phone, "9876597928", "the CRM projection keeps the real phone");

  // Staff return later: the lead's pet is now saved, so the next order reuses it.
  const again = await order(payload("uat-lead-tiger-2", lead, [{ sourceId: "Tiger", name: "Tiger", species: "dog" }], 9));
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(rows(sqlite, "SELECT id FROM canonical_pets WHERE customer_id=?", LEAD).length, 1);
});

test("STAFF-01 the canonical booking is confirmed in the city and zone the scheduler reserved, not the page's default zone", async (t) => {
  const { sqlite } = await world(t);
  const now = Date.now();
  sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,area,city,postal_code,is_default,created_at,updated_at) VALUES ('ADDR-A-CHENNAI',?,'Home','14 Rajaji Salai','George Town','Chennai','600001',1,?,?)").run(CUSTOMER_A, now, now);
  const created = await order(payload("uat-custA-chennai", customerA, [{ sourceId: "account-huadq1", canonicalId: BRUNO, name: "Bruno", species: "dog" }], 8));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const booking = sqlite.prepare("SELECT city_id,zone_id FROM canonical_bookings WHERE id=?").get(created.body.data.bookingId);
  assert.deepEqual({ ...booking }, { city_id: "maa", zone_id: "chennai-core" });
});

test("STAFF-01 the assisted booking screen shows a failed order as an alert with the server's message", async (t) => {
  const page = readFileSync(new URL("../app/assisted-booking/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\{error&&<div role="alert"[^>]*>\{error\}<\/div>\}/, "the order error renders in an alert");
  assert.doesNotMatch(page, /className=\{styles\.security\}>\{error\}/, "not in the green guidance box");
  const staffCss = readFileSync(new URL("../app/components/staff-workspace/staff-module.module.css", import.meta.url), "utf8");
  assert.match(staffCss, /\.module :where\(\[role="alert"\]\) \{[^}]*background:var\(--staff-danger-bg\);[^}]*color:var\(--staff-danger\)/, "staff pages draw an alert in the danger colours");
  // The text in that alert is the server's refusal, verbatim.
  const client = await import("../lib/assisted-orders-client.ts");
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ error: "Pet ownership denied" }, { status: 403 });
  await assert.rejects(client.createAssistedOrder(payload("uat-ui", customerA, [{ sourceId: "account-huadq1", name: "Bruno", species: "dog" }], 8)), /^Error: Pet ownership denied$/);
});
