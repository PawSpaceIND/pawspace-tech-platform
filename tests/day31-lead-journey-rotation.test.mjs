/*
 * Day-31 cross-module test 1: the real telesales lead journey, executed.
 *
 * intake -> assignment policy -> auto-assignment -> RNR attempts -> automatic RNR reassignment ->
 * a SECOND automatic reassignment that rotates ownership back to the first rep -> a THIRD.
 *
 * Why this shape: PawSpace telesales is a small team. On a 2-3 person desk the "3 RNRs in 48h ->
 * next person" rule genuinely rotates a stubborn lead back to a rep who already held it, and it
 * does so within days, not months. Every existing test for lib/lead-assignment-governance.ts is a
 * source-text assertion (tests/lead-assignment-governance-uat.test.mjs) - none of them ever call
 * assignLead/reassignLead/checkRnrAutoReassignment against a database, so no test in this repo has
 * ever driven the rule past its FIRST rotation.
 *
 * The property under test is the one Ops depends on: a lead that keeps going unanswered must keep
 * moving to a rep who has not just failed on it, and the result the API reports must be the owner
 * the database actually holds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31_LEAD_DB__", "__D31_LEAD_ENV__");

const REP_A = "asha.rep@pawspace.in";
const REP_B = "bhavya.rep@pawspace.in";
const MANAGER = "sales.manager@pawspace.in";
const LEAD = "LEAD-D31-001";
const CUSTOMER = "CRM-D31-001";
const HOUR = 3600000;

async function seedWorld() {
  const { sqlite, db } = world("__D31_LEAD_DB__", "__D31_LEAD_ENV__");
  const {
    ensureLeadAssignmentTables, saveLeadAssignmentPolicy, activateLeadAssignmentPolicy,
    saveLeadAssignmentMember, assignLead, checkRnrAutoReassignment,
  } = await import("../lib/lead-assignment-governance.ts");
  // lead_attempts is owned by the bot/dialler disposition module - use the real creator, not a hand-rolled DDL.
  const { ensureBotCallDispositionTables } = await import("../lib/bot-call-disposition.ts");

  await seedActors(sqlite, db, [
    { id: "u-asha", email: REP_A, role: "sales_executive" },
    { id: "u-bhavya", email: REP_B, role: "sales_executive" },
    { id: "u-mgr", email: MANAGER, role: "sales_manager" },
  ]);
  await ensureLeadAssignmentTables(db);
  await ensureBotCallDispositionTables(db);

  const now = Date.now();
  sqlite.exec(`CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT NOT NULL DEFAULT 'New lead',owner TEXT DEFAULT 'Unassigned',source TEXT DEFAULT 'Website',lifetime_value REAL DEFAULT 0,next_action TEXT,opportunity TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,email,area,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(CUSTOMER, "Rhea Nair", "+919800000001", "rhea@example.com", "Bengaluru", now, now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,?,?)")
    .run(LEAD, CUSTOMER, "meta_ads", "grooming", "Unassigned", MANAGER, now, now + HOUR, now + 2 * HOUR, now, now);

  const policy = await saveLeadAssignmentPolicy(db, {
    name: "Bengaluru grooming telesales",
    teamCode: "telesales_blr", serviceCodes: ["grooming"], cityIds: ["Bengaluru"],
    maxActiveWorkload: 25, continuityEnabled: false, requireShift: false,
    fallbackQueue: "telesales_unassigned", effectiveFrom: now - HOUR,
    reason: "Day-31 cross-module verification of the real rotation rule", actorId: MANAGER,
  });
  await activateLeadAssignmentPolicy(db, {
    policyId: policy.id, approvalReference: "OPS-APPROVAL-D31",
    reason: "Day-31 cross-module verification of the real rotation rule", actorId: MANAGER,
  });
  for (const email of [REP_A, REP_B]) {
    await saveLeadAssignmentMember(db, {
      employeeEmail: email, teamCode: "telesales_blr", serviceCodes: ["grooming"],
      cityIds: ["Bengaluru"], active: true, actorId: MANAGER,
    });
  }
  return { sqlite, db, assignLead, checkRnrAutoReassignment, now };
}

/** Log `count` real RNR call attempts, the way the attempt logger does before it calls the rule. */
function logRnrs(sqlite, at, count, from = 0) {
  for (let i = 0; i < count; i++) {
    sqlite.prepare("INSERT INTO lead_attempts (id,lead_id,channel,sequence_number,outcome,provider_status,created_by,created_at) VALUES (?,?,'call',?,'RNR','uat_queued',?,?)")
      .run(`ATT-${at}-${from + i}`, LEAD, from + i + 1, "system:dialler", at + i * 60000);
  }
}

const ownerOf = (sqlite) => sqlite.prepare("SELECT owner FROM lead_work_items WHERE id=?").get(LEAD)?.owner;
const currentAssignee = (sqlite) =>
  sqlite.prepare("SELECT employee_email FROM lead_assignments WHERE lead_id=? AND status='current'").get(LEAD)?.employee_email;

test("a new grooming lead is auto-assigned to a real eligible rep", async () => {
  const { sqlite, db, assignLead } = await seedWorld();
  const result = await assignLead(db, {
    leadId: LEAD, idempotencyKey: `new-lead:${LEAD}`, reason: "new_lead", actorId: "system:intake",
  });
  assert.equal(result.duplicatePrevented, false);
  assert.ok([REP_A, REP_B].includes(result.assignment.employee_email), "a real rep must own it");
  assert.equal(ownerOf(sqlite), result.assignment.employee_email, "lead_work_items projection must agree");
});

test("3 RNRs inside the window move the lead off the rep who failed on it", async () => {
  const { sqlite, db, assignLead, checkRnrAutoReassignment, now } = await seedWorld();
  await assignLead(db, { leadId: LEAD, idempotencyKey: `new-lead:${LEAD}`, reason: "new_lead", actorId: "system:intake" });
  const first = ownerOf(sqlite);

  logRnrs(sqlite, now + HOUR, 3);
  const rotation = await checkRnrAutoReassignment(db, { leadId: LEAD, actorId: "system:dialler", asOf: now + 2 * HOUR });

  assert.equal(rotation.triggered, true, "the real rule must fire on the third RNR");
  assert.notEqual(currentAssignee(sqlite), first, "the failing rep must not still hold the lead");
  assert.equal(rotation.newOwner, currentAssignee(sqlite), "reported owner must be the stored owner");
});

test("a lead that keeps going unanswered keeps rotating - it does not get stranded on one rep", async () => {
  /*
   * Three consecutive rotations on a two-person desk: A -> B -> A -> B.
   * Each round logs its own three real RNRs inside its own assignment window, exactly as the
   * dialler would. Every round must land the lead on someone who did not just fail on it, and the
   * value the caller is handed must be the value the database holds - Ops reads that field.
   */
  const { sqlite, db, assignLead, checkRnrAutoReassignment, now } = await seedWorld();
  await assignLead(db, { leadId: LEAD, idempotencyKey: `new-lead:${LEAD}`, reason: "new_lead", actorId: "system:intake" });

  const seen = [ownerOf(sqlite)];
  let logged = 0;
  for (let round = 1; round <= 3; round++) {
    const failingOwner = ownerOf(sqlite);
    const assignedAt = Number(sqlite.prepare("SELECT assigned_at FROM lead_work_items WHERE id=?").get(LEAD).assigned_at);
    logRnrs(sqlite, assignedAt + 1000, 3, logged);
    logged += 3;

    const rotation = await checkRnrAutoReassignment(db, {
      leadId: LEAD, actorId: "system:dialler", asOf: assignedAt + 3 * HOUR,
    });

    assert.equal(rotation.triggered, true, `round ${round}: the rule must fire on 3 fresh RNRs`);
    const stored = currentAssignee(sqlite);
    assert.notEqual(stored, failingOwner,
      `round ${round}: the lead is still owned by ${failingOwner}, the rep who just failed on it 3 times`);
    assert.equal(rotation.newOwner, stored,
      `round ${round}: caller was told the owner is ${rotation.newOwner} but the database says ${stored}`);
    assert.equal(ownerOf(sqlite), stored, `round ${round}: lead_work_items projection drifted from lead_assignments`);
    seen.push(stored);
  }
  assert.deepEqual(seen.length, 4);
});

test("re-running the rule inside the same assignment stays a safe no-op", async () => {
  /*
   * The rotation key is now per-assignment rather than per-owner. That must not weaken the
   * documented idempotency contract: the attempt logger calls this rule after EVERY logged attempt,
   * so a second call that follows a rotation must not rotate the lead again.
   */
  const { sqlite, db, assignLead, checkRnrAutoReassignment, now } = await seedWorld();
  await assignLead(db, { leadId: LEAD, idempotencyKey: `new-lead:${LEAD}`, reason: "new_lead", actorId: "system:intake" });
  logRnrs(sqlite, now + HOUR, 3);

  const first = await checkRnrAutoReassignment(db, { leadId: LEAD, actorId: "system:dialler", asOf: now + 2 * HOUR });
  assert.equal(first.triggered, true);
  const settled = currentAssignee(sqlite);

  const again = await checkRnrAutoReassignment(db, { leadId: LEAD, actorId: "system:dialler", asOf: now + 2 * HOUR });
  assert.equal(again.triggered, false, "the same three RNRs must not rotate the lead a second time");
  assert.equal(currentAssignee(sqlite), settled, "a repeat call must not move the lead");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM lead_assignments WHERE lead_id=?").get(LEAD).n, 2,
    "exactly one new assignment row may exist after one rotation",
  );
});

test("every rotation is auditable and no lead is ever left with two current owners", async () => {
  const { sqlite, db, assignLead, checkRnrAutoReassignment } = await seedWorld();
  await assignLead(db, { leadId: LEAD, idempotencyKey: `new-lead:${LEAD}`, reason: "new_lead", actorId: "system:intake" });
  let logged = 0;
  for (let round = 1; round <= 3; round++) {
    const assignedAt = Number(sqlite.prepare("SELECT assigned_at FROM lead_work_items WHERE id=?").get(LEAD).assigned_at);
    logRnrs(sqlite, assignedAt + 1000, 3, logged);
    logged += 3;
    await checkRnrAutoReassignment(db, { leadId: LEAD, actorId: "system:dialler", asOf: assignedAt + 3 * HOUR });
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) n FROM lead_assignments WHERE lead_id=? AND status='current'").get(LEAD).n, 1,
      `round ${round}: exactly one assignment may be current`,
    );
  }
  const events = sqlite.prepare("SELECT event_type FROM lead_assignment_events WHERE lead_id=?").all(LEAD).map((r) => r.event_type);
  assert.equal(events.filter((e) => e === "reassigned").length, 3, "all three rotations must be in the audit trail");
  assert.equal(events.filter((e) => e === "supersede_reverted").length, 0, "no rotation may have failed and rolled back");
});
