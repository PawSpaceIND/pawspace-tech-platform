import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Task 18 audit — lead engine. Real execution of the real assignment / SLA /
// callback / attribution modules over real SQLite. What matters here: one lead
// can never have two current owners, an opted-out lead is never dialled, SLA
// breach + auto-reassignment are idempotent, and conversion credits the lead
// the booking actually came from.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const NOW = 1770000000000;
const HOUR = 3600000;

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE lead_attempts (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, channel TEXT NOT NULL, sequence_number INTEGER NOT NULL, outcome TEXT NOT NULL, note TEXT, provider_status TEXT NOT NULL DEFAULT 'uat_queued', created_by TEXT NOT NULL, created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL)");
  return { sqlite, db };
}

function seedRep(sqlite, email, name) {
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(`USR-${email}`, email, name, "sales_associate", NOW, NOW);
}
function seedContact(sqlite, id, area = "Bengaluru East") {
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,area,stage,owner,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, `Customer ${id}`, "9999900000", area, "New lead", "Unassigned", "Website", NOW, NOW);
}
function seedLead(sqlite, id, customerId, service, source = "Website", optOut = 0) {
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,'Unassigned','Sales Manager','active','day_1',1,?,?,?,0,0,0,?,?,?)")
    .run(id, customerId, source, service, NOW, NOW + 600000, NOW + 1800000, optOut, NOW, NOW);
}

async function assignmentWorld() {
  const { sqlite, db } = fresh();
  const mod = await import("../lib/lead-assignment-governance.ts");
  await mod.ensureLeadAssignmentTables(db);
  seedRep(sqlite, "rep.one@pawspace.in", "Rep One");
  seedRep(sqlite, "rep.two@pawspace.in", "Rep Two");
  const policy = await mod.saveLeadAssignmentPolicy(db, {
    name: "Bengaluru grooming sales", teamCode: "sales_blr", serviceCodes: ["grooming"], cityIds: ["Bengaluru"],
    languageCodes: ["en"], maxActiveWorkload: 2, continuityEnabled: false, requireShift: false,
    fallbackQueue: "sales_overflow", effectiveFrom: NOW - HOUR, reason: "Task 18 audit seed policy",
    actorId: "founder@pawspace.in",
  });
  await mod.activateLeadAssignmentPolicy(db, { policyId: policy.id, approvalReference: "BOARD-2026-07", reason: "Task 18 audit activation", actorId: "founder@pawspace.in" });
  for (const email of ["rep.one@pawspace.in", "rep.two@pawspace.in"]) {
    await mod.saveLeadAssignmentMember(db, { employeeEmail: email, teamCode: "sales_blr", serviceCodes: ["grooming"], cityIds: ["Bengaluru"], languageCodes: ["en"], active: true, actorId: "founder@pawspace.in" });
  }
  return { sqlite, db, mod, policy };
}

// ---------------------------------------------------------------------------
// 1. One lead, one current owner — even under a concurrent double assign.
// ---------------------------------------------------------------------------
test("lead assignment: concurrent assigns produce exactly one current owner", async () => {
  const { sqlite, db, mod } = await assignmentWorld();
  seedContact(sqlite, "CU-1");
  seedLead(sqlite, "LEAD-1", "CU-1", "grooming");

  const [a, b] = await Promise.all([
    mod.assignLead(db, { leadId: "LEAD-1", idempotencyKey: "assign-a", reason: "new_lead", actorId: "system", asOf: NOW }),
    mod.assignLead(db, { leadId: "LEAD-1", idempotencyKey: "assign-b", reason: "new_lead", actorId: "system", asOf: NOW }),
  ]);
  const current = sqlite.prepare("SELECT * FROM lead_assignments WHERE lead_id='LEAD-1' AND status='current'").all();
  assert.equal(current.length, 1, "exactly one current assignment survives");
  const duplicates = [a, b].filter((result) => result.duplicatePrevented).length;
  assert.equal(duplicates, 1, "the losing caller is told it was a duplicate, not given a second owner");
  assert.ok(!a.error && !b.error);

  // lead_work_items.owner is a projection of the canonical assignment.
  const lead = sqlite.prepare("SELECT owner FROM lead_work_items WHERE id='LEAD-1'").get();
  assert.equal(lead.owner, current[0].employee_email);
});

test("lead assignment: same idempotency key never creates a second assignment", async () => {
  const { sqlite, db, mod } = await assignmentWorld();
  seedContact(sqlite, "CU-2");
  seedLead(sqlite, "LEAD-2", "CU-2", "grooming");
  const first = await mod.assignLead(db, { leadId: "LEAD-2", idempotencyKey: "same-key", reason: "new_lead", actorId: "system", asOf: NOW });
  const replay = await mod.assignLead(db, { leadId: "LEAD-2", idempotencyKey: "same-key", reason: "new_lead", actorId: "system", asOf: NOW });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.assignment.id, first.assignment.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_assignments WHERE lead_id='LEAD-2'").get().c, 1);
});

test("lead assignment: workload cap respected, overflow goes to the fallback queue", async () => {
  const { sqlite, db, mod } = await assignmentWorld();
  // cap is 2 per rep, 2 reps => 4 assignable leads, the 5th must fall back.
  for (let index = 1; index <= 5; index++) {
    seedContact(sqlite, `CU-CAP-${index}`);
    seedLead(sqlite, `LEAD-CAP-${index}`, `CU-CAP-${index}`, "grooming");
  }
  const results = [];
  for (let index = 1; index <= 5; index++) {
    results.push(await mod.assignLead(db, { leadId: `LEAD-CAP-${index}`, idempotencyKey: `cap-${index}`, reason: "new_lead", actorId: "system", asOf: NOW }));
  }
  const owned = results.filter((r) => r.assignment.employee_email).length;
  assert.equal(owned, 4, "no rep is loaded past their configured cap");
  const fallback = results[4];
  assert.equal(fallback.assignment.employee_email, null);
  assert.equal(fallback.assignment.fallback_queue, "sales_overflow");
  // workload spread evenly, not all onto the first rep
  const perRep = sqlite.prepare("SELECT employee_email,COUNT(*) c FROM lead_assignments WHERE status='current' AND employee_email IS NOT NULL GROUP BY employee_email").all();
  assert.deepEqual(perRep.map((row) => row.c), [2, 2]);
});

test("lead assignment: acknowledgement is owner-only and idempotent under concurrency", async () => {
  const { sqlite, db, mod } = await assignmentWorld();
  seedContact(sqlite, "CU-3");
  seedLead(sqlite, "LEAD-3", "CU-3", "grooming");
  const assigned = await mod.assignLead(db, { leadId: "LEAD-3", idempotencyKey: "ack-1", reason: "new_lead", actorId: "system", asOf: NOW });
  const owner = assigned.assignment.employee_email;
  const other = owner === "rep.one@pawspace.in" ? "rep.two@pawspace.in" : "rep.one@pawspace.in";
  await assert.rejects(
    () => mod.acceptLeadAssignment(db, { assignmentId: assigned.assignment.id, actorEmail: other }),
    /Only the assigned employee/,
    "a different rep cannot acknowledge someone else's lead",
  );
  const [first, second] = await Promise.all([
    mod.acceptLeadAssignment(db, { assignmentId: assigned.assignment.id, actorEmail: owner }),
    mod.acceptLeadAssignment(db, { assignmentId: assigned.assignment.id, actorEmail: owner }),
  ]);
  assert.equal([first, second].filter((r) => r.duplicatePrevented).length, 1, "exactly one real acknowledgement");
  const events = sqlite.prepare("SELECT COUNT(*) c FROM lead_assignment_events WHERE assignment_id=? AND event_type='accepted'").get(assigned.assignment.id);
  assert.equal(events.c, 1, "acknowledgement is recorded exactly once");
});

// ---------------------------------------------------------------------------
// 2. Consent: an opted-out lead is never handed out for outbound calling.
// ---------------------------------------------------------------------------
test("outbound batching never assigns an opted-out lead", async () => {
  const { sqlite, db, mod } = await assignmentWorld();
  seedContact(sqlite, "CU-OK");
  seedContact(sqlite, "CU-OPTOUT");
  seedLead(sqlite, "LEAD-OK", "CU-OK", "grooming", "outbound_list_july");
  seedLead(sqlite, "LEAD-OPTOUT", "CU-OPTOUT", "grooming", "outbound_list_july", 1);

  const batch = await mod.assignNextOutboundBatch(db, { repEmail: "rep.one@pawspace.in", batchSize: 10, actorId: "system", asOf: NOW });
  assert.ok(batch.assignedLeadIds.includes("LEAD-OK"), "the consenting lead is worked");
  assert.ok(!batch.assignedLeadIds.includes("LEAD-OPTOUT"), "the opted-out lead must never be dialled");
  const optOutAssignment = sqlite.prepare("SELECT COUNT(*) c FROM lead_assignments WHERE lead_id='LEAD-OPTOUT'").get();
  assert.equal(optOutAssignment.c, 0);
});

// ---------------------------------------------------------------------------
// 3. RNR auto-reassignment: threshold is real, and re-running is a no-op.
// ---------------------------------------------------------------------------
test("RNR auto-reassignment fires once at the real threshold and is replay-safe", async () => {
  const { sqlite, db, mod } = await assignmentWorld();
  seedContact(sqlite, "CU-RNR");
  seedLead(sqlite, "LEAD-RNR", "CU-RNR", "grooming");
  const assigned = await mod.assignLead(db, { leadId: "LEAD-RNR", idempotencyKey: "rnr-assign", reason: "new_lead", actorId: "system", asOf: NOW });
  const firstOwner = assigned.assignment.employee_email;
  sqlite.prepare("UPDATE lead_work_items SET assigned_at=?,owner=? WHERE id='LEAD-RNR'").run(NOW, firstOwner);

  const logRnr = (sequence) => sqlite.prepare("INSERT INTO lead_attempts (id,lead_id,channel,sequence_number,outcome,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(`ATT-${sequence}`, "LEAD-RNR", "call", sequence, "RNR", "system", NOW + sequence * 60000);

  logRnr(1); logRnr(2);
  const early = await mod.checkRnrAutoReassignment(db, { leadId: "LEAD-RNR", actorId: "system", asOf: NOW + 3 * 60000 });
  assert.equal(early.triggered, false);
  assert.equal(early.reason, "threshold_not_reached");
  assert.equal(early.rnrCount, 2);

  logRnr(3);
  const fired = await mod.checkRnrAutoReassignment(db, { leadId: "LEAD-RNR", actorId: "system", asOf: NOW + 4 * 60000 });
  assert.equal(fired.triggered, true);
  assert.equal(fired.previousOwner, firstOwner);
  assert.notEqual(fired.newOwner, firstOwner, "the lead moves to a different rep, not back to the one who failed it");

  // Re-running must not bounce the lead again: the RNR window is anchored to the CURRENT
  // assignment, so the new owner does not inherit the previous owner's 3 RNRs (which would
  // ping-pong the lead straight back to the rep who just failed it).
  const again = await mod.checkRnrAutoReassignment(db, { leadId: "LEAD-RNR", actorId: "system", asOf: NOW + 5 * 60000 });
  assert.equal(again.triggered, false);
  assert.equal(again.reason, "threshold_not_reached");
  assert.equal(again.rnrCount, 0, "RNRs logged against the previous owner do not count against the new one");
  const currentRnr = sqlite.prepare("SELECT employee_email FROM lead_assignments WHERE lead_id='LEAD-RNR' AND status='current'").all();
  assert.equal(currentRnr.length, 1);
  assert.notEqual(currentRnr[0].employee_email, firstOwner, "the lead did not bounce back to the failing rep");
});

// ---------------------------------------------------------------------------
// 4. SLA clocks: breach, escalation and auto-reassign are all idempotent.
// ---------------------------------------------------------------------------
async function slaWorld() {
  const world = await assignmentWorld();
  const sla = await import("../lib/lead-sla-governance.ts");
  await sla.ensureLeadSlaTables(world.db);
  const policy = await sla.saveLeadSlaPolicy(world.db, {
    name: "Bengaluru grooming SLA", teamCode: "sales_blr", serviceCodes: ["grooming"], cityIds: ["Bengaluru"],
    timezone: "Asia/Kolkata", businessHours: { mode: "elapsed" },
    firstResponseMinutes: 10, followUpMinutes: 60, quoteFollowUpMinutes: 120, highIntentMinutes: 5,
    managerEscalationAfterMinutes: 20, reassignmentAfterMinutes: 30, requireNextAction: true,
    terminalOutcomes: ["not_interested", "converted"], effectiveFrom: NOW - HOUR,
    reason: "Task 18 audit SLA seed", actorId: "founder@pawspace.in",
  });
  await sla.activateLeadSlaPolicy(world.db, { policyId: policy.id, approvalReference: "BOARD-2026-07", reason: "Task 18 audit SLA activation", actorId: "founder@pawspace.in" });
  return { ...world, sla };
}

test("SLA clock: due date is computed from the policy, breach recorded exactly once", async () => {
  const { sqlite, db, mod, sla } = await slaWorld();
  seedContact(sqlite, "CU-SLA");
  seedLead(sqlite, "LEAD-SLA", "CU-SLA", "grooming");
  await mod.assignLead(db, { leadId: "LEAD-SLA", idempotencyKey: "sla-assign", reason: "new_lead", actorId: "system", asOf: NOW });
  const started = await sla.startLeadSlaClock(db, { leadId: "LEAD-SLA", clockType: "first_response", idempotencyKey: "sla-clock-1", actorId: "system", asOf: NOW });
  assert.equal(Number(started.clock.due_at), NOW + 10 * 60000, "first-response due date is the configured 10 minutes");
  assert.equal(Number(started.clock.manager_escalation_due_at), NOW + 30 * 60000);
  assert.equal(Number(started.clock.reassignment_due_at), NOW + 60 * 60000);

  // Before the deadline nothing breaches.
  const early = await sla.runLeadSlaGovernance(db, { actorId: "cron", asOf: NOW + 5 * 60000 });
  assert.equal(early.breached, 0);

  const first = await sla.runLeadSlaGovernance(db, { actorId: "cron", asOf: NOW + 11 * 60000 });
  assert.equal(first.breached, 1);
  const replay = await sla.runLeadSlaGovernance(db, { actorId: "cron", asOf: NOW + 12 * 60000 });
  assert.equal(replay.breached, 0, "a second sweep must not re-breach the same clock");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_sla_events WHERE event_type='breached'").get().c, 1);
  assert.equal(sqlite.prepare("SELECT status FROM lead_work_items WHERE id='LEAD-SLA'").get().status, "sla_breached");
});

test("SLA sweep: reassignment threshold moves the lead off the failing rep, once", async () => {
  const { sqlite, db, mod, sla } = await slaWorld();
  seedContact(sqlite, "CU-SLA2");
  seedLead(sqlite, "LEAD-SLA2", "CU-SLA2", "grooming");
  const assigned = await mod.assignLead(db, { leadId: "LEAD-SLA2", idempotencyKey: "sla2-assign", reason: "new_lead", actorId: "system", asOf: NOW });
  const failingRep = assigned.assignment.employee_email;
  await sla.startLeadSlaClock(db, { leadId: "LEAD-SLA2", clockType: "first_response", idempotencyKey: "sla2-clock", actorId: "system", asOf: NOW });

  const swept = await sla.runLeadSlaGovernance(db, { actorId: "cron", asOf: NOW + 61 * 60000 });
  assert.equal(swept.autoReassigned, 1);
  const current = sqlite.prepare("SELECT employee_email FROM lead_assignments WHERE lead_id='LEAD-SLA2' AND status='current'").all();
  assert.equal(current.length, 1, "still exactly one current owner after auto-reassignment");
  assert.notEqual(current[0].employee_email, failingRep, "the rep who breached does not get the lead back");

  const again = await sla.runLeadSlaGovernance(db, { actorId: "cron", asOf: NOW + 62 * 60000 });
  assert.equal(again.autoReassigned, 0, "auto-reassignment does not repeat for the same clock");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_sla_events WHERE event_type='auto_reassigned'").get().c, 1);
});

test("SLA action: a non-terminal outcome must schedule a governed next action", async () => {
  const { sqlite, db, mod, sla } = await slaWorld();
  seedContact(sqlite, "CU-SLA3");
  seedLead(sqlite, "LEAD-SLA3", "CU-SLA3", "grooming");
  await mod.assignLead(db, { leadId: "LEAD-SLA3", idempotencyKey: "sla3-assign", reason: "new_lead", actorId: "system", asOf: NOW });
  await sla.startLeadSlaClock(db, { leadId: "LEAD-SLA3", clockType: "first_response", idempotencyKey: "sla3-clock", actorId: "system", asOf: NOW });

  await assert.rejects(
    () => sla.recordLeadSlaAction(db, { leadId: "LEAD-SLA3", actionType: "call", outcome: "call_back_later", idempotencyKey: "sla3-act-bad", actorId: "rep.one@pawspace.in", asOf: NOW + 60000 }),
    /requires a governed next action/,
  );
  const ok = await sla.recordLeadSlaAction(db, { leadId: "LEAD-SLA3", actionType: "call", outcome: "call_back_later", nextClockType: "follow_up", idempotencyKey: "sla3-act", actorId: "rep.one@pawspace.in", asOf: NOW + 60000 });
  assert.equal(ok.terminal, false);
  assert.ok(ok.next?.clock, "a follow-up clock is opened");
  const replay = await sla.recordLeadSlaAction(db, { leadId: "LEAD-SLA3", actionType: "call", outcome: "call_back_later", nextClockType: "follow_up", idempotencyKey: "sla3-act", actorId: "rep.one@pawspace.in", asOf: NOW + 120000 });
  assert.equal(replay.duplicatePrevented, true, "the same logged action never opens two follow-up clocks");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_sla_clocks WHERE lead_id='LEAD-SLA3' AND clock_type='follow_up'").get().c, 1);

  // A terminal outcome closes the lead without demanding a next action.
  const terminal = await sla.recordLeadSlaAction(db, { leadId: "LEAD-SLA3", actionType: "call", outcome: "not_interested", idempotencyKey: "sla3-terminal", actorId: "rep.one@pawspace.in", asOf: NOW + 180000 });
  assert.equal(terminal.terminal, true);
  assert.equal(sqlite.prepare("SELECT status FROM lead_work_items WHERE id='LEAD-SLA3'").get().status, "closed");
});

// ---------------------------------------------------------------------------
// 5. Callbacks: a customer-requested time is honoured, only one live promise,
//    missed sweep is idempotent.
// ---------------------------------------------------------------------------
test("callbacks: one live promise per lead, missed sweep fires once", async () => {
  const { sqlite, db } = fresh();
  const attribution = await import("../lib/lead-conversion-attribution.ts");
  await attribution.ensureLeadWorkItemsTable(db);
  const callbacks = await import("../lib/lead-callback-governance.ts");
  seedContact(sqlite, "CU-CB");
  seedLead(sqlite, "LEAD-CB", "CU-CB", "grooming");

  const future = Date.now() + 45 * 60000;
  const scheduled = await callbacks.scheduleLeadCallback(db, { leadId: "LEAD-CB", requestedAt: future, reason: "Customer asked for a call after 6pm today", actorId: "rep.one@pawspace.in" });
  assert.equal(scheduled.requestedAt, future, "the callback is at the time the customer actually asked for");
  const lead = sqlite.prepare("SELECT next_action_at FROM lead_work_items WHERE id='LEAD-CB'").get();
  assert.equal(Number(lead.next_action_at), future, "the worklist agrees with the callback queue");

  const replay = await callbacks.scheduleLeadCallback(db, { leadId: "LEAD-CB", requestedAt: future, reason: "Customer asked for a call after 6pm today", actorId: "rep.one@pawspace.in" });
  assert.equal(replay.duplicatePrevented, true);

  const rescheduled = await callbacks.scheduleLeadCallback(db, { leadId: "LEAD-CB", requestedAt: future + 30 * 60000, reason: "Customer moved the call to 6:30pm instead", actorId: "rep.one@pawspace.in" });
  const live = sqlite.prepare("SELECT COUNT(*) c FROM lead_callbacks WHERE lead_id='LEAD-CB' AND status='scheduled'").get();
  assert.equal(live.c, 1, "only one live callback promise at a time");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_callbacks WHERE lead_id='LEAD-CB' AND status='superseded'").get().c, 1, "the earlier promise stays visible in history");

  // Past the 15-minute grace, the missed sweep marks it once.
  const asOf = rescheduled.requestedAt + 20 * 60000;
  const firstSweep = await callbacks.runLeadCallbackSweep(db, { actorId: "cron", asOf });
  assert.equal(firstSweep.missed, 1);
  const secondSweep = await callbacks.runLeadCallbackSweep(db, { actorId: "cron", asOf: asOf + 60000 });
  assert.equal(secondSweep.missed, 0, "a missed callback is not re-reported every sweep");

  const completed = await callbacks.completeLeadCallback(db, { callbackId: rescheduled.id, outcome: "spoke_to_customer", actorId: "rep.one@pawspace.in" });
  assert.equal(completed.status, "completed");
  const completedReplay = await callbacks.completeLeadCallback(db, { callbackId: rescheduled.id, outcome: "spoke_to_customer", actorId: "rep.one@pawspace.in" });
  assert.equal(completedReplay.duplicatePrevented, true);
});

test("callbacks: a placeholder past time is rejected, and the rep-scoped queue is not a team feed", async () => {
  const { sqlite, db } = fresh();
  const attribution = await import("../lib/lead-conversion-attribution.ts");
  await attribution.ensureLeadWorkItemsTable(db);
  const callbacks = await import("../lib/lead-callback-governance.ts");
  seedContact(sqlite, "CU-CB2");
  seedContact(sqlite, "CU-CB3");
  seedLead(sqlite, "LEAD-CB2", "CU-CB2", "grooming");
  seedLead(sqlite, "LEAD-CB3", "CU-CB3", "grooming");
  sqlite.prepare("UPDATE lead_work_items SET owner='rep.one@pawspace.in' WHERE id='LEAD-CB2'").run();
  sqlite.prepare("UPDATE lead_work_items SET owner='rep.two@pawspace.in' WHERE id='LEAD-CB3'").run();

  await assert.rejects(
    () => callbacks.scheduleLeadCallback(db, { leadId: "LEAD-CB2", requestedAt: Date.now() - 60000, reason: "Customer asked for a call earlier", actorId: "rep.one@pawspace.in" }),
    /future time/,
  );
  const soon = Date.now() + 10 * 60000;
  await callbacks.scheduleLeadCallback(db, { leadId: "LEAD-CB2", requestedAt: soon, reason: "Customer asked for a call in ten minutes", actorId: "rep.one@pawspace.in" });
  await callbacks.scheduleLeadCallback(db, { leadId: "LEAD-CB3", requestedAt: soon, reason: "Different customer, different rep, same slot", actorId: "rep.two@pawspace.in" });

  const repOne = await callbacks.dueLeadCallbacks(db, { ownerEmail: "rep.one@pawspace.in", lookAheadMinutes: 60 });
  assert.deepEqual(repOne.map((row) => row.leadId), ["LEAD-CB2"], "a rep sees only their own callbacks");
  const team = await callbacks.dueLeadCallbacks(db, { lookAheadMinutes: 60 });
  assert.equal(team.length, 2, "the manager view explicitly asks for the whole team");
});

// ---------------------------------------------------------------------------
// 6. Attribution: conversion is payment-gated AND credits the right lead.
// ---------------------------------------------------------------------------
test("attribution: booking without captured payment keeps the lead open", async () => {
  const { sqlite, db } = fresh();
  const attribution = await import("../lib/lead-conversion-attribution.ts");
  await attribution.ensureLeadWorkItemsTable(db);
  seedContact(sqlite, "CU-ATTR");
  seedLead(sqlite, "LEAD-ATTR", "CU-ATTR", "grooming");
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,status,created_at) VALUES (?,?,?,?,?,?)")
    .run("PAY-1", "BK-ATTR", "CU-ATTR", 1349, "created", NOW);

  const linked = await attribution.attributeBookingToOpenLead(db, { customerId: "CU-ATTR", bookingId: "BK-ATTR" });
  assert.equal(linked.converted, false, "booked-but-unpaid is not a conversion");
  const openLead = sqlite.prepare("SELECT status,last_outcome,converted_booking_id FROM lead_work_items WHERE id='LEAD-ATTR'").get();
  assert.equal(openLead.status, "active", "Sales still owns the lead through payment recovery");
  assert.equal(openLead.last_outcome, "booking_initiated");
  assert.equal(openLead.converted_booking_id, null);

  sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id='BK-ATTR'").run();
  await attribution.convertLeadOnPaymentCaptured(db, { customerId: "CU-ATTR", bookingId: "BK-ATTR" });
  const converted = sqlite.prepare("SELECT status,converted_booking_id FROM lead_work_items WHERE id='LEAD-ATTR'").get();
  assert.equal(converted.status, "converted");
  assert.equal(converted.converted_booking_id, "BK-ATTR");
});

test("attribution: payment capture credits the lead the booking actually came from", async () => {
  const { sqlite, db } = fresh();
  const attribution = await import("../lib/lead-conversion-attribution.ts");
  await attribution.ensureLeadWorkItemsTable(db);
  seedContact(sqlite, "CU-TWO");
  // Two open leads for one customer: an older grooming enquiry, and a newer boarding enquiry.
  seedLead(sqlite, "LEAD-OLD", "CU-TWO", "grooming");
  seedLead(sqlite, "LEAD-NEW", "CU-TWO", "boarding");
  sqlite.prepare("UPDATE lead_work_items SET assigned_at=? WHERE id='LEAD-OLD'").run(NOW - HOUR);
  sqlite.prepare("UPDATE lead_work_items SET assigned_at=? WHERE id='LEAD-NEW'").run(NOW);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,status,created_at) VALUES (?,?,?,?,?,?)")
    .run("PAY-OLD", "BK-GROOM", "CU-TWO", 1349, "created", NOW);

  // The booking is attributed to the newest open lead at creation time...
  const linked = await attribution.attributeBookingToOpenLead(db, { customerId: "CU-TWO", bookingId: "BK-GROOM" });
  assert.equal(linked.leadId, "LEAD-NEW");

  // ...then a THIRD, even newer lead arrives before the payment is captured.
  seedLead(sqlite, "LEAD-NEWEST", "CU-TWO", "dog_walking");
  sqlite.prepare("UPDATE lead_work_items SET assigned_at=? WHERE id='LEAD-NEWEST'").run(NOW + HOUR);
  sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id='BK-GROOM'").run();

  const converted = await attribution.convertLeadOnPaymentCaptured(db, { customerId: "CU-TWO", bookingId: "BK-GROOM" });
  assert.equal(converted.leadId, "LEAD-NEW", "the lead this booking was linked to gets the credit, not whichever lead is newest");
  assert.equal(sqlite.prepare("SELECT status FROM lead_work_items WHERE id='LEAD-NEWEST'").get().status, "active", "an unrelated newer lead is untouched");
  assert.equal(sqlite.prepare("SELECT status FROM lead_work_items WHERE id='LEAD-OLD'").get().status, "active");
});

// ---------------------------------------------------------------------------
// 7. Policy governance: an active policy is immutable, activation needs approval.
// ---------------------------------------------------------------------------
test("assignment policy: active policy is immutable and activation demands an approval reference", async () => {
  const { db, mod, policy } = await assignmentWorld();
  await assert.rejects(
    () => mod.saveLeadAssignmentPolicy(db, {
      id: policy.id, name: "Sneaky edit", teamCode: "sales_blr", serviceCodes: ["grooming"], cityIds: ["Bengaluru"],
      maxActiveWorkload: 99, continuityEnabled: false, requireShift: false, fallbackQueue: "sales_overflow",
      effectiveFrom: NOW, reason: "Trying to widen the cap silently", actorId: "rep.one@pawspace.in",
    }),
    /immutable/,
  );
  const draft = await mod.saveLeadAssignmentPolicy(db, {
    name: "Second policy draft", teamCode: "sales_blr", serviceCodes: ["boarding"], cityIds: ["Bengaluru"],
    maxActiveWorkload: 3, continuityEnabled: false, requireShift: false, fallbackQueue: "sales_overflow",
    effectiveFrom: NOW, reason: "Second policy for the boarding desk", actorId: "founder@pawspace.in",
  });
  await assert.rejects(
    () => mod.activateLeadAssignmentPolicy(db, { policyId: draft.id, approvalReference: "x", reason: "Activating boarding desk policy", actorId: "founder@pawspace.in" }),
    /approval reference/,
  );
});

// ---------------------------------------------------------------------------
// 8. No fabrication in the lead engine.
// ---------------------------------------------------------------------------
test("lead engine modules do not fabricate values or use banned DB access", () => {
  for (const path of [
    "lib/lead-assignment-governance.ts", "lib/lead-sla-governance.ts",
    "lib/lead-callback-governance.ts", "lib/lead-conversion-attribution.ts",
    "lib/haptik-outbound-governance.ts", "lib/daily-revenue-opportunity-governance.ts",
  ]) {
    const source = read(path);
    assert.ok(!/Math\.random/.test(source), `${path} must not fabricate values with Math.random`);
    assert.ok(!/globalThis\.__D1__/.test(source), `${path} must not use the banned globalThis D1 pattern`);
  }
});
