/*
 * The Revenue & CX engine (/api/revenue-crm) as sales staff use it on real leads, executed against
 * node:sqlite with real actors (tests/helpers/execution-harness.mjs): public enquiries are routed to a rep,
 * the rep's logged attempts count against the lead's first-response clock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__REV_LEAD_WORK_DB__", "__REV_LEAD_WORK_ENV__");
const contact = await import("../app/api/public-contact/route.ts");
const engine = await import("../app/api/revenue-crm/route.ts");
const governance = await import("../lib/lead-assignment-governance.ts");
const sla = await import("../lib/lead-sla-governance.ts");

const REP = "rep.boarding@pawspace.test";
const MANAGER = "sales.manager@pawspace.test";
const DAY = 24 * 3600 * 1000;

async function salesWorld() {
  const w = world("__REV_LEAD_WORK_DB__", "__REV_LEAD_WORK_ENV__");
  await seedActors(w.sqlite, w.db, [{ id: "U-REP", email: REP, role: "associate" }, { id: "U-MGR", email: MANAGER, role: "manager" }]);
  await governance.saveLeadAssignmentMember(w.db, { employeeEmail: REP, teamCode: "sales", serviceCodes: ["boarding"], cityIds: ["blr"], active: true, actorId: MANAGER });
  return w;
}

let ipSeq = 0;
async function publicEnquiry(phone, service = "Boarding") {
  const response = await contact.POST(new Request("https://app.pawspace.in/api/public-contact", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${120 + (ipSeq++ % 100)}` },
    body: JSON.stringify({ name: "Engine Lead", phone, service, area: "Bengaluru", message: "Synthetic enquiry", whatsappConsent: false }),
  }));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.leadId;
}

const post = (email, body) => engine.POST(asActor(email, "/api/revenue-crm", { method: "POST", body: JSON.stringify(body) }));
const read = async (response) => ({ status: response.status, body: await response.json() });

test("a logged call meets the routed lead's first-response clock, so the SLA sweep never breaches or reassigns a lead the rep worked", async () => {
  const w = await salesWorld();
  const leadId = await publicEnquiry("9000000931");
  assert.equal(w.sqlite.prepare("SELECT owner FROM lead_work_items WHERE id=?").get(leadId).owner, REP, "the public enquiry was routed to the rep");
  assert.equal(w.sqlite.prepare("SELECT status FROM lead_sla_clocks WHERE lead_id=?").get(leadId).status, "running");

  const logged = await read(await post(MANAGER, { action: "log_attempt", leadId, channel: "call", outcome: "RNR", note: "Called, no answer" }));
  assert.equal(logged.status, 200, JSON.stringify(logged.body));
  assert.equal(logged.body.sla, "met");
  assert.equal(w.sqlite.prepare("SELECT status FROM lead_sla_clocks WHERE lead_id=? AND clock_type='first_response'").get(leadId).status, "met");

  // A week later the sweep has nothing to breach and nobody to take the lead from.
  await sla.runLeadSlaGovernance(w.db, { actorId: "scheduler", asOf: Date.now() + 7 * DAY });
  assert.equal(w.sqlite.prepare("SELECT status FROM lead_work_items WHERE id=?").get(leadId).status, "active", "not sla_breached");
  assert.equal(w.sqlite.prepare("SELECT employee_email FROM lead_assignments WHERE lead_id=? AND status='current'").get(leadId).employee_email, REP, "still with the rep who called");
});

test("an untouched routed lead does breach, escalate and move on - the clock is real", async () => {
  const w = await salesWorld();
  const leadId = await publicEnquiry("9000000932");
  await sla.runLeadSlaGovernance(w.db, { actorId: "scheduler", asOf: Date.now() + 2 * DAY });
  assert.equal(w.sqlite.prepare("SELECT status FROM lead_work_items WHERE id=?").get(leadId).status, "sla_breached");
  const events = w.sqlite.prepare("SELECT event_type FROM lead_sla_events WHERE lead_id=?").all(leadId).map((row) => row.event_type);
  assert.ok(events.includes("breached") && events.includes("manager_escalation_due"), JSON.stringify(events));
});

const get = (email, query = "") => engine.GET(asActor(email, `/api/revenue-crm${query}`));

const OTHER_REP = "rep.other@pawspace.test";
function leadOwnedBy(w, leadId, owner) {
  const now = Date.now();
  w.sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,stage,owner,created_at,updated_at) VALUES (?,?,?,'New lead',?,?,?)").run(`CU-${leadId}`, "Someone Else's Lead", "9000000999", owner, now, now);
  w.sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?,'Website','Boarding',?,'Sales Manager','active','day_1',1,?,?,?,?,?)").run(leadId, `CU-${leadId}`, owner, now, now + 600_000, now + 1_800_000, now, now);
}

// Round-2 staging (P1): the seeded sales executives are role `associate`, and every lead action in the
// Revenue & CX engine required customers.manage - "Log RNR call", "Connected" and callbacks all 403.
test("a sales associate logs calls and callbacks on the leads assigned to them - past the gateway too - and not on anyone else's", async () => {
  const w = await salesWorld();
  await seedActors(w.sqlite, w.db, [{ id: "U-OTHER", email: OTHER_REP, role: "associate" }]);
  const mine = await publicEnquiry("9000000951");
  assert.equal(w.sqlite.prepare("SELECT owner FROM lead_work_items WHERE id=?").get(mine).owner, REP);
  leadOwnedBy(w, "LEAD-OTHER-1", OTHER_REP);

  const { requiredPermission } = await import("../lib/api-gateway.ts");
  const gate = (body) => requiredPermission(asActor(REP, "/api/revenue-crm", { method: "POST", body: JSON.stringify(body) }));
  for (const action of ["log_attempt", "schedule_callback", "complete_callback"]) assert.equal(await gate({ action, leadId: mine }), "customers.view", action);
  for (const action of ["advance_day", "run_sla", "mark_cold", "generate_daily_100", "create_ticket"]) assert.equal(await gate({ action, leadId: mine }), "customers.manage", action);

  const logged = await read(await post(REP, { action: "log_attempt", leadId: mine, channel: "call", outcome: "Connected", note: "Spoke to the customer" }));
  assert.equal(logged.status, 200, JSON.stringify(logged.body));
  assert.equal(logged.body.sla, "met", "the associate's own call meets the first-response clock");
  const scheduled = await read(await post(REP, { action: "schedule_callback", leadId: mine, requestedAt: Date.now() + 3_600_000, reason: "Customer asked for a call after work" }));
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  const completed = await read(await post(REP, { action: "complete_callback", callbackId: scheduled.body.callback.id, outcome: "connected" }));
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const refused = await read(await post(REP, { action: "log_attempt", leadId: "LEAD-OTHER-1", channel: "call", outcome: "Opt-out" }));
  assert.equal(refused.status, 403, "not their lead");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM lead_attempts WHERE lead_id='LEAD-OTHER-1'").get().n, 0, "and nothing was written");
  assert.equal((await post(REP, { action: "schedule_callback", leadId: "LEAD-OTHER-1", requestedAt: Date.now() + 3_600_000, reason: "Not my lead to promise a call on" })).status, 403);
  for (const body of [{ action: "advance_day", leadId: mine }, { action: "run_sla" }, { action: "mark_cold", leadId: mine }]) assert.equal((await post(REP, body)).status, 403, `${body.action} stays a manager action`);

  assert.equal((await post(MANAGER, { action: "log_attempt", leadId: "LEAD-OTHER-1", channel: "call", outcome: "RNR" })).status, 200, "a manager works any lead");
});

test("an associate's worklist is the leads assigned to them; a manager sees every open lead", async () => {
  const w = await salesWorld();
  await seedActors(w.sqlite, w.db, [{ id: "U-OTHER", email: OTHER_REP, role: "associate" }]);
  const mine = await publicEnquiry("9000000952");
  leadOwnedBy(w, "LEAD-OTHER-2", OTHER_REP);
  const own = await read(await get(REP));
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.leads.map((lead) => lead.id), [mine]);
  assert.equal(own.body.leadsPage.total, 1);
  const everyone = await read(await get(MANAGER));
  assert.deepEqual(new Set(everyone.body.leads.map((lead) => lead.id)), new Set([mine, "LEAD-OTHER-2"]));
});

/** Older leads straight into the tables the engine reads, the way months of enquiries accumulate. */
function seedOlderLeads(w, count, { status = "active", prefix = "LEAD-OLD" } = {}) {
  const now = Date.now();
  const contact = w.sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,stage,owner,created_at,updated_at) VALUES (?,?,?,'New lead',?,?,?)");
  const lead = w.sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?,'Website','Boarding',?, 'Sales Manager',?,'day_1',1,?,?,?,?,?)");
  for (let index = 0; index < count; index++) {
    const created = now - 30 * DAY + index * 60_000, id = `${prefix}-${String(index).padStart(3, "0")}`;
    contact.run(`CU-${id}`, `Older ${id}`, `90000${String(index).padStart(5, "0")}`, REP, created, created);
    lead.run(id, `CU-${id}`, REP, status, created, created + 10 * 60_000, created + 30 * 60_000, created, created);
  }
}

// Round-2 staging: the engine listed `ORDER BY manager_alert_at LIMIT 80` over every lead ever made, so
// once 80 older leads existed a new lead could not appear there at all.
test("a new lead is on the first page of the Revenue & CX engine however many older leads exist; closed leads are not listed and every open lead is reachable", async () => {
  const w = await salesWorld();
  await get(MANAGER); // the engine's own tables
  seedOlderLeads(w, 90);
  seedOlderLeads(w, 6, { status: "closed", prefix: "LEAD-DONE" });
  const leadId = await publicEnquiry("9000000941");

  const first = await read(await get(MANAGER));
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
  assert.equal(first.body.leads[0].id, leadId, "newest first: the new enquiry leads the worklist");
  assert.equal(first.body.leads.length, 80);
  assert.deepEqual(first.body.leadsPage, { sort: "newest", page: 0, limit: 80, total: 91, hasMore: true });
  assert.equal(first.body.stats.openLeads, 91);
  assert.ok(first.body.leads.every((lead) => !["closed", "converted", "cold_exhausted"].includes(lead.status)), "closed leads need no action and take no slot");
  assert.ok(first.body.leads.every((lead) => !("primary_phone" in lead)), "the worklist carries no contact number");

  const second = await read(await get(MANAGER, "?leadPage=1"));
  assert.equal(second.body.leads.length, 11);
  assert.equal(second.body.leadsPage.hasMore, false);
  const everyOpen = new Set([...first.body.leads, ...second.body.leads].map((lead) => lead.id));
  assert.equal(everyOpen.size, 91, "every open lead is reachable by paging");

  // "SLA due first": a breached lead leads, then the earliest due.
  w.sqlite.prepare("UPDATE lead_work_items SET status='sla_breached' WHERE id='LEAD-OLD-050'").run();
  const due = await read(await get(MANAGER, "?leadSort=due"));
  assert.equal(due.body.leads[0].id, "LEAD-OLD-050");
  assert.equal(due.body.leads[1].id, "LEAD-OLD-000", "then the lead whose first response has been due longest");
  assert.equal(due.body.stats.slaBreaches, 1, "counted over all open leads, not just the page");
});
