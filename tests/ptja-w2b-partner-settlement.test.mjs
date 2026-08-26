/**
 * PawSpace Total Journey Audit, Wave 2 Batch B — partner settlement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_W2B_DB__", "__PTJA_W2B_ENV__");

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

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_W2B_DB__ = db;
  globalThis.__PTJA_W2B_ENV__ = env;
  return { sqlite, db };
}

// =====================================================================================================
// PTJA-W2B-P05 — a plain READ rewrites the payable amount of an ALREADY-APPROVED partner settlement
//
// refreshPartnerSettlementStatements upserts with
//   ON CONFLICT(provider_id,period_code) DO UPDATE SET earned_amount=excluded.earned_amount,
//     payable_amount=excluded.earned_amount+partner_settlement_statements.adjustment_amount, ...
// carrying NO status predicate, so it rewrites a statement in any state - including 'approved'. And it
// is invoked unconditionally from the READ path: GET /api/partner-finance calls it before selecting.
//
// MEASURED: a statement was approved by a finance actor at Rs 5,000 and a sandbox payout instruction
// raised for Rs 5,000. The underlying earning was then corrected to Rs 50,000 - an ordinary rate
// correction - and a single GET rewrote the APPROVED statement to payable 50,000 while leaving
// approved_by and approved_at untouched. The payout instruction still said 5,000, so the two now
// disagree, and no partner_settlement_event recorded the rewrite at all. Whoever pays from the
// statement pays an amount no human approved; whoever pays from the instruction leaves the ledger
// unreconciled.
//
// The refresh runs across the whole period on every page load, so any change to training_session_earnings
// silently rewrites already-approved months for every provider.
//
// The correction is the guard the sibling read-model already has: lib/training-finance.ts protects a
// committed statement with status=CASE WHEN ... THEN old ELSE excluded END. A settlement that a human
// has approved is frozen; an open one still refreshes exactly as before.
// =====================================================================================================

async function settlementWorld() {
  const { sqlite, db } = world();
  const partner = await import("../lib/partner-settlement-governance.ts");
  await partner.refreshPartnerSettlementStatements(db, "2026-08");
  const now = Date.UTC(2026, 7, 10);
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_sessions (id TEXT PRIMARY KEY,provider_id TEXT,status TEXT,completed_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_session_earnings (session_id TEXT PRIMARY KEY,provider_id TEXT,gross_earning REAL,status TEXT,completed_at INTEGER)");
  sqlite.prepare("INSERT OR REPLACE INTO training_sessions (id,provider_id,status,completed_at) VALUES ('SES-1','PRV-T1','completed',?)").run(now);
  sqlite.prepare("INSERT OR REPLACE INTO training_session_earnings (session_id,provider_id,gross_earning,status,completed_at) VALUES ('SES-1','PRV-T1',5000,'earned',?)").run(now);
  const refresh = () => partner.refreshPartnerSettlementStatements(db, "2026-08");
  const statement = () => sqlite.prepare("SELECT id,earned_amount,payable_amount,status,approved_by FROM partner_settlement_statements WHERE provider_id='PRV-T1' AND period_code='2026-08'").get();
  return { sqlite, db, partner, refresh, statement };
}

test("W2B-P05: a read cannot rewrite an approved settlement's payable amount", async () => {
  const { sqlite, refresh, statement } = await settlementWorld();
  await refresh();
  const opened = statement();
  assert.ok(opened, "the statement is built from the earnings");
  assert.equal(Number(opened.payable_amount), 5000, "at the earned figure");

  // A human approves it, and a payout instruction is raised for that figure.
  sqlite.prepare("UPDATE partner_settlement_statements SET status='approved',policy_status='approved',approved_by='fin.ops@pawspace.test',approved_at=? WHERE id=?").run(Date.now(), opened.id);

  // The underlying earning is then corrected - an ordinary rate correction, no settlement action at all.
  sqlite.prepare("UPDATE training_session_earnings SET gross_earning=50000 WHERE session_id='SES-1'").run();
  await refresh();

  const after = statement();
  assert.equal(Number(after.payable_amount), 5000,
    `an approved settlement's payable amount must not move on a read: ${JSON.stringify(after)}`);
  assert.equal(String(after.approved_by), "fin.ops@pawspace.test", "and it still carries the approval it actually received");
});

test("W2B-P05: an unapproved settlement still refreshes from the earnings", async () => {
  // Non-vacuity. Freezing every statement would satisfy the case above and stop the read-model working.
  const { sqlite, refresh, statement } = await settlementWorld();
  await refresh();
  assert.equal(Number(statement().payable_amount), 5000, "the open statement starts at the earned figure");

  sqlite.prepare("UPDATE training_session_earnings SET gross_earning=7500 WHERE session_id='SES-1'").run();
  await refresh();
  assert.equal(Number(statement().payable_amount), 7500,
    "and an OPEN statement still follows the earnings, which is what the refresh is for");
});
