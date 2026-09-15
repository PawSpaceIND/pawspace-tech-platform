/*
 * Two P0 privacy leaks on staff read surfaces, closed with the convention the platform already has.
 *
 * LEAK 1 — app/api/revenue-crm. Its three list queries LEFT JOIN crm_contacts for a customer name, and
 * the lead query also selected c.primary_phone. Neither was ever masked: the file contained no
 * maskName, no maskPhone and no customerDataAccessResolver at all. MEASURED, same customer, same
 * second:
 *
 *   GET /api/revenue-crm -> leads[{"customer_name":"Auditcheck Leaknamex","primary_phone":"9812345678"}]
 *   GET /api/crm         -> contacts[{"name":"A••••• L•","primary_phone":"+91 ••••••5678","revealed":false}]
 *
 * to the SAME actor, founder and admin included. The phone was worse than unmasked: nothing on
 * app/crm/revenue-engine-panel.tsx renders it, so it was raw PII shipped to a browser for nothing.
 *
 * WHY A ROUND OF REVIEW MISSED IT, AND WHAT THAT DEMANDS OF THIS SUITE. The seeded lead_work_items rows
 * carry customer_id values with no crm_contacts row, so the LEFT JOIN yields NULL and a seeded probe
 * sees nothing leak. The exposure exists only for leads created THROUGH THE PRODUCT - that is, every
 * real lead. A test that does not PROVE the join matched is therefore vacuous, and the tests below
 * assert the joined columns arrived before they assert anything about masking.
 *
 * LEAK 2 — app/api/customer-360. Its own header records that the code it replaced "masked the NAME and
 * the PHONE". The refactor onto lib/purpose-based-access kept the phone, the email and the address
 * precision and dropped the name, because CustomerDataView has no name field to carry one. It served
 * {"name":"Demo Karthik Leakiyer","primaryPhone":"+91 ••••••0006","revealed":false} - a masked number
 * sitting next to the raw person it belongs to - on /team/sales, /team/sales/cross-sell and
 * /assisted-booking.
 *
 * WHAT THE FIX IS NOT. It is not a blanket mask. A list read carries no reason and names no record, so
 * under the approved rule it cannot be a reveal; the reveal is app/api/customer-data-reveal - one
 * record, one stated reason, one customer_data_reveals row. PII-RC-05 below runs that path as an actor
 * holding customers.view_full_phone and asserts the real number still arrives, so "mask everything"
 * cannot pass this suite.
 *
 * Real handlers, real SQLite through the shared counting D1 shim (tests/helpers/d1-harness.mjs), real
 * authorization. Nothing here asserts on source text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__REVENUE_CRM_PII_DB__", "__REVENUE_CRM_PII_ENV__");

const { maskName, maskPhone } = await importLibModule("platform-security");

// Distinctive enough that a substring match cannot be a coincidence, and single words so that a
// partial leak - maskName keeps each word's first letter - still fails the assertion.
const LEAD_NAME = "Auditcheck Leaknamex";
const LEAD_PHONE = "9812345678";
const LEAD_PETS = "Bruno & Coco";
const C360_NAME = "Demo Karthik Leakiyer";
const C360_PHONE = "+919812340006";

/** Non-preview host: on localhost every actor is the preview superuser and nothing here is measurable. */
const REVENUE_URL = "https://uat.pawspace.in/api/revenue-crm";
const C360_URL = "https://uat.pawspace.in/api/customer-360";
const REVEAL_URL = "https://uat.pawspace.in/api/customer-data-reveal";

async function staffWorld(email, role) {
  const { sqlite, db } = freshCountingD1();
  enterWorkersDbScope(db);
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .bind(`USR-${role}`, email, `Staff ${role}`, role, now, now).run();
  return {
    sqlite, db, now,
    headers: {
      "oai-authenticated-user-email": email,
      "oai-authenticated-user-full-name": "Probe%20User",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
  };
}

/**
 * A lead that ACTUALLY JOINS to a contact - the case the seeded fixtures never produce.
 *
 * The revenue-crm GET is called once first purely so the route provisions its own schema; the rows are
 * then written with the real customer_id on both sides, which is what /api/crm's POST does when a rep
 * creates a lead.
 */
async function seedJoinedLead(world, route) {
  const warmup = await route.GET(new Request(REVENUE_URL, { headers: world.headers }));
  assert.equal(warmup.status, 200, `the route must provision its schema: ${(await warmup.text()).slice(0, 300)}`);
  const { sqlite, now } = world;
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("CU-LEAK-1", LEAD_NAME, LEAD_PHONE, null, null, "Indiranagar", LEAD_PETS, "Bruno · profile connected", "Follow-up", "Neha", "Website", 0, "Work lead today", "Grooming", now, now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,next_action_at,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,?,?,?,0,0,?,?)")
    .run("LEAD-LEAK-1", "CU-LEAK-1", "Website", "Grooming", "Neha", "Sales Manager", now, now + 600000, now + 1800000, 0, 0, now + 600000, now, now);
  // The join is real at the SQL level before the route is asked anything about it.
  const joined = sqlite.prepare("SELECT c.name FROM lead_work_items l JOIN crm_contacts c ON c.id=l.customer_id WHERE l.id=?").get("LEAD-LEAK-1");
  assert.equal(joined?.name, LEAD_NAME, "fixture error: the lead must join to the contact, or this suite proves nothing");
}

// =====================================================================================================
// LEAK 1 — /api/revenue-crm
// =====================================================================================================

test("PII-RC-01: /api/revenue-crm serves no raw customer name or phone to an actor without a reveal grant", async () => {
  const world = await staffWorld("associate@pawspace.test", "associate");
  const route = await import("../app/api/revenue-crm/route.ts");
  await seedJoinedLead(world, route);

  const response = await route.GET(new Request(REVENUE_URL, { headers: world.headers }));
  assert.equal(response.status, 200, "an associate may still open the revenue engine");
  const payload = await response.text();
  const body = JSON.parse(payload);
  const lead = body.leads.find((row) => row.id === "LEAD-LEAK-1");

  // NON-VACUITY FIRST. If the join did not match, customer_name is null and every assertion below
  // passes while the real exposure is untouched - which is exactly how round 1 read clean.
  assert.ok(lead, "the joined lead must be in the list");
  assert.equal(lead.pet_names, LEAD_PETS, "the LEFT JOIN really did bring crm_contacts columns back");
  assert.equal(lead.customer_name, maskName(LEAD_NAME), "the joined name is served masked, not raw");
  assert.equal(lead.revealed, false, "a list read is not a reveal");

  assert.ok(!payload.includes(LEAD_NAME), `the raw customer name must appear nowhere in the response: ${payload.slice(0, 400)}`);
  assert.ok(!payload.includes("Leaknamex"), "not even the surname on its own");
  assert.ok(!payload.includes("Auditcheck"), "nor the given name");
  assert.ok(!payload.includes(LEAD_PHONE), "and no raw phone number");
  assert.match(payload, /•/, "the name is masked, not deleted - staff must still recognise the record");
});

test("PII-RC-02: the lead query stops over-fetching primary_phone the screen never renders", async () => {
  const world = await staffWorld("associate2@pawspace.test", "associate");
  const route = await import("../app/api/revenue-crm/route.ts");
  await seedJoinedLead(world, route);

  const response = await route.GET(new Request(REVENUE_URL, { headers: world.headers }));
  const body = await response.json();
  const lead = body.leads.find((row) => row.id === "LEAD-LEAK-1");
  assert.equal(lead.pet_names, LEAD_PETS, "the join still matched - the column is dropped, not the join");
  assert.equal(Object.prototype.hasOwnProperty.call(lead, "primary_phone"), false,
    `nothing renders primary_phone, so it must not be selected or shipped at all: ${JSON.stringify(lead).slice(0, 300)}`);
});

test("PII-RC-03: opportunities and CX tickets mask the joined name too", async () => {
  const world = await staffWorld("associate3@pawspace.test", "associate");
  const route = await import("../app/api/revenue-crm/route.ts");
  await seedJoinedLead(world, route);
  const { sqlite, now } = world;
  const today = new Date(now).toISOString().slice(0, 10);
  sqlite.prepare("INSERT INTO revenue_opportunities (id,opportunity_date,customer_id,lead_id,booking_id,opportunity_type,reason,score,rank,expected_revenue,margin_percent,suggested_offer,preferred_channel,owner,status,due_at,signals_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,'{}',?,?)")
    .run("OPP-LEAK-1", today, "CU-LEAK-1", "LEAD-LEAK-1", null, "repeat_due", "Due for a repeat groom", 90, 1, 1800, 0, "Offer the monthly plan", "WATI", "Neha", now + 3600000, now, now);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,lead_id,category,priority,subject,detail,owner,manager,sla_due_at,status,escalation_level,customer_status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',0,?,?,?,?)")
    .run("TKT-LEAK-1", "CU-LEAK-1", null, "LEAD-LEAK-1", "Customer complaint", "high", "Groomer was late", "The groomer arrived forty minutes late", "CX Desk", "Sales Manager", now + 3600000, "We received your request", "system", now, now);

  const response = await route.GET(new Request(REVENUE_URL, { headers: world.headers }));
  const payload = await response.text();
  const body = JSON.parse(payload);
  const opportunity = body.opportunities.find((row) => row.id === "OPP-LEAK-1");
  const ticket = body.tickets.find((row) => row.id === "TKT-LEAK-1");

  assert.ok(opportunity, "the opportunity must be listed");
  assert.equal(opportunity.pet_names, LEAD_PETS, "the opportunity join matched");
  assert.equal(opportunity.customer_name, maskName(LEAD_NAME), "the opportunity name is masked");
  assert.ok(ticket, "the ticket must be listed");
  assert.equal(ticket.customer_name, maskName(LEAD_NAME), "the ticket name is masked");
  assert.ok(!payload.includes(LEAD_NAME), `no raw name anywhere in the payload: ${payload.slice(0, 400)}`);
  assert.ok(!payload.includes(LEAD_PHONE), "and no raw phone");
});

test("PII-RC-04: a founder gets the same masked list - seniority is not a reveal", async () => {
  // The measured report named the founder and the admin explicitly: both received the raw name while
  // the sibling /api/crm masked it for the very same actor. Wildcard permissions must not reopen it.
  const world = await staffWorld("founder@pawspace.test", "founder");
  const route = await import("../app/api/revenue-crm/route.ts");
  await seedJoinedLead(world, route);

  const response = await route.GET(new Request(REVENUE_URL, { headers: world.headers }));
  assert.equal(response.status, 200, "the founder must still be able to open the screen");
  const payload = await response.text();
  const lead = JSON.parse(payload).leads.find((row) => row.id === "LEAD-LEAK-1");
  assert.equal(lead.pet_names, LEAD_PETS, "the join matched for the founder too");
  assert.equal(lead.customer_name, maskName(LEAD_NAME), "a founder list read is still a list read");
  assert.equal(lead.revealed, false, "nothing was revealed, so nothing claims to have been");
  assert.ok(!payload.includes(LEAD_NAME), "no raw name for the founder either");
  assert.ok(!payload.includes(LEAD_PHONE), "nor a raw phone");
});

test("PII-RC-05: an actor holding customers.view_full_phone still reaches the real number, with a reason", async () => {
  // NON-VACUITY FOR THE FIX ITSELF. Masking everything everywhere would satisfy every assertion above
  // and break the job. The privileged path is app/api/customer-data-reveal - per record, with a stated
  // reason, writing a customer_data_reveals row - and it must still hand over real values.
  const world = await staffWorld("ops.admin@pawspace.test", "admin");
  const route = await import("../app/api/revenue-crm/route.ts");
  await seedJoinedLead(world, route);

  const list = await route.GET(new Request(REVENUE_URL, { headers: world.headers }));
  const listed = await list.text();
  assert.ok(!listed.includes(LEAD_NAME), "the admin's list read is masked like everyone else's");

  const reveal = await import("../app/api/customer-data-reveal/route.ts");
  const response = await reveal.POST(new Request(REVEAL_URL, {
    method: "POST", headers: { ...world.headers, "content-type": "application/json" },
    body: JSON.stringify({ customerId: "CU-LEAK-1", purpose: "sales", reason: "Returning her missed call about grooming" }),
  }));
  assert.equal(response.status, 200, `the reveal grant must still work: ${(await response.clone().text()).slice(0, 300)}`);
  const revealed = await response.json();
  assert.equal(revealed.data.revealed, true, "the reveal actually happened");
  assert.equal(revealed.data.contact.phone, LEAD_PHONE, "an admin who asks, with a reason, still sees the real number");
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) c FROM customer_data_reveals WHERE subject_id=?").get("CU-LEAK-1").c, 1,
    "and the reveal is recorded with the actor, the record and the reason");
});

// =====================================================================================================
// LEAK 2 — /api/customer-360
// =====================================================================================================

async function seedCustomer360Subject(world, route) {
  // buildCustomer360 reads crm_contacts; the revenue-crm route owns that table's DDL, so provision the
  // schema exactly as production does rather than hand-writing a fixture CREATE TABLE.
  const revenue = await import("../app/api/revenue-crm/route.ts");
  const warmup = await revenue.GET(new Request(REVENUE_URL, { headers: world.headers }));
  assert.equal(warmup.status, 200, "schema provisioning must succeed");
  void route;
  const { sqlite, now } = world;
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("UATD-CUS-6-CRM", C360_NAME, C360_PHONE, null, "karthik.leakiyer@example.com", "Koramangala", "Milo", "Milo · profile connected", "Active customer", "Neha", "Website", 0, "Win back", "Grooming", now, now);
}

test("PII-C360-01: /api/customer-360 masks the customer name, not only the phone", async () => {
  const world = await staffWorld("associate4@pawspace.test", "associate");
  const route = await import("../app/api/customer-360/route.ts");
  await seedCustomer360Subject(world, route);

  const response = await route.GET(new Request(`${C360_URL}?customerId=UATD-CUS-6-CRM`, { headers: world.headers }));
  assert.equal(response.status, 200, `an associate may still open Customer 360: ${(await response.clone().text()).slice(0, 300)}`);
  const payload = await response.text();
  const record = JSON.parse(payload).data.records[0];

  assert.ok(record, "the record must be built - an empty list would make this test vacuous");
  assert.equal(record.customerId, "UATD-CUS-6-CRM", "the right customer came back");
  assert.equal(record.name, maskName(C360_NAME), "the name is masked at the route");
  assert.equal(record.primaryPhone, maskPhone(C360_PHONE), "the phone stays masked - nothing was weakened");
  assert.equal(record.revealed, false, "a list read is not a reveal");

  assert.ok(!payload.includes(C360_NAME), `the raw name must appear nowhere: ${payload.slice(0, 400)}`);
  assert.ok(!payload.includes("Leakiyer"), "not even the surname on its own");
  assert.ok(!payload.includes("9812340006"), "and the raw phone stays out");
  assert.match(payload, /•/, "masked, not deleted");
});

test("PII-C360-02: a founder reading Customer 360 gets the masked name too", async () => {
  const world = await staffWorld("founder2@pawspace.test", "founder");
  const route = await import("../app/api/customer-360/route.ts");
  await seedCustomer360Subject(world, route);

  const response = await route.GET(new Request(`${C360_URL}?customerId=UATD-CUS-6-CRM`, { headers: world.headers }));
  assert.equal(response.status, 200, "the founder must still be able to open the screen");
  const payload = await response.text();
  const record = JSON.parse(payload).data.records[0];
  assert.ok(record, "the record must be built");
  assert.equal(record.name, maskName(C360_NAME), "wildcard permissions do not turn a list read into a reveal");
  assert.ok(!payload.includes(C360_NAME), "no raw name for the founder either");
});

test("PII-C360-03: the reveal path still returns the real Customer 360 contact for a grant holder", async () => {
  const world = await staffWorld("ops.admin2@pawspace.test", "admin");
  const route = await import("../app/api/customer-360/route.ts");
  await seedCustomer360Subject(world, route);

  const reveal = await import("../app/api/customer-data-reveal/route.ts");
  const response = await reveal.POST(new Request(REVEAL_URL, {
    method: "POST", headers: { ...world.headers, "content-type": "application/json" },
    body: JSON.stringify({ customerId: "UATD-CUS-6-CRM", purpose: "operations", reason: "Confirming the rescheduled visit window" }),
  }));
  assert.equal(response.status, 200, `the reveal grant must still work: ${(await response.clone().text()).slice(0, 300)}`);
  const revealed = await response.json();
  assert.equal(revealed.data.revealed, true, "the reveal actually happened");
  assert.equal(revealed.data.contact.phone, C360_PHONE, "the grant holder still reaches the real number");
});
