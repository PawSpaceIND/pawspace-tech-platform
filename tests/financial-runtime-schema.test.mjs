import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__FINANCE_RUNTIME_SCHEMA_DB__", "__FINANCE_RUNTIME_SCHEMA_ENV__");

const finance = await import("../lib/financial-lifecycle.ts");

function world() {
  const sqlite = freshSqlite();
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,status TEXT NOT NULL)");
  const db = makeD1(sqlite);
  globalThis.__FINANCE_RUNTIME_SCHEMA_DB__ = db;
  globalThis.__FINANCE_RUNTIME_SCHEMA_ENV__ = {};
  return { sqlite, db };
}

test("finance runtime initializer creates every direct lifecycle table on a fresh database", async () => {
  const { sqlite, db } = world();
  await finance.ensureFinancialLifecycleTables(db);

  const expected = [
    "payment_intents",
    "financial_outbox",
    "gateway_webhook_events",
    "gateway_object_identities",
    "journal_transactions",
    "journal_entries",
    "partner_earning_pending",
    "partner_payable_released",
    "payment_settlement_reconciliations",
    "razorpay_settlement_recon_runs",
  ];
  for (const table of expected) {
    const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.equal(row?.name, table, `${table} must be available without applying drizzle migrations first`);
  }

  const triggers = [
    "journal_entries_no_update",
    "journal_entries_no_delete",
    "journal_transactions_post_balanced",
    "journal_transactions_posted_immutable",
    "journal_transactions_no_delete",
    "partner_release_requires_completed_booking",
    "payment_settlement_reconciliations_no_update",
    "payment_settlement_reconciliations_no_delete",
  ];
  for (const trigger of triggers) {
    const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger);
    assert.equal(row?.name, trigger, `${trigger} must survive runtime fallback creation`);
  }
});

test("balanced journals work on a fresh database and remain immutable after posting", async () => {
  const { sqlite, db } = world();
  const posted = await finance.postBalancedJournal(db, {
    sourceType: "runtime_schema_test",
    sourceId: "source-1",
    sourceEventId: "runtime-schema-journal-1",
    narration: "fresh runtime journal",
    entries: [
      { accountCode: "1000_CASH", direction: "DEBIT", amountPaise: 12345 },
      { accountCode: "4000_REVENUE", direction: "CREDIT", amountPaise: 12345 },
    ],
  });
  assert.equal(posted.duplicate, false);
  assert.equal(sqlite.prepare("SELECT status FROM journal_transactions WHERE id=?").get(posted.transactionId)?.status, "POSTED");
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM journal_entries WHERE transaction_id=?").get(posted.transactionId)?.count, 2);
  assert.throws(
    () => sqlite.prepare("UPDATE journal_entries SET amount_paise=1 WHERE transaction_id=?").run(posted.transactionId),
    /posted journal entries are immutable/,
  );
});

test("runtime fallback preserves settlement evidence immutability", async () => {
  const { sqlite, db } = world();
  await finance.ensureFinancialLifecycleTables(db);
  const now = Date.now();
  sqlite.prepare(`INSERT INTO payment_intents
    (id,booking_id,customer_id,payment_id,provider,environment,idempotency_key,amount_paise,currency,state,order_request_state,gross_service_value_paise,platform_fee_paise,partner_earning_paise,tds_paise,gst_paise,commission_rate_bps,commission_rate_version,tax_rule_version,commercial_snapshot_json,created_at,updated_at)
    VALUES ('PI-RUNTIME','BKG-RUNTIME','CUS-RUNTIME','PAY-RUNTIME','razorpay','sandbox','runtime-idem',10000,'INR','CAPTURED','ORDER_CREATED',10000,1000,9000,0,0,1000,'v1','v1','{}',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO payment_settlement_reconciliations
    (id,provider,environment,payment_intent_id,gateway_payment_id,gateway_settlement_id,amount_paise,currency,settled_at,recon_date,raw_payload_json,observed_at)
    VALUES ('PSR-RUNTIME','razorpay','sandbox','PI-RUNTIME','pay_runtime','setl_runtime',10000,'INR',?,'2026-09-06','{}',?)`).run(now, now);
  assert.throws(
    () => sqlite.prepare("UPDATE payment_settlement_reconciliations SET gateway_settlement_id='setl_changed' WHERE id='PSR-RUNTIME'").run(),
    /payment settlement evidence is immutable/,
  );
  assert.throws(
    () => sqlite.prepare("DELETE FROM payment_settlement_reconciliations WHERE id='PSR-RUNTIME'").run(),
    /payment settlement evidence cannot be deleted/,
  );
});
