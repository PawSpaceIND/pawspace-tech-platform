import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Additive cover for the claim-token approval on this branch. Deliberately narrow: the concurrency,
// money-failure, audit-failure and retry cases are already proven in package-upgrade-authority, and
// duplicating them would only make the suite slower to read. Three things it does not cover:
//
//   1. Failure injected at EVERY dependent statement, not two of them — including the customer
//      confirmation, which is the one whose failure would otherwise tell a customer a price changed.
//   2. That no injection point can leave `applied` sitting over an unchanged booking. That combination
//      is the exact defect the third QA round found, so it is worth asserting as a property across all
//      of them rather than at the two points that happened to be tested.
//   3. Guard coverage. The design's safety rests on EVERY dependent statement in the batch carrying the
//      claim-token guard: an unguarded statement is one a losing approver could still write through. No
//      behavioural test can see that until someone actually adds such a statement, so it is checked
//      structurally, and it fails the moment a statement is added without the guard.
// ---------------------------------------------------------------------------
installWorkersHooks("__PUR_DB__", "__PUR_ENV__");

function makeD1(sqlite) {
  let batchQueue = Promise.resolve();
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    // D1 runs a batch as ONE transaction, and every assertion here depends on that: a sequential shim
    // reports the money as committed after a mid-batch throw, which measures the harness, not the route.
    //
    // Batches are also serialised, because node:sqlite here is a single connection where BEGIN does not
    // nest. Without the queue, two concurrent callers collide — resolveActor issues its own DDL batch per
    // request — and the second BEGIN throws in a way that looks exactly like a lost race. Real D1
    // serialises batches itself.
    batch: async (list) => {
      const run = async () => {
        sqlite.exec("BEGIN");
        try {
          const out = [];
          for (const item of list) out.push(await item.run());
          sqlite.exec("COMMIT");
          return out;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      };
      const queued = batchQueue.then(run, run);
      batchQueue = queued.then(() => undefined, () => undefined);
      return queued;
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const BOOKING = "BK-REC", PROVIDER = "PRV-REC", REQUEST = "REQ-REC";
const A = "approver.one@pawspace.in", B = "approver.two@pawspace.in", REQUESTER = "reporting.provider@pawspace.in";
const ORIGINAL = 6000, APPROVED = 9000;

function seed() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PUR_DB__ = db;
  globalThis.__PUR_ENV__ = {};
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,package_name TEXT NOT NULL DEFAULT 'Basic',total_amount REAL NOT NULL DEFAULT 0,scheduled_start TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'confirmed',pricing_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,amount REAL NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_operational_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,reason TEXT NOT NULL,impact_minutes INTEGER NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}',actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_package_upgrade_requests (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,source_event_id TEXT NOT NULL,requested_package_name TEXT NOT NULL,requested_amount REAL NOT NULL,previous_amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'pricing_approval_required',requested_by TEXT NOT NULL,approved_by TEXT,approved_amount REAL,decision_reason TEXT,claim_token TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,total_amount) VALUES (?,?,?,?)").run(BOOKING, "CUS-REC", PROVIDER, ORIGINAL);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,amount) VALUES (?,?,?)").run("PAY-REC", BOOKING, ORIGINAL);
  sqlite.prepare("INSERT INTO booking_package_upgrade_requests (id,booking_id,provider_id,source_event_id,requested_package_name,requested_amount,previous_amount,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pricing_approval_required',?,?,?)").run(REQUEST, BOOKING, PROVIDER, "EV-REC", "Premium spa", APPROVED, ORIGINAL, REQUESTER, 1, 1);
  for (const [id, email] of [["u-a", A], ["u-b", B]])
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run(id, email, email, "admin", "active");
  return { sqlite, db };
}

const approve = async (email, amount) => {
  const { POST } = await import("../app/api/booking-operations/route.ts");
  return POST(new Request("https://uat.pawspace.in/api/booking-operations", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
    body: JSON.stringify({ bookingId: BOOKING, providerId: PROVIDER, action: "apply_package_upgrade", upgradeRequestId: REQUEST, reason: "priced after finance review", upgradedAmount: amount }),
  }));
};

const snapshot = (sqlite) => {
  const request = sqlite.prepare("SELECT status,approved_by,approved_amount FROM booking_package_upgrade_requests WHERE id=?").get(REQUEST);
  return {
    status: request.status,
    approvedBy: request.approved_by,
    approvedAmount: request.approved_amount,
    bookingTotal: sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id=?").get(BOOKING).total_amount,
    paymentAmount: sqlite.prepare("SELECT amount FROM booking_payments WHERE booking_id=?").get(BOOKING).amount,
    appliedOps: sqlite.prepare("SELECT COUNT(*) c FROM booking_operational_events WHERE event_type='package_upgrade.applied'").get().c,
    appliedLifecycle: sqlite.prepare("SELECT COUNT(*) c FROM booking_lifecycle_events WHERE event_type='package_upgrade.applied'").get().c,
    confirmations: sqlite.prepare("SELECT COUNT(*) c FROM booking_customer_notifications WHERE template_code='package_upgrade.applied'").get().c,
    audits: sqlite.prepare("SELECT COUNT(*) c FROM security_audit_events WHERE action='booking_operations.apply_package_upgrade'").get().c,
  };
};

/** Make one statement of the committing batch throw, identified by a fragment of its SQL. */
async function approveWithFailure(db, sqlFragment, email = A, amount = APPROVED) {
  const realPrepare = db.prepare;
  db.prepare = (sql) => (String(sql).includes(sqlFragment)
    ? { bind: () => ({ run: async () => { throw new Error(`injected failure: ${sqlFragment}`); } }) }
    : realPrepare(sql));
  try { return await approve(email, amount); } finally { db.prepare = realPrepare; }
}

/** Every dependent statement of the committing batch, by a fragment that identifies it uniquely. */
const DEPENDENT_STATEMENTS = [
  "UPDATE canonical_bookings SET package_name=?",
  "UPDATE booking_payments SET amount=?",
  "INSERT INTO booking_operational_events",
  "INSERT INTO booking_lifecycle_events",
  "INSERT INTO booking_customer_notifications",
  "INSERT INTO security_audit_events",
];

test("failure at ANY statement of the committing batch leaves nothing behind and stays retryable", async () => {
  for (const fragment of DEPENDENT_STATEMENTS) {
    const { sqlite, db } = seed();
    const failed = await approveWithFailure(db, fragment);
    assert.equal(failed.status, 500, `'${fragment}' must surface as an error, not a quiet success`);

    const s = snapshot(sqlite);
    // The combination the third QA round found: applied recorded over an unchanged booking.
    assert.ok(!(s.status === "applied" && s.bookingTotal === ORIGINAL), `'${fragment}' left applied over an unchanged booking`);
    assert.equal(s.status, "pricing_approval_required", `'${fragment}' must leave the request retryable`);
    assert.equal(s.approvedBy, null, `'${fragment}' recorded an approver for an approval that did not happen`);
    assert.equal(s.approvedAmount, null);
    assert.equal(s.bookingTotal, ORIGINAL, `'${fragment}' moved the booking total`);
    assert.equal(s.paymentAmount, ORIGINAL, `'${fragment}' moved the payment`);
    assert.equal(s.appliedOps, 0);
    assert.equal(s.appliedLifecycle, 0);
    assert.equal(s.confirmations, 0, `'${fragment}' told the customer a price changed when it did not`);
    assert.equal(s.audits, 0);

    // And the request really is usable again, at every injection point.
    const retry = await approve(B, APPROVED);
    assert.equal(retry.status, 200, `after '${fragment}' failed, a legitimate retry must succeed`);
    const after = snapshot(sqlite);
    assert.equal(after.status, "applied");
    assert.equal(after.approvedAmount, APPROVED);
    assert.equal(after.bookingTotal, APPROVED);
    assert.equal(after.paymentAmount, APPROVED);
    assert.equal(after.appliedOps, 1);
    assert.equal(after.confirmations, 1);
    assert.equal(after.audits, 1);
    assert.equal(after.approvedBy, B);
  }
});

test("every dependent statement in the committing batch carries the claim-token guard", () => {
  // Structural, and deliberately so. The design's exclusion of a losing approver rests on each dependent
  // statement being conditional on this attempt's claim token. A statement added without the guard would
  // be writable by a loser, and no behavioural test can see that until such a statement exists — this
  // fails on the day it is added instead.
  const source = fs.readFileSync(new URL("../app/api/booking-operations/route.ts", import.meta.url), "utf8");
  const start = source.indexOf("const eventId = crypto.randomUUID(), claim");
  const end = source.indexOf("      ]);", start);
  assert.ok(start > 0 && end > start, "the committing batch must be locatable");
  const block = source.slice(start, end);

  const statements = [...block.matchAll(/db\.prepare\((`|")([\s\S]*?)\1\)/g)].map(([, , sql]) => sql);
  assert.equal(statements.length, DEPENDENT_STATEMENTS.length + 1, `expected the CAS plus ${DEPENDENT_STATEMENTS.length} dependent statements, found ${statements.length} — if a statement was added, add it to DEPENDENT_STATEMENTS too`);

  const [cas, ...dependents] = statements;
  assert.match(cas, /status='pricing_approval_required'/, "the first statement is the compare-and-set");
  assert.match(cas, /claim_token=\?/, "the CAS records the claim token it is winning with");
  for (const sql of dependents) {
    assert.match(sql, /\$\{guard\}/, `a dependent statement is missing the claim-token guard: ${sql.slice(0, 90)}`);
  }
  // And the guard really is the claim-token predicate, not some other condition.
  assert.match(block, /EXISTS \(SELECT 1 FROM booking_package_upgrade_requests WHERE id=\? AND claim_token=\?\)/);
});
