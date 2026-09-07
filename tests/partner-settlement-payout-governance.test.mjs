import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as settlement from "../lib/partner-settlement-governance.ts";

function d1(sqlite) {
  const st = (sql, args = []) => ({
    bind: (...values) => st(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const out = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(out.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => st(sql), batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; } };
}
async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = d1(sqlite);
  await settlement.ensurePartnerSettlementTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO partner_settlement_statements (id,provider_id,period_code,currency,earned_amount,adjustment_amount,payable_amount,status,source_json,policy_status,created_at,updated_at) VALUES (?,?,?,?,?,0,?,'draft','[]','configuration_required',?,?)")
    .run("SET-1", "P-1", "2026-09", "INR", 10000, 10000, now, now);
  return { sqlite, db };
}

const MAKER = "finance.maker@pawspace.in";
const CHECKER_1 = "finance.checker1@pawspace.in";
const CHECKER_2 = "finance.checker2@pawspace.in";

test("sandbox settlement payout requires maker plus two distinct checkers", async () => {
  const { sqlite, db } = await world();
  await settlement.approveSettlementPolicy(db, { statementId: "SET-1", reason: "approved settlement policy", actor: MAKER });
  await settlement.approveSettlement(db, { statementId: "SET-1", actor: MAKER });
  const payout = await settlement.createSandboxPayoutInstruction(db, { statementId: "SET-1", idempotencyKey: "SET-1-IDEM", actor: MAKER });
  assert.equal(payout.environment, "sandbox");
  assert.equal(payout.liveMoney, false);
  assert.equal(payout.status, "approval_required");

  await assert.rejects(() => settlement.approveSandboxPayoutInstruction(db, { instructionId: payout.id, level: 1, actor: MAKER }), /must differ/);
  const l1 = await settlement.approveSandboxPayoutInstruction(db, { instructionId: payout.id, level: 1, actor: CHECKER_1 });
  assert.equal(l1.status, "awaiting_approval_2");
  await assert.rejects(() => settlement.approveSandboxPayoutInstruction(db, { instructionId: payout.id, level: 2, actor: CHECKER_1 }), /must differ/);
  await assert.rejects(() => settlement.approveSandboxPayoutInstruction(db, { instructionId: payout.id, level: 2, actor: MAKER }), /must differ/);
  const l2 = await settlement.approveSandboxPayoutInstruction(db, { instructionId: payout.id, level: 2, actor: CHECKER_2 });
  assert.equal(l2.status, "approved_sandbox");
  assert.equal(l2.liveMoney, false);

  const row = sqlite.prepare("SELECT p.environment,p.status,p.created_by,a.statement_approver,a.level_1_by,a.level_2_by FROM partner_payout_instructions p JOIN partner_payout_instruction_approvals a ON a.instruction_id=p.id WHERE p.id=?").get(payout.id);
  assert.equal(row.environment, "sandbox");
  assert.equal(row.status, "approved_sandbox");
  assert.equal(new Set([row.created_by.toLowerCase(), row.level_1_by.toLowerCase(), row.level_2_by.toLowerCase()]).size, 3);
});

test("settlement payout idempotency cannot cross statement ownership", async () => {
  const { sqlite, db } = await world();
  await settlement.approveSettlementPolicy(db, { statementId: "SET-1", reason: "approved settlement policy", actor: MAKER });
  await settlement.approveSettlement(db, { statementId: "SET-1", actor: MAKER });
  const first = await settlement.createSandboxPayoutInstruction(db, { statementId: "SET-1", idempotencyKey: "SHARED-IDEM", actor: MAKER });
  const replay = await settlement.createSandboxPayoutInstruction(db, { statementId: "SET-1", idempotencyKey: "SHARED-IDEM", actor: MAKER });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.id, first.id);

  const now = Date.now();
  sqlite.prepare("INSERT INTO partner_settlement_statements (id,provider_id,period_code,currency,earned_amount,adjustment_amount,payable_amount,status,source_json,policy_status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,0,?,'approved','[]','approved',?,?,?,?)")
    .run("SET-2", "P-2", "2026-09", "INR", 5000, 5000, MAKER, now, now, now);
  await assert.rejects(() => settlement.createSandboxPayoutInstruction(db, { statementId: "SET-2", idempotencyKey: "SHARED-IDEM", actor: MAKER }), /different settlement statement/);
});
