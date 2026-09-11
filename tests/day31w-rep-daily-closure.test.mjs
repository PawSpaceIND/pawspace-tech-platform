/*
 * Day-31 wave 4: the telesales rep's daily closure gate and the talk-time ledger behind it.
 *
 * assigned leads + logged call segments -> readiness -> closure -> manager visibility.
 *
 * lib/rep-daily-closure-governance.ts and lib/talk-time-governance.ts had no test importing them.
 * Together they encode a real people-management rule: a rep may not close their day until every
 * lead they hold has been touched and 3.5 hours of talk time is on the clock. It is the control
 * that decides whether a lead is worked or quietly parked, so the failure that matters is a gate
 * that can be walked around - and the opposite one, a gate that will not open for a rep who did
 * genuinely do the work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31W_CLOSE_DB__", "__D31W_CLOSE_ENV__");

const REP = "asha.rep@pawspace.in";
const OTHER_REP = "bhavya.rep@pawspace.in";
const DAY = "2026-09-10";
const REQUIRED_MINUTES = 210;   // the real rule: 3.5 hours

async function seedClosure({ leads = 3 } = {}) {
  const { sqlite, db } = world("__D31W_CLOSE_DB__", "__D31W_CLOSE_ENV__");
  const closure = await import("../lib/rep-daily-closure-governance.ts");
  const talkTime = await import("../lib/talk-time-governance.ts");
  const assignment = await import("../lib/lead-assignment-governance.ts");
  const bot = await import("../lib/bot-call-disposition.ts");
  await closure.ensureRepDailyClosureTables(db);
  await talkTime.ensureTalkTimeTables(db);
  await assignment.ensureLeadAssignmentTables(db);
  await bot.ensureBotCallDispositionTables(db);
  await seedActors(sqlite, db, [
    { id: "u-a", email: REP, role: "sales_executive" },
    { id: "u-b", email: OTHER_REP, role: "sales_executive" },
  ]);

  const now = Date.parse(`${DAY}T10:00:00Z`);
  const leadIds = [];
  for (let i = 1; i <= leads; i++) {
    const leadId = `LEAD-CL-${i}`;
    leadIds.push(leadId);
    sqlite.prepare("INSERT INTO lead_assignments (id,idempotency_key,lead_id,employee_email,team_code,policy_id,policy_version,assignment_reason,status,assigned_at,detail_json,created_by,created_at) VALUES (?,?,?,?,'telesales_blr','LAP-1',1,'new_lead','current',?,'{}','system',?)")
      .run(`LAS-CL-${i}`, `key-cl-${i}`, leadId, REP, now, now);
  }
  return { sqlite, db, closure, talkTime, leadIds, now };
}

/** Log a real attempt against a lead, the way the dialler does when a rep works it. */
const touchLead = (sqlite, leadId, by = REP) =>
  sqlite.prepare("INSERT INTO lead_attempts (id,lead_id,channel,sequence_number,outcome,provider_status,created_by,created_at) VALUES (?,?,'call',1,'RNR','uat_queued',?,?)")
    .run(`ATT-${leadId}-${by}`, leadId, by, Date.parse(`${DAY}T11:00:00Z`));

const logTalk = (talkTime, db, minutes, rep = REP, callDate = DAY) =>
  talkTime.recordCallSegment(db, { repEmail: rep, callDate, durationMinutes: minutes, actorId: "system:dialler" });

test("a day with untouched leads cannot be closed", async () => {
  const { sqlite, db, closure, talkTime, leadIds } = await seedClosure();
  touchLead(sqlite, leadIds[0]);
  await logTalk(talkTime, db, REQUIRED_MINUTES);

  const readiness = await closure.dailyClosureReadiness(db, { repEmail: REP, closureDate: DAY });
  assert.equal(readiness.readyToClose, false);
  assert.equal(readiness.leadsTouched, 1);
  assert.equal(readiness.untouchedLeadIds.length, 2);
  assert.match(readiness.reasons.join(" "), /no logged activity/);

  await assert.rejects(
    () => closure.attemptDailyClosure(db, { repEmail: REP, closureDate: DAY, actorId: REP }),
    /cannot be closed yet/,
    "leads a rep holds must be worked before the day is signed off",
  );
});

test("a day below the talk-time floor cannot be closed", async () => {
  const { sqlite, db, closure, talkTime, leadIds } = await seedClosure();
  for (const leadId of leadIds) touchLead(sqlite, leadId);
  await logTalk(talkTime, db, REQUIRED_MINUTES - 1);

  const readiness = await closure.dailyClosureReadiness(db, { repEmail: REP, closureDate: DAY });
  assert.equal(readiness.talkTimeMet, false);
  assert.equal(readiness.talkTimeMinutes, 209);
  assert.equal(readiness.readyToClose, false, "one minute short is short");
  await assert.rejects(() => closure.attemptDailyClosure(db, { repEmail: REP, closureDate: DAY, actorId: REP }), /cannot be closed yet/);
});

test("a rep who did the work can close, and closing twice is a no-op", async () => {
  const { sqlite, db, closure, talkTime, leadIds } = await seedClosure();
  for (const leadId of leadIds) touchLead(sqlite, leadId);
  await logTalk(talkTime, db, 120);
  await logTalk(talkTime, db, 90);

  const readiness = await closure.dailyClosureReadiness(db, { repEmail: REP, closureDate: DAY });
  assert.equal(readiness.talkTimeMinutes, 210, "talk time accumulates across segments");
  assert.equal(readiness.readyToClose, true, `should be ready: ${readiness.reasons.join("; ")}`);

  const first = await closure.attemptDailyClosure(db, { repEmail: REP, closureDate: DAY, actorId: REP });
  assert.notEqual(first.alreadyClosed, true);
  const second = await closure.attemptDailyClosure(db, { repEmail: REP, closureDate: DAY, actorId: REP });
  assert.equal(second.alreadyClosed, true, "a day closes once");
});

test("another rep's calls and another day's calls do not count towards this closure", async () => {
  const { sqlite, db, closure, talkTime, leadIds } = await seedClosure();
  for (const leadId of leadIds) touchLead(sqlite, leadId);
  await logTalk(talkTime, db, 300, OTHER_REP);
  await logTalk(talkTime, db, 300, REP, "2026-09-09");
  await logTalk(talkTime, db, 60, REP);

  const readiness = await closure.dailyClosureReadiness(db, { repEmail: REP, closureDate: DAY });
  assert.equal(readiness.talkTimeMinutes, 60,
    "only this rep's calls, on this day, may count towards their own floor");
  assert.equal(readiness.readyToClose, false);
});

test("another rep touching my lead does not count as me working it", async () => {
  /*
   * The gate exists to make sure the rep who OWNS a lead worked it. An attempt logged by a
   * colleague on the same lead must not discharge that obligation.
   */
  const { sqlite, db, closure, talkTime, leadIds } = await seedClosure();
  touchLead(sqlite, leadIds[0]);
  touchLead(sqlite, leadIds[1]);
  touchLead(sqlite, leadIds[2], OTHER_REP);
  await logTalk(talkTime, db, REQUIRED_MINUTES);

  const readiness = await closure.dailyClosureReadiness(db, { repEmail: REP, closureDate: DAY });
  assert.deepEqual(readiness.untouchedLeadIds, [leadIds[2]]);
  assert.equal(readiness.readyToClose, false);
});

test("a rep holding no leads still owes the talk time", async () => {
  const { db, closure, talkTime } = await seedClosure({ leads: 0 });
  const empty = await closure.dailyClosureReadiness(db, { repEmail: REP, closureDate: DAY });
  assert.equal(empty.leadsTotal, 0);
  assert.equal(empty.readyToClose, false, "no leads is not a free day");
  await logTalk(talkTime, db, REQUIRED_MINUTES);
  assert.equal((await closure.dailyClosureReadiness(db, { repEmail: REP, closureDate: DAY })).readyToClose, true);
});

test("the talk-time ledger refuses input that is not a real call", async () => {
  const { db, talkTime } = await seedClosure();
  for (const [label, minutes] of [["zero", 0], ["negative", -30], ["not a number", Number.NaN], ["infinite", Infinity]]) {
    await assert.rejects(() => logTalk(talkTime, db, minutes), /positive number of minutes/, `a ${label} duration`);
  }
  await assert.rejects(() => logTalk(talkTime, db, 481), /8 hours/,
    "a single 8-hour-plus call is a data-entry error, and inflating talk time is how the gate gets gamed");
  await assert.rejects(
    () => talkTime.recordCallSegment(db, { repEmail: REP, callDate: "10-09-2026", durationMinutes: 30, actorId: "x" }),
    /real call date/,
  );
});

test("managers can see exactly who has not closed", async () => {
  const { sqlite, db, closure, talkTime, leadIds } = await seedClosure();
  for (const leadId of leadIds) touchLead(sqlite, leadId);
  await logTalk(talkTime, db, REQUIRED_MINUTES);
  await closure.attemptDailyClosure(db, { repEmail: REP, closureDate: DAY, actorId: REP });

  sqlite.prepare("INSERT INTO lead_assignments (id,idempotency_key,lead_id,employee_email,team_code,policy_id,policy_version,assignment_reason,status,assigned_at,detail_json,created_by,created_at) VALUES (?,?,?,?,'telesales_blr','LAP-1',1,'new_lead','current',?,'{}','system',?)")
    .run("LAS-CL-OTHER", "key-cl-other", "LEAD-CL-OTHER", OTHER_REP, Date.parse(`${DAY}T10:00:00Z`), Date.parse(`${DAY}T10:00:00Z`));

  const outstanding = await closure.repsWithIncompleteClosure(db, { closureDate: DAY });
  const emails = (Array.isArray(outstanding) ? outstanding : outstanding.reps ?? []).map((r) => r.repEmail ?? r.rep_email ?? r);
  assert.ok(emails.includes(OTHER_REP), `the rep who has not closed must be visible: ${JSON.stringify(outstanding)}`);
  assert.ok(!emails.includes(REP), "the rep who did close must not be chased");
});
