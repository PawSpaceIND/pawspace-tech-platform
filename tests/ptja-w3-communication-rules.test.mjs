/**
 * The nine communication rules. [PTJA-W3-CR]
 *
 * THE APPROVED DECISIONS, supplied by the business:
 *   new-customer welcome        APPROVE                once after verified signup / first valid lead, transactional and service-focused
 *   existing-customer re-engage APPROVE WITH CONTROLS  marketing consent; after 60 days inactive; max once per 30 days; opt-out and quiet hours
 *   Training rebooking          APPROVE                at 80% of sessions consumed, or 7 days before plan validity ends
 *   Boarding rebooking          APPROVE WITH CONTROLS  only after a completed stay, marketing consent, max once per 60 days
 *   Sitting rebooking           APPROVE WITH CONTROLS  only after completed service, marketing consent, max once per 60 days
 *   Dog Walking rebooking       APPROVE                at 80% of walks consumed, or 7 days before plan expiry
 *   Pet Taxi rebooking          DROP                   event-driven; transactional trip messages only
 *   Fresh Food reordering       APPROVE                from expected consumption/depletion, not a generic calendar campaign
 *   Relocation rebooking        DROP                   case-based and normally one-time; milestone and service follow-ups only
 *   Every promotional message must enforce consent, opt-out, frequency limits and deduplication
 *   SERVER-SIDE.
 *
 * WHAT WAS MEASURED BEFORE. lib/lifecycle-reminder-engine.ts already carries all nine as directory rows
 * seeded active:false, configuration_required:1 - the "nine rules awaiting approval" the audit
 * reported. Nothing had decided them. And while lib/communication-engine.ts enforces marketing consent,
 * opt-out, quiet hours and a GLOBAL weekly marketing cap, there is no PER-RULE frequency limit, so
 * "max once per 60 days" had nowhere to live. A dropped rule was also indistinguishable from an
 * undecided one: both sat inactive, and either could be switched on by anybody with the save route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_CR_DB__", "__PTJA_CR_ENV__");

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

const attempt = (promise) => promise.then(
  (value) => ({ ok: true, value }),
  async (error) => ({ ok: false, status: error instanceof Response ? error.status : 0, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error) }),
);

const DAY = 86_400_000;
const CUSTOMER = "CUS-1";

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_CR_DB__ = db;
  globalThis.__PTJA_CR_ENV__ = {};
  const decisions = await import("../lib/communication-rule-decisions.ts");
  await decisions.applyApprovedCommunicationRules(db, "founder@pawspace.test");
  return { sqlite, db, decisions };
}

const ruleRow = (sqlite, id) => sqlite.prepare("SELECT * FROM lifecycle_reminder_rules WHERE id=?").get(id);

// ---------------------------------------------------------------------------------------------------
// The decisions themselves
// ---------------------------------------------------------------------------------------------------

test("CR-01: every one of the nine rules carries a decision, none is left undecided", async () => {
  const { sqlite, decisions } = await world();
  for (const rule of decisions.APPROVED_COMMUNICATION_RULES) {
    const row = ruleRow(sqlite, rule.ruleId);
    assert.ok(row, `${rule.ruleId} exists in the directory`);
    assert.equal(Number(row.configuration_required), 0,
      `${rule.ruleId} must no longer be "awaiting approval": ${JSON.stringify(row).slice(0, 200)}`);
  }
  assert.equal(decisions.APPROVED_COMMUNICATION_RULES.length, 9, "all nine are decided");
});

test("CR-02: the approved rules are active and the dropped ones are not", async () => {
  const { sqlite, decisions } = await world();
  for (const rule of decisions.APPROVED_COMMUNICATION_RULES) {
    const row = ruleRow(sqlite, rule.ruleId);
    const expected = rule.decision === "drop" ? 0 : 1;
    assert.equal(Number(row.active), expected,
      `${rule.ruleId} (${rule.decision}) active should be ${expected}: ${JSON.stringify(row).slice(0, 200)}`);
  }
  assert.deepEqual(decisions.APPROVED_COMMUNICATION_RULES.filter((rule) => rule.decision === "drop").map((rule) => rule.ruleId).sort(),
    ["rule-pet_taxi-rebook", "rule-relocation-rebook"], "exactly Pet Taxi and Relocation are dropped");
});

test("CR-03: a dropped rule cannot be switched back on through the save route", async () => {
  // A dropped rule was previously indistinguishable from an undecided one - both inactive, both
  // switchable by anybody with the save route. A DECISION has to be harder to reverse than a default.
  const { db } = await world();
  const engine = await import("../lib/lifecycle-reminder-engine.ts");
  const refused = await attempt(engine.saveLifecycleReminderRule(db, {
    id: "rule-pet_taxi-rebook", delayDays: 30, repeatDays: 30, templateKey: "pet_taxi_rebooking_reminder",
    active: true, reason: "Turning taxi rebooking on for a campaign", actorId: "growth@pawspace.test",
  }));
  assert.equal(refused.ok, false, `a dropped rule must not be activated: ${JSON.stringify(refused).slice(0, 300)}`);
  assert.match(String(refused.message), /dropped|not approved/i, `and say why: ${String(refused.message).slice(0, 200)}`);
});

test("CR-04: an approved rule can still be tuned through the save route", async () => {
  // Non-vacuity for CR-03. Refusing every save would satisfy it and freeze the directory.
  const { db } = await world();
  const engine = await import("../lib/lifecycle-reminder-engine.ts");
  const saved = await attempt(engine.saveLifecycleReminderRule(db, {
    id: "rule-boarding-rebook", delayDays: 45, repeatDays: 60, templateKey: "boarding_rebooking_reminder",
    active: true, reason: "Boarding rebooking window widened after the festive season", actorId: "growth@pawspace.test",
  }));
  assert.equal(saved.ok, true, `an approved rule is still tunable: ${JSON.stringify(saved).slice(0, 300)}`);
});

// ---------------------------------------------------------------------------------------------------
// The controls, enforced server-side
// ---------------------------------------------------------------------------------------------------

const send = (decisions, db, ruleId, over = {}) => attempt(decisions.assertCommunicationRuleAllowed(db, {
  ruleId, customerId: CUSTOMER, marketingConsent: true, optedOut: false,
  lastCompletedServiceAt: Date.now() - 90 * DAY, ...over,
}));

test("CR-05: a promotional rule is refused without marketing consent", async () => {
  const { db, decisions } = await world();
  for (const ruleId of ["rule-existing-customer", "rule-boarding-rebook", "rule-sitting-rebook"]) {
    const refused = await send(decisions, db, ruleId, { marketingConsent: false });
    assert.equal(refused.ok, false, `${ruleId} needs marketing consent: ${JSON.stringify(refused).slice(0, 250)}`);
  }
});

test("CR-06: an opt-out refuses every rule, promotional or not", async () => {
  const { db, decisions } = await world();
  for (const ruleId of ["rule-new-customer", "rule-training-rebook", "rule-food-rebook"]) {
    const refused = await send(decisions, db, ruleId, { optedOut: true });
    assert.equal(refused.ok, false, `${ruleId} must honour an opt-out: ${JSON.stringify(refused).slice(0, 250)}`);
  }
});

test("CR-07: the welcome rule fires once, and only once", async () => {
  const { db, decisions } = await world();
  const first = await send(decisions, db, "rule-new-customer");
  assert.equal(first.ok, true, `the welcome sends: ${JSON.stringify(first).slice(0, 250)}`);
  await decisions.recordCommunicationRuleSend(db, { ruleId: "rule-new-customer", customerId: CUSTOMER });
  const second = await send(decisions, db, "rule-new-customer");
  assert.equal(second.ok, false, `and never again: ${JSON.stringify(second).slice(0, 250)}`);
});

test("CR-08: re-engagement needs 60 days of inactivity and then at most one per 30", async () => {
  const { db, decisions } = await world();
  const tooSoon = await send(decisions, db, "rule-existing-customer", { lastCompletedServiceAt: Date.now() - 30 * DAY });
  assert.equal(tooSoon.ok, false, `an active customer is not "re-engaged": ${JSON.stringify(tooSoon).slice(0, 250)}`);
  const due = await send(decisions, db, "rule-existing-customer", { lastCompletedServiceAt: Date.now() - 70 * DAY });
  assert.equal(due.ok, true, `seventy days of silence is: ${JSON.stringify(due).slice(0, 250)}`);
  await decisions.recordCommunicationRuleSend(db, { ruleId: "rule-existing-customer", customerId: CUSTOMER });
  const again = await send(decisions, db, "rule-existing-customer", { lastCompletedServiceAt: Date.now() - 70 * DAY });
  assert.equal(again.ok, false, `and not twice in a month: ${JSON.stringify(again).slice(0, 250)}`);
});

test("CR-09: Boarding and Sitting rebooking need a completed service and hold to 60 days", async () => {
  const { db, decisions } = await world();
  for (const ruleId of ["rule-boarding-rebook", "rule-sitting-rebook"]) {
    const noService = await send(decisions, db, ruleId, { lastCompletedServiceAt: null });
    assert.equal(noService.ok, false, `${ruleId} needs a completed service first: ${JSON.stringify(noService).slice(0, 250)}`);
    const allowed = await send(decisions, db, ruleId);
    assert.equal(allowed.ok, true, `${ruleId} sends after one: ${JSON.stringify(allowed).slice(0, 250)}`);
    await decisions.recordCommunicationRuleSend(db, { ruleId, customerId: CUSTOMER });
    const tooSoon = await send(decisions, db, ruleId);
    assert.equal(tooSoon.ok, false, `${ruleId} holds to one per sixty days`);
    const later = await send(decisions, db, ruleId, { now: Date.now() + 61 * DAY });
    assert.equal(later.ok, true, `${ruleId} may send again after sixty-one days: ${JSON.stringify(later).slice(0, 250)}`);
  }
});

test("CR-10: Training and Walking rebooking fire on consumption or expiry, not on a calendar", async () => {
  const { db, decisions } = await world();
  for (const ruleId of ["rule-training-rebook", "rule-dog_walking-rebook"]) {
    const early = await send(decisions, db, ruleId, { fractionConsumed: 0.5, daysUntilPlanExpiry: 40 });
    assert.equal(early.ok, false, `${ruleId} does not chase a half-used plan: ${JSON.stringify(early).slice(0, 250)}`);
    const consumed = await send(decisions, db, ruleId, { fractionConsumed: 0.8, daysUntilPlanExpiry: 40 });
    assert.equal(consumed.ok, true, `${ruleId} fires at eighty per cent consumed: ${JSON.stringify(consumed).slice(0, 250)}`);
    const expiring = await send(decisions, db, ruleId, { fractionConsumed: 0.2, daysUntilPlanExpiry: 6 });
    assert.equal(expiring.ok, true, `${ruleId} also fires seven days before expiry: ${JSON.stringify(expiring).slice(0, 250)}`);
  }
});

test("CR-11: Fresh Food reordering is depletion-driven, not a calendar campaign", async () => {
  const { db, decisions } = await world();
  const early = await send(decisions, db, "rule-food-rebook", { fractionConsumed: 0.3 });
  assert.equal(early.ok, false, `a full bag is not a reorder prompt: ${JSON.stringify(early).slice(0, 250)}`);
  const depleted = await send(decisions, db, "rule-food-rebook", { fractionConsumed: 0.85 });
  assert.equal(depleted.ok, true, `a nearly empty one is: ${JSON.stringify(depleted).slice(0, 250)}`);
  const noSignal = await send(decisions, db, "rule-food-rebook", { fractionConsumed: null });
  assert.equal(noSignal.ok, false, `and with NO consumption signal it must not fire on a date alone: ${JSON.stringify(noSignal).slice(0, 250)}`);
});

test("CR-12: a dropped rule is refused at send time even if a row says active", async () => {
  // Belt and braces. The directory is data; somebody could edit the row directly.
  const { sqlite, db, decisions } = await world();
  sqlite.prepare("UPDATE lifecycle_reminder_rules SET active=1,configuration_required=0 WHERE id='rule-relocation-rebook'").run();
  const refused = await send(decisions, db, "rule-relocation-rebook");
  assert.equal(refused.ok, false, `a dropped rule never sends: ${JSON.stringify(refused).slice(0, 250)}`);
});

test("CR-13: the same rule and customer cannot be sent twice on one deduplication key", async () => {
  const { db, decisions } = await world();
  await decisions.recordCommunicationRuleSend(db, { ruleId: "rule-training-rebook", customerId: CUSTOMER, dedupeKey: "cycle-1" });
  const repeat = await decisions.recordCommunicationRuleSend(db, { ruleId: "rule-training-rebook", customerId: CUSTOMER, dedupeKey: "cycle-1" });
  assert.equal(repeat.duplicate, true, `a replayed send is recognised, not counted twice: ${JSON.stringify(repeat)}`);
});

test("CR-14: an unknown rule is refused rather than treated as unrestricted", async () => {
  const { db, decisions } = await world();
  const refused = await send(decisions, db, "rule-something-nobody-decided");
  assert.equal(refused.ok, false, `a rule nobody decided must not send: ${JSON.stringify(refused).slice(0, 250)}`);
});
