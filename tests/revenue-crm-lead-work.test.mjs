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
