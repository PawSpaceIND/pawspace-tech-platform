/**
 * P0 - partner settlement: ONE definition of payable_amount, and a READ that stores nothing.
 *
 * Two code paths computed payable_amount differently, and one of them ran on a read:
 *
 *   addSettlementAdjustment              payable = MAX(0, earned + adjustment)      (clamped)
 *   refreshPartnerSettlementStatements   payable = earned + adjustment              (unclamped)
 *
 * refreshPartnerSettlementStatements is called by GET /api/partner-finance, i.e. every time an
 * operator merely OPENS /team/finance/partners. Reproduced on SET-2026-08-groom_arun: earned 909.30,
 * a -2000 deduction POSTed, payable stored as 0 - then rewritten to -1090.70 by a plain GET, so the
 * screen reported a negative amount payable to a provider and no operator had done anything.
 *
 * The agreed definition is the SIGNED net, ROUND(earned + adjustment, 2), never clamped: a deduction
 * larger than the earnings is a real business state (the provider owes PawSpace), and MAX(0,...)
 * destroys that residual at the moment of storage. Nothing pays a negative statement - approveSettlement
 * refuses it by amount, which is the guard this suite also pins down.
 *
 * Everything here EXECUTES the real functions against a real SQLite-backed D1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const PERIOD = "2026-08";
const WHEN = Date.UTC(2026, 7, 12); // inside 2026-08
const OPERATOR = "finance.ops@pawspace.in";
const APPROVER = "finance.approver@pawspace.in";

async function world() {
  const harness = freshCountingD1();
  const { sqlite, db } = harness;
  const settlement = await importLibModule("partner-settlement-governance");
  await settlement.ensurePartnerSettlementTables(db);
  // The only earnings source this suite needs; the refresh reads provider/service/net payout/computed_at.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS provider_payout_computations (
    booking_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, service_code TEXT NOT NULL,
    provider_net_payout REAL NOT NULL, computed_at INTEGER NOT NULL)`);
  const earn = (providerId, service, amount) =>
    sqlite.prepare("INSERT OR REPLACE INTO provider_payout_computations (booking_id,provider_id,service_code,provider_net_payout,computed_at) VALUES (?,?,?,?,?)")
      .run(`BK-${providerId}`, providerId, service, amount, WHEN);
  const statementId = (providerId) => `SET-${PERIOD}-${providerId}`;
  // The read path: exactly what GET /api/partner-finance does before it selects.
  const openTheScreen = () => settlement.refreshPartnerSettlementStatements(db, PERIOD);
  const row = (providerId) => sqlite.prepare("SELECT * FROM partner_settlement_statements WHERE id=?").get(statementId(providerId));
  return { ...harness, settlement, earn, row, statementId, openTheScreen };
}

/** A row reduced to bytes, so "unchanged" means every column - updated_at included. */
const bytes = (r) => JSON.stringify(r);

test("POST a deduction larger than the earnings, then open the screen twice: nothing moves", async () => {
  const { db, settlement, earn, row, statementId, openTheScreen } = await world();

  // The two statements the defect was reproduced on.
  earn("groom_arun", "grooming", 909.30);
  earn("walk_nisha", "dog_walking", 362.96);
  await openTheScreen();
  assert.equal(Number(row("groom_arun").earned_amount), 909.30);
  assert.equal(Number(row("walk_nisha").earned_amount), 362.96);

  for (const { provider, earned, deduction } of [
    { provider: "groom_arun", earned: 909.30, deduction: -2000 },
    { provider: "walk_nisha", earned: 362.96, deduction: -1000 },
  ]) {
    await settlement.addSettlementAdjustment(db, {
      statementId: statementId(provider), type: "deduction", amount: deduction,
      reason: "recovering an advance paid to this provider", actor: OPERATOR,
    });

    // 1. Snapshot the row the POST left behind.
    const afterPost = row(provider);
    const snapshot = bytes(afterPost);
    assert.equal(Number(afterPost.adjustment_amount), deduction, `${provider}: the operator's adjustment is stored as entered`);

    // 2. Opening the screen must not change any stored amount. Twice, byte for byte.
    await openTheScreen();
    assert.equal(bytes(row(provider)), snapshot,
      `${provider}: a plain read rewrote the statement\n  after POST: ${snapshot}\n  after GET : ${bytes(row(provider))}`);
    await openTheScreen();
    assert.equal(bytes(row(provider)), snapshot,
      `${provider}: the read path is not idempotent - a second read moved the row again\n  expected: ${snapshot}\n  got     : ${bytes(row(provider))}`);

    // 3. And what both paths agree on is THE definition: the signed net, not a clamped 0.
    const settled = row(provider);
    const agreed = settlement.settlementPayableAmount(earned, deduction);
    assert.ok(agreed < 0, `${provider}: this case only means something if the deduction exceeds the earnings`);
    assert.equal(Number(settled.payable_amount), agreed,
      `${provider}: payable must be the agreed definition ROUND(earned+adjustment,2)=${agreed}, got ${settled.payable_amount}`);
    assert.equal(Number(settled.payable_amount),
      settlement.settlementPayableAmount(Number(settled.earned_amount), Number(settled.adjustment_amount)),
      `${provider}: stored payable disagrees with the one definition of payable_amount`);
  }
});

test("a normal adjustment still applies, and still survives the read", async () => {
  const { db, settlement, earn, row, statementId, openTheScreen } = await world();
  earn("host_maya", "boarding", 5000);
  await openTheScreen();
  assert.equal(Number(row("host_maya").payable_amount), 5000, "an unadjusted statement is payable at the earned figure");

  await settlement.addSettlementAdjustment(db, {
    statementId: statementId("host_maya"), type: "incentive", amount: 2500,
    reason: "festive performance incentive approved by ops", actor: OPERATOR,
  });
  assert.equal(Number(row("host_maya").adjustment_amount), 2500);
  assert.equal(Number(row("host_maya").payable_amount), 7500, "payable = earned + adjustment");

  const snapshot = bytes(row("host_maya"));
  await openTheScreen();
  assert.equal(bytes(row("host_maya")), snapshot, "the read must not touch an adjusted statement either");

  // A second adjustment nets against the first, under the same definition.
  await settlement.addSettlementAdjustment(db, {
    statementId: statementId("host_maya"), type: "deduction", amount: -500.25,
    reason: "damage recovery agreed with the host", actor: OPERATOR,
  });
  const netted = row("host_maya");
  assert.equal(Number(netted.adjustment_amount), 1999.75);
  assert.equal(Number(netted.payable_amount), settlement.settlementPayableAmount(5000, 1999.75));
  assert.equal(Number(netted.payable_amount), 6999.75);
  await openTheScreen();
  assert.equal(bytes(row("host_maya")), bytes(netted), "and that netted figure is stable across a read");
});

test("the refresh still follows the earnings when they genuinely move (non-vacuity)", async () => {
  // Freezing every write would satisfy the idempotence tests above and quietly break the read model.
  const { sqlite, settlement, earn, row, openTheScreen } = await world();
  earn("host_maya", "boarding", 5000);
  await openTheScreen();
  const before = row("host_maya");

  sqlite.prepare("UPDATE provider_payout_computations SET provider_net_payout=7500 WHERE provider_id='host_maya'").run();
  await openTheScreen();
  const after = row("host_maya");
  assert.equal(Number(after.earned_amount), 7500, "an open statement still follows the earnings");
  assert.equal(Number(after.payable_amount), settlement.settlementPayableAmount(7500, 0));
  assert.notEqual(bytes(after), bytes(before), "a real change is still written");

  // ... and once written it is stable again.
  await openTheScreen();
  assert.equal(bytes(row("host_maya")), bytes(after), "a repeated read after a real change stores nothing further");
});

test("approveSettlement still refuses an unpayable amount, and still approves a payable one", async () => {
  const { db, settlement, earn, row, statementId, openTheScreen } = await world();
  earn("groom_arun", "grooming", 909.30);
  earn("host_maya", "boarding", 5000);
  await openTheScreen();

  await settlement.addSettlementAdjustment(db, {
    statementId: statementId("groom_arun"), type: "deduction", amount: -2000,
    reason: "recovering an advance paid to this provider", actor: OPERATOR,
  });
  await settlement.approveSettlementPolicy(db, { statementId: statementId("groom_arun"), reason: "payout policy configured for this partner", actor: OPERATOR });
  await assert.rejects(
    () => settlement.approveSettlement(db, { statementId: statementId("groom_arun"), actor: APPROVER }),
    /cannot be negative/,
    "a statement the provider owes on must not be approvable",
  );
  assert.equal(String(row("groom_arun").status), "draft", "and it stays unapproved");
  assert.equal(row("groom_arun").approved_by, null);

  // The refusal must be about the amount, not about settlements in general.
  await settlement.approveSettlementPolicy(db, { statementId: statementId("host_maya"), reason: "payout policy configured for this partner", actor: OPERATOR });
  const approved = await settlement.approveSettlement(db, { statementId: statementId("host_maya"), actor: APPROVER });
  assert.equal(approved.status, "approved");
  assert.equal(String(row("host_maya").status), "approved");

  // And an approved statement is frozen against the read path.
  const frozen = bytes(row("host_maya"));
  await openTheScreen();
  assert.equal(bytes(row("host_maya")), frozen, "a read cannot rewrite approved money");
});
