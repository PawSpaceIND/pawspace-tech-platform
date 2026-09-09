import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

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
      depth++;
      try {
        const out = [];
        for (const item of items) out.push(await item.run());
        if (outer) sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        if (outer) sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function createLegacyInbox(sqlite) {
  sqlite.exec(`CREATE TABLE gateway_webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    environment TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT,
    raw_payload TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    signature TEXT NOT NULL,
    processing_status TEXT NOT NULL DEFAULT 'RECEIVED',
    failure_reason TEXT,
    received_at INTEGER NOT NULL,
    processed_at INTEGER,
    UNIQUE(provider,event_id)
  )`);
}

function insertInbox(sqlite, id, eventId, status = "RECEIVED") {
  sqlite.prepare(`INSERT INTO gateway_webhook_events
    (id,provider,environment,event_id,event_type,raw_payload,payload_sha256,signature,processing_status,failure_reason,received_at,processed_at)
    VALUES (?,'razorpay','sandbox',?,'refund.processed','{}','hash','sig',?,NULL,1000,NULL)`)
    .run(id, eventId, status);
}

test("stale PROCESSING inbox leases are reclaimed with fencing and old workers cannot terminalize the row", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  createLegacyInbox(sqlite);
  insertInbox(sqlite, "INBOX-1", "evt-1");

  const { ensureWebhookInboxLeaseSchema, claimWebhookInbox, markWebhookInbox } = await import("../lib/webhook-inbox-lease.ts");
  await ensureWebhookInboxLeaseSchema(db);
  const columns = new Set(sqlite.prepare("PRAGMA table_info(gateway_webhook_events)").all().map((row) => String(row.name)));
  assert.equal(columns.has("processing_claim_token"), true);
  assert.equal(columns.has("processing_lease_expires_at"), true);

  const first = await claimWebhookInbox(db, { inboxId: "INBOX-1", eventType: "refund.processed", now: 10_000, leaseMs: 10_000 });
  assert.equal(first.claimed, true);
  assert.equal(first.recovered, false);
  assert.ok(first.claimToken);

  const contended = await claimWebhookInbox(db, { inboxId: "INBOX-1", eventType: "refund.processed", now: 15_000, leaseMs: 10_000 });
  assert.equal(contended.claimed, false);
  assert.equal(contended.currentStatus, "PROCESSING");

  const reclaimed = await claimWebhookInbox(db, { inboxId: "INBOX-1", eventType: "refund.processed", now: 20_001, leaseMs: 10_000 });
  assert.equal(reclaimed.claimed, true);
  assert.equal(reclaimed.recovered, true);
  assert.ok(reclaimed.claimToken);
  assert.notEqual(reclaimed.claimToken, first.claimToken);

  const staleWorker = await markWebhookInbox(db, { inboxId: "INBOX-1", claimToken: first.claimToken, status: "PROCESSED", eventType: "refund.processed", now: 20_002 });
  assert.equal(staleWorker.marked, false);
  assert.equal(sqlite.prepare("SELECT processing_status FROM gateway_webhook_events WHERE id='INBOX-1'").get().processing_status, "PROCESSING");

  const owner = await markWebhookInbox(db, { inboxId: "INBOX-1", claimToken: reclaimed.claimToken, status: "PROCESSED", eventType: "refund.processed", now: 20_003 });
  assert.equal(owner.marked, true);
  const final = sqlite.prepare("SELECT processing_status,processing_claim_token,processing_lease_expires_at FROM gateway_webhook_events WHERE id='INBOX-1'").get();
  assert.equal(final.processing_status, "PROCESSED");
  assert.equal(final.processing_claim_token, null);
  assert.equal(final.processing_lease_expires_at, null);
});

test("a crash between outer PROCESSING and inner refund completion is recoverable and stays ledger-balanced", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  createLegacyInbox(sqlite);
  insertInbox(sqlite, "INBOX-CRASH", "evt_crash", "PROCESSING");

  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?)").run("BK-CRASH", "CUS-CRASH", "blr", "grooming");
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,'INR','upi','prepaid','captured','razorpay_sandbox','idem-crash','{}',?,?)").run("PAY-CRASH", "BK-CRASH", "CUS-CRASH", 1899, 1899, Date.now(), Date.now());
  sqlite.prepare("INSERT INTO booking_refund_cases VALUES (?,?,?,?,?,'processing','ops','finance','rfnd_crash',?,?)").run("RF-CRASH", "BK-CRASH", "PAY-CRASH", 1899, "cancelled", Date.now(), Date.now());

  const { ensureWebhookInboxLeaseSchema, claimWebhookInbox, markWebhookInbox } = await import("../lib/webhook-inbox-lease.ts");
  const { ensurePaymentReconciliationTables, linkSandboxGatewayOrder, processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  await ensureWebhookInboxLeaseSchema(db);
  sqlite.prepare("UPDATE gateway_webhook_events SET processing_claim_token='R:dead-worker',processing_lease_expires_at=5000 WHERE id='INBOX-CRASH'").run();

  await ensurePaymentReconciliationTables(db);
  await linkSandboxGatewayOrder(db, { bookingId: "BK-CRASH", gatewayOrderId: "order_crash", actorId: "test" });
  sqlite.prepare("UPDATE payment_gateway_links SET gateway_payment_id='pay_crash' WHERE booking_id='BK-CRASH'").run();
  sqlite.prepare("UPDATE payment_reconciliation_records SET captured_amount=1899,gateway_status='captured',reconciliation_status='matched' WHERE payment_id='PAY-CRASH'").run();
  sqlite.prepare(`INSERT INTO payment_gateway_events
    (id,provider,environment,event_id,event_type,booking_id,payment_id,gateway_order_id,gateway_payment_id,gateway_refund_id,amount_subunits,currency,signature_verified,payload_hash,processing_status,detail_json,received_at)
    VALUES ('PAYEV-CRASH','razorpay','sandbox','evt_crash','refund.processed','BK-CRASH','PAY-CRASH','order_crash','pay_crash','rfnd_crash',189900,'INR',1,'hash','processing','{}',?)`).run(Date.now());

  const claim = await claimWebhookInbox(db, { inboxId: "INBOX-CRASH", eventType: "refund.processed", now: 10_000, leaseMs: 30_000 });
  assert.equal(claim.claimed, true);
  assert.equal(claim.recovered, true);

  const result = await processGatewayEvent(db, {
    provider: "razorpay", environment: "sandbox", eventId: "evt_crash", eventType: "refund.processed",
    bookingId: "BK-CRASH", gatewayOrderId: "order_crash", gatewayPaymentId: "pay_crash", gatewayRefundId: "rfnd_crash",
    amountSubunits: 189900, currency: "INR", createdAt: Date.parse("2026-09-09T07:00:00.000Z"), signatureVerified: true, payloadHash: "hash",
  }, { allowRecovery: claim.recovered });
  assert.equal(result.status, "processed");

  const marked = await markWebhookInbox(db, { inboxId: "INBOX-CRASH", claimToken: claim.claimToken, status: "PROCESSED", eventType: "refund.processed", now: 10_100 });
  assert.equal(marked.marked, true);
  assert.equal(sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id='RF-CRASH'").get().status, "processed");
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id='PAY-CRASH'").get().status, "refunded");
  assert.equal(sqlite.prepare("SELECT processing_status FROM payment_gateway_events WHERE id='PAYEV-CRASH'").get().processing_status, "processed");
  assert.equal(sqlite.prepare("SELECT processing_status FROM gateway_webhook_events WHERE id='INBOX-CRASH'").get().processing_status, "PROCESSED");

  const journal = sqlite.prepare("SELECT debit,credit FROM finance_journal_entries WHERE source_id='rfnd_crash'").all();
  assert.equal(journal.length, 2);
  assert.equal(journal.reduce((sum, row) => sum + Number(row.debit || 0), 0), 1899);
  assert.equal(journal.reduce((sum, row) => sum + Number(row.credit || 0), 0), 1899);
});

test("Razorpay webhook route wires lease recovery into inner reconciliation and does not 200 an active PROCESSING claim", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../app/api/razorpay-webhook/route.ts", import.meta.url), "utf8");
  assert.match(source, /claimWebhookInbox/);
  assert.match(source, /webhook_processing_in_progress/);
  assert.match(source, /allowRecovery:recoveringInbox/);
  assert.match(source, /processing_recovered/);
});
