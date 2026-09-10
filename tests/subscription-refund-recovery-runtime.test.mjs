import test from "node:test";
import assert from "node:assert/strict";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__SUB_REFUND_DB__", "__SUB_REFUND_ENV__");
const { ensureSubscriptionBillingTables } = await import("../lib/subscription-billing.ts");
const { ensureGstAccountingTables } = await import("../lib/gst-accounting.ts");
const { processSubscriptionRefundEvent } = await import("../lib/subscription-refund-reconciliation.ts");

async function world() {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__SUB_REFUND_DB__ = db;
  globalThis.__SUB_REFUND_ENV__ = {};
  await ensureSubscriptionBillingTables(db);
  await ensureGstAccountingTables(db);
  sqlite.exec(`
    INSERT INTO subscription_billing_contracts (id,customer_id,source_booking_id,plan_code,environment,created_at,updated_at)
      VALUES ('S','C','B','PLAN','sandbox',1,1);
    INSERT INTO subscription_billing_cycles (id,contract_id,provider_payment_id,provider_event_id,amount_paise,currency,finance_invoice_id,created_at,updated_at)
      VALUES ('CY','S','pay_Test','evt_charge',100000,'INR','INV',1,1);
    INSERT INTO finance_invoices (id,invoice_number,entity_id,customer_id,source_type,source_id,source_event_key,policy_id,registration_id,issue_date,currency,subtotal,tax_total,total,tax_snapshot_json,created_by,created_at)
      VALUES ('INV','INV-1','E','C','subscription','CY','invoice-CY','P','R','2026-09-08','INR',1000,0,1000,'{}','test',1);
    INSERT INTO finance_document_series (id,entity_id,document_type,prefix,policy_id,updated_at)
      VALUES ('SER','E','credit_note','CN','P',1);
  `);
  return { sqlite, db };
}
const payload = { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_Test", payment_id: "pay_Test", amount: 20000, currency: "INR" } } } };

test("subscription refund retry after persistence failure cannot post a second credit note or journal under a fresh event ID", async () => {
  const { sqlite, db } = await world();
  db.onSql("INSERT INTO journal_transactions", () => { throw new Error("simulated refund persistence failure"); });
  await assert.rejects(() => processSubscriptionRefundEvent(db, payload, "evt_first"), /simulated refund persistence failure/);
  const recovered = await processSubscriptionRefundEvent(db, payload, "evt_redelivery");
  assert.equal(recovered.handled, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_adjustment_documents").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions WHERE status='POSTED'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT SUM(amount_paise) amount FROM subscription_provider_refunds").get().amount, 20000);
  assert.equal(sqlite.prepare("SELECT status FROM subscription_billing_cycles WHERE id='CY'").get().status, "partially_refunded");
  assert.equal(sqlite.prepare("SELECT SUM(CASE WHEN direction='DEBIT' THEN amount_paise ELSE -amount_paise END) variance FROM journal_entries").get().variance, 0);
});


test("refund reservation survives a status-write failure and retry repairs the same accounting", async () => {
  const { sqlite, db } = await world();
  db.onSql("UPDATE subscription_billing_cycles AS cy SET status=", () => { throw new Error("cycle status unavailable"); });
  await assert.rejects(() => processSubscriptionRefundEvent(db, payload, "evt_first"), /cycle status unavailable/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM subscription_provider_refunds").get().n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM subscription_billing_cycles").get().status, "paid");
  await processSubscriptionRefundEvent(db, payload, "evt_retry");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_adjustment_documents").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions").get().n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM subscription_billing_cycles").get().status, "partially_refunded");
});


test("distinct concurrent subscription refunds cannot exceed the captured cycle", async () => {
  const { sqlite, db } = await world();
  const event = id => ({ event: "refund.processed", payload: { refund: { entity: { id, payment_id: "pay_Test", amount: 60000, currency: "INR" } } } });
  const results = await Promise.allSettled([
    processSubscriptionRefundEvent(db, event("rfnd_A"), "evt_A"),
    processSubscriptionRefundEvent(db, event("rfnd_B"), "evt_B"),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.match(String(results.find(r => r.status === "rejected").reason), /subscription_refunds_exceed_cycle_capture/);
  assert.equal(sqlite.prepare("SELECT SUM(amount_paise) amount FROM subscription_provider_refunds").get().amount, 60000);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_adjustment_documents").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions").get().n, 1);
});
