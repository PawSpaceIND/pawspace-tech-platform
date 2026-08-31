import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__QA_REMEDIATION_DB__", "__QA_REMEDIATION_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function refundDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__QA_REMEDIATION_DB__ = db;
  globalThis.__QA_REMEDIATION_ENV__ = {};
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,total_amount REAL NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,amount REAL NOT NULL)");
  sqlite.exec("CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,total_amount) VALUES (?,?,?,?)").run("BK-REFUND", "CUS-1", "PROV-1", 2500);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,amount) VALUES (?,?,?)").run("PAY-REFUND", "BK-REFUND", 2500);
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("U-MAKER", "maker@pawspace.test", "Maker", "founder", "active");
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("U-CHECKER", "checker@pawspace.test", "Checker", "founder", "active");
  return { sqlite, db };
}

async function postRefund(email, body) {
  const { POST } = await import("../app/api/booking-operations/route.ts");
  const response = await POST(new Request("https://uat.pawspace.in/api/booking-operations", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
    body: JSON.stringify(body),
  }));
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, payload };
}

const requestBody = {
  bookingId: "BK-REFUND",
  providerId: "PROV-1",
  action: "refund_requested",
  reason: "Customer refund requested after service issue",
};

const statusBody = (refundCaseId, refundStatus, extra = {}) => ({
  bookingId: "BK-REFUND",
  providerId: "PROV-1",
  action: "refund_status",
  reason: `Move refund to ${refundStatus}`,
  refundCaseId,
  refundStatus,
  ...extra,
});

test("QA-P0-001: authenticated maker cannot approve own refund; different checker can", async () => {
  const { sqlite } = refundDb();
  const requested = await postRefund("maker@pawspace.test", requestBody);
  assert.equal(requested.status, 201, JSON.stringify(requested.payload));
  const refundCaseId = String(requested.payload?.data?.refundCaseId || "");
  assert.ok(refundCaseId);

  const storedRequest = sqlite.prepare("SELECT requested_by,status FROM booking_refund_cases WHERE id=?").get(refundCaseId);
  assert.equal(storedRequest.requested_by, "maker@pawspace.test", "maker must come from the authenticated actor, not providerId");
  assert.equal(storedRequest.status, "requested");

  const selfApproval = await postRefund("maker@pawspace.test", statusBody(refundCaseId, "approved"));
  assert.equal(selfApproval.status, 409, JSON.stringify(selfApproval.payload));
  assert.match(String(selfApproval.payload?.error || ""), /Segregation of duties/i);
  assert.equal(sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(refundCaseId).status, "requested");

  const checkerApproval = await postRefund("checker@pawspace.test", statusBody(refundCaseId, "approved"));
  assert.equal(checkerApproval.status, 200, JSON.stringify(checkerApproval.payload));
  const approved = sqlite.prepare("SELECT requested_by,approved_by,status FROM booking_refund_cases WHERE id=?").get(refundCaseId);
  assert.equal(approved.requested_by, "maker@pawspace.test");
  assert.equal(approved.approved_by, "checker@pawspace.test");
  assert.equal(approved.status, "approved");
  const audit = sqlite.prepare("SELECT actor_id FROM booking_operational_events WHERE event_type='refund.approved' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(audit.actor_id, "checker@pawspace.test", "refund audit actor must be the authenticated checker");
});

test("QA-P0-002: refund completion fails closed without gateway proof and preserves the authoritative reference", async () => {
  const { sqlite } = refundDb();
  const now = Date.now();
  sqlite.exec("CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,gateway_reference,created_at,updated_at) VALUES (?,?,?,?,?,'processing',?,?,?,?,?,?)")
    .run("RF-PROOF", "BK-REFUND", "PAY-REFUND", 2500, "Refund after service issue", "maker@pawspace.test", "checker@pawspace.test", null, now, now);

  const missingReference = await postRefund("checker@pawspace.test", statusBody("RF-PROOF", "completed"));
  assert.equal(missingReference.status, 409, JSON.stringify(missingReference.payload));
  assert.match(String(missingReference.payload?.error || ""), /gateway reference/i);
  assert.equal(sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id='RF-PROOF'").get().status, "processing");

  sqlite.prepare("UPDATE booking_refund_cases SET gateway_reference='rf_authoritative' WHERE id='RF-PROOF'").run();
  const missingEvidence = await postRefund("checker@pawspace.test", statusBody("RF-PROOF", "completed"));
  assert.equal(missingEvidence.status, 409, JSON.stringify(missingEvidence.payload));
  assert.match(String(missingEvidence.payload?.error || ""), /gateway reconciliation evidence/i);

  sqlite.exec("CREATE TABLE payment_gateway_events (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,gateway_refund_id TEXT,event_type TEXT NOT NULL,signature_verified INTEGER NOT NULL,processing_status TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO payment_gateway_events (id,booking_id,payment_id,gateway_refund_id,event_type,signature_verified,processing_status) VALUES (?,?,?,?,?,?,?)")
    .run("EV-REFUND", "BK-REFUND", "PAY-REFUND", "rf_authoritative", "refund.processed", 1, "processed");

  const mismatchedOverride = await postRefund("checker@pawspace.test", statusBody("RF-PROOF", "completed", { gatewayReference: "rf_client_override" }));
  assert.equal(mismatchedOverride.status, 409, "a client must not replace the reconciled gateway refund reference");
  assert.equal(sqlite.prepare("SELECT gateway_reference,status FROM booking_refund_cases WHERE id='RF-PROOF'").get().gateway_reference, "rf_authoritative");

  const completed = await postRefund("checker@pawspace.test", statusBody("RF-PROOF", "completed"));
  assert.equal(completed.status, 200, JSON.stringify(completed.payload));
  const finalRefund = sqlite.prepare("SELECT gateway_reference,status FROM booking_refund_cases WHERE id='RF-PROOF'").get();
  assert.equal(finalRefund.gateway_reference, "rf_authoritative");
  assert.equal(finalRefund.status, "completed");
});

function analyticsDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__QA_REMEDIATION_DB__ = db;
  globalThis.__QA_REMEDIATION_ENV__ = {};
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,zone_id TEXT NOT NULL,provider_id TEXT,status TEXT NOT NULL,total_amount REAL NOT NULL,currency TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE booking_payments (booking_id TEXT PRIMARY KEY,amount REAL NOT NULL,amount_due_now REAL NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE stay_payment_schedules (booking_id TEXT PRIMARY KEY,paid_now_amount REAL,balance_amount REAL,status TEXT)");
  sqlite.exec("CREATE TABLE booking_refund_cases (booking_id TEXT,amount REAL,status TEXT)");
  sqlite.exec("CREATE TABLE customer_experience_tickets (id TEXT PRIMARY KEY,booking_id TEXT,category TEXT,priority TEXT,status TEXT,created_at INTEGER,resolved_at INTEGER,reopened_count INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,provider_model TEXT,status TEXT,live INTEGER,quality_score REAL,rating REAL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_code,zone_id,provider_id,status,total_amount,currency,scheduled_start,scheduled_end) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("B1", "C1", "dog_walking", "PKG", "blr-east", "P1", "completed", 1000, "INR", "2026-07-10T09:00:00.000Z", "2026-07-10T10:00:00.000Z");
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,booking_id,category,priority,status,created_at,reopened_count) VALUES (?,?,?,?,?,?,?)").run("T-VALID", "B1", "service", "medium", "open", 1, 0);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,booking_id,category,priority,status,created_at,reopened_count) VALUES (?,?,?,?,?,?,?)").run("T-NULL", null, "service", "medium", "open", 1, 0);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,booking_id,category,priority,status,created_at,reopened_count) VALUES (?,?,?,?,?,?,?)").run("T-BROKEN", "NO-SUCH-BOOKING", "service", "medium", "open", 1, 0);
  return { sqlite, db };
}

test("QA-P2-007: ticketsMissingBooking detects null and broken booking links independently of period ticket filtering", async () => {
  const { db } = analyticsDb();
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const data = await buildCompanyAnalytics(db, { from: "2026-07-01", to: "2026-07-31" });
  assert.equal(data.cx.tickets, 1, "CX aggregates remain scoped to tickets linked to bookings in the selected population");
  assert.equal(data.dataQuality.ticketsMissingBooking, 2, "data-quality scan must independently find both unlinked/orphan tickets");
});
