/*
 * Day-31 wave 8: refunding a subscription against the entitlement it actually bought.
 *
 * billing cycle -> entitlement grant -> credits used / unused -> refund validation -> reserved
 * allocation -> finalisation.
 *
 * lib/subscription-entitlement-renewal.ts (21KB) had no test importing it. A grooming
 * subscription is prepaid: the customer hands over money now for N sessions later. Refunding it
 * is therefore not "give some money back", it is "give back exactly the sessions they have not
 * had" - and the two failure directions both cost real money:
 *
 *   refund MORE than the unused credits  -> the platform pays for sessions already delivered
 *   refund an amount that is not a whole credit -> the entitlement and the cash stop agreeing,
 *   and the next refund is computed from a ledger that no longer reconciles
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31X_SUB_DB__", "__D31X_SUB_ENV__");

const CONTRACT = "SUBC-001";
const CYCLE = "CYC-001";
const SUBSCRIPTION = "SUB-001";
const CUSTOMER = "CUS-SUB-001";
const CREDITS = 10;
const CYCLE_PAISE = 1_000_000;            // Rs 10,000 for 10 sessions -> Rs 1,000 a session
const PER_CREDIT = CYCLE_PAISE / CREDITS; // 100,000 paise

async function seedSubscription({ reserved = 0, consumed = 0, status = "active" } = {}) {
  const { sqlite, db } = world("__D31X_SUB_DB__", "__D31X_SUB_ENV__");
  const ent = await import("../lib/subscription-entitlement-renewal.ts");
  // The billing cycle table is owned by the billing module, not the entitlement one.
  const { ensureSubscriptionBillingTables } = await import("../lib/subscription-billing.ts");
  await ensureSubscriptionBillingTables(db);
  await ent.ensureSubscriptionEntitlementRenewalTables(db);
  const now = Date.now();

  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,service_package_code TEXT NOT NULL,total_sessions INTEGER NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 0,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_booking_id TEXT NOT NULL UNIQUE,catalogue_version TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES (?,?,'groom-10','grooming-basic',?,?,?,?,?,?,?,'v1',?,?)")
    .run(SUBSCRIPTION, CUSTOMER, CREDITS, reserved, consumed, status, now, now + 365 * 86400000, `BK-${SUBSCRIPTION}`, now, now);
  sqlite.prepare("INSERT INTO subscription_billing_cycles (id,contract_id,provider_payment_id,provider_event_id,period_start,period_end,amount_paise,currency,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'INR','paid',?,?)")
    .run(CYCLE, CONTRACT, "pay_sub_001", "evt_sub_001", now, now + 30 * 86400000, CYCLE_PAISE, now, now);
  sqlite.prepare("INSERT INTO subscription_entitlement_grants (cycle_id,contract_id,entitlement_subscription_id,credits_granted,amount_paise,total_before,period_end,status,created_at,updated_at) VALUES (?,?,?,?,?,0,?,'applied',?,?)")
    .run(CYCLE, CONTRACT, SUBSCRIPTION, CREDITS, CYCLE_PAISE, now + 30 * 86400000, now, now);
  return { sqlite, db, ent };
}

/** A real maker-requested refund case, which is what the checker approves against. */
const requestRefund = (sqlite, id, amountPaise, requestedBy = "ops.maker@pawspace.in") =>
  sqlite.prepare("INSERT INTO subscription_refund_cases (id,contract_id,cycle_id,amount_paise,reason,status,requested_by,provider_payment_id,created_at,updated_at) VALUES (?,?,?,?,?,'requested',?,?,?,?)")
    .run(id, CONTRACT, CYCLE, amountPaise, "Day-31 unused sessions refund", requestedBy, "pay_sub_001", Date.now(), Date.now());

const validate = (ent, db, amountPaise) =>
  ent.validateSubscriptionRefundAgainstUnusedEntitlement(db, { cycleId: CYCLE, amountPaise });

test("a fully unused cycle can be refunded in whole credits, up to all of them", async () => {
  const { db, ent } = await seedSubscription();
  for (const credits of [1, 3, 10]) {
    const result = await validate(ent, db, credits * PER_CREDIT);
    assert.equal(result.credits, credits, `Rs ${(credits * PER_CREDIT) / 100} is ${credits} session(s)`);
    assert.equal(result.unusedCredits, CREDITS);
    assert.equal(result.usedCredits, 0);
  }
});

test("sessions already delivered cannot be refunded", async () => {
  /*
   * Four of ten sessions consumed. Six are still owed, so at most six may come back - refunding
   * the full cycle would mean the platform paying for four grooms it already delivered.
   */
  const { db, ent } = await seedSubscription({ consumed: 4 });
  const six = await validate(ent, db, 6 * PER_CREDIT);
  assert.equal(six.credits, 6);
  assert.equal(six.usedCredits, 4);
  assert.equal(six.unusedCredits, 6);

  await assert.rejects(() => validate(ent, db, 7 * PER_CREDIT), /exceeds_unused_entitlement/,
    "a seventh session has already been delivered");
  await assert.rejects(() => validate(ent, db, CYCLE_PAISE), /exceeds_unused_entitlement/,
    "and the whole cycle certainly cannot come back");
});

test("a session already booked is committed, not refundable", async () => {
  /*
   * A reserved session is one the customer has an appointment for. It is not "unused" in any
   * sense the platform can hand back without cancelling the appointment first.
   */
  const { db, ent } = await seedSubscription({ reserved: 3, consumed: 2 });
  const result = await validate(ent, db, 5 * PER_CREDIT);
  assert.equal(result.credits, 5, "ten less three reserved less two consumed is five");
  await assert.rejects(() => validate(ent, db, 6 * PER_CREDIT), /exceeds_unused_entitlement/);
});

test("a cycle with nothing left refuses any refund at all", async () => {
  const { db, ent } = await seedSubscription({ consumed: CREDITS });
  await assert.rejects(() => validate(ent, db, PER_CREDIT), /no_unused_entitlement/,
    "every session was delivered - there is nothing to give back");
  await assert.rejects(() => validate(ent, db, 1), /no_unused_entitlement/);
});

test("a refund must be a whole number of sessions, not an arbitrary amount", async () => {
  /*
   * The entitlement ledger counts credits, the gateway moves paise. If a refund is allowed that
   * does not correspond to a whole credit, the two stop agreeing and every later refund on the
   * cycle is computed from a ledger that no longer reconciles.
   */
  const { db, ent } = await seedSubscription();
  for (const amount of [1, 99_999, PER_CREDIT + 1, PER_CREDIT - 1, 150_000]) {
    await assert.rejects(() => validate(ent, db, amount), /must_match_unused_entitlement_units/,
      `Rs ${amount / 100} is not a whole number of sessions`);
  }
});

test("a refund of zero or a negative amount is not a refund", async () => {
  const { db, ent } = await seedSubscription();
  for (const amount of [0, -100_000]) {
    await assert.rejects(() => validate(ent, db, amount), Error, `${amount} paise must be refused`);
  }
});

test("reserving a refund reduces what the NEXT refund may take", async () => {
  /*
   * Two partial refunds must not each be measured against the full unused entitlement - that is
   * how a cycle gets refunded twice over.
   */
  const { sqlite, db, ent } = await seedSubscription();
  requestRefund(sqlite, "RC-1", 6 * PER_CREDIT);
  await ent.approveSubscriptionRefundAgainstUnusedEntitlement(db, { refundCaseId: "RC-1", actor: "finance.checker@pawspace.in" });

  const grant = sqlite.prepare("SELECT refund_reserved_credits FROM subscription_entitlement_grants WHERE cycle_id=?").get(CYCLE);
  assert.equal(Number(grant.refund_reserved_credits), 6, "six credits are now spoken for");

  const remaining = await validate(ent, db, 4 * PER_CREDIT);
  assert.equal(remaining.credits, 4, "four sessions remain refundable");
  await assert.rejects(() => validate(ent, db, 5 * PER_CREDIT), /exceeds_unused_entitlement/,
    "the six already reserved must not be refundable a second time");
});

test("a refund cannot be approved by the person who asked for it", async () => {
  const { sqlite, db, ent } = await seedSubscription();
  requestRefund(sqlite, "RC-SELF", 2 * PER_CREDIT, "ops.maker@pawspace.in");
  await assert.rejects(
    () => ent.approveSubscriptionRefundAgainstUnusedEntitlement(db, { refundCaseId: "RC-SELF", actor: "ops.maker@pawspace.in" }),
    /refund_self_approval_forbidden/,
    "one person must not be able to move money out on their own",
  );
  assert.equal(
    sqlite.prepare("SELECT status FROM subscription_refund_cases WHERE id=?").get("RC-SELF").status, "requested",
    "and the refusal must leave the case untouched",
  );
});

test("approving the same refund case twice reserves the credits once", async () => {
  const { sqlite, db, ent } = await seedSubscription();
  requestRefund(sqlite, "RC-DUP", 3 * PER_CREDIT);
  const args = { refundCaseId: "RC-DUP", actor: "finance.checker@pawspace.in" };
  await ent.approveSubscriptionRefundAgainstUnusedEntitlement(db, args);
  await ent.approveSubscriptionRefundAgainstUnusedEntitlement(db, args);

  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM subscription_refund_entitlement_allocations WHERE cycle_id=?").get(CYCLE).n, 1);
  assert.equal(
    Number(sqlite.prepare("SELECT refund_reserved_credits FROM subscription_entitlement_grants WHERE cycle_id=?").get(CYCLE).refund_reserved_credits), 3,
    "a replayed approval must not reserve the credits twice",
  );
});

test("concurrent refund approvals cannot together exceed the entitlement", async () => {
  /*
   * Two checkers approving two different six-credit refund cases against a ten-credit cycle at
   * the same moment. The compare-and-set on the grant row is what stops twelve credits leaving.
   */
  const { sqlite, db, ent } = await seedSubscription();
  requestRefund(sqlite, "RC-RACE-A", 6 * PER_CREDIT);
  requestRefund(sqlite, "RC-RACE-B", 6 * PER_CREDIT);
  const outcomes = await Promise.all(["RC-RACE-A", "RC-RACE-B"].map((refundCaseId) =>
    ent.approveSubscriptionRefundAgainstUnusedEntitlement(db, { refundCaseId, actor: "finance.checker@pawspace.in" })
      .then(() => "ok", (error) => String(error.message))));

  const reserved = Number(sqlite.prepare("SELECT refund_reserved_credits FROM subscription_entitlement_grants WHERE cycle_id=?").get(CYCLE).refund_reserved_credits);
  assert.ok(reserved <= CREDITS, `never more than the whole cycle may be reserved, got ${reserved} (${outcomes})`);
  assert.equal(reserved, 6, `exactly one of two concurrent six-credit refunds may win: ${outcomes}`);
  assert.equal(outcomes.filter((o) => o === "ok").length, 1, `one approval, one refusal: ${outcomes}`);
});

test("a refund against a cycle that has no applied grant is refused", async () => {
  const { sqlite, db, ent } = await seedSubscription();
  sqlite.exec("UPDATE subscription_entitlement_grants SET status='reversed'");
  await assert.rejects(() => validate(ent, db, PER_CREDIT), /grant_missing/,
    "there is no entitlement to refund against");
  await assert.rejects(
    () => ent.validateSubscriptionRefundAgainstUnusedEntitlement(db, { cycleId: "CYC-DOES-NOT-EXIST", amountPaise: PER_CREDIT }),
    /grant_missing/,
  );
});
