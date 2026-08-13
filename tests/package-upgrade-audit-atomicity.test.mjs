import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// One addition on top of the atomicity work already on this branch.
//
// tests/package-upgrade-authority.test.mjs proves the audit row lands with the money, and pins the audit
// INSERT as the last statement of the money batch with a source match. That is the right property, but
// asserting it against the source cannot show what happens when the audit write actually fails — and
// "money changed with no audit record" is the outcome that matters.
//
// So this makes the audit INSERT throw and asserts the money did not move. It deliberately does NOT
// assert what happens to the request's status afterwards: leaving it 'applied' (stuck, requiring a human)
// and releasing it back to 'pricing_approval_required' (retryable) are both defensible, and this branch
// documents the stuck choice on purpose. Pinning either would turn a design decision into a test
// obligation. The invariant under test is narrower and non-negotiable: no repriced booking without its
// audit record.
// ---------------------------------------------------------------------------
installWorkersHooks("__PUA_DB__", "__PUA_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    // D1 runs a batch as ONE transaction. That is the whole basis of "money and audit land together", so
    // the shim has to model it — a shim that replays statements sequentially would report the money as
    // committed when the audit failed, and the test would be measuring the harness rather than the route.
    // (First version of this test did exactly that and failed for that reason.)
    batch: async (list) => {
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
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const BOOKING = "BK-AUD", PROVIDER = "PRV-AUD", REQUEST = "REQ-AUD";
const APPROVER = "pricing.approver@pawspace.in", REQUESTER = "reporting.provider@pawspace.in";
const START_TOTAL = 6000, APPROVED = 9000;

function seed() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PUA_DB__ = db;
  globalThis.__PUA_ENV__ = {};
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,package_name TEXT NOT NULL DEFAULT 'Basic',total_amount REAL NOT NULL DEFAULT 0,scheduled_start TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'confirmed',pricing_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,amount REAL NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_operational_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,reason TEXT NOT NULL,impact_minutes INTEGER NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}',actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_package_upgrade_requests (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,source_event_id TEXT NOT NULL,requested_package_name TEXT NOT NULL,requested_amount REAL NOT NULL,previous_amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'pricing_approval_required',requested_by TEXT NOT NULL,approved_by TEXT,approved_amount REAL,decision_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,total_amount) VALUES (?,?,?,?)").run(BOOKING, "CUS-AUD", PROVIDER, START_TOTAL);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,amount) VALUES (?,?,?)").run("PAY-AUD", BOOKING, START_TOTAL);
  sqlite.prepare("INSERT INTO booking_package_upgrade_requests (id,booking_id,provider_id,source_event_id,requested_package_name,requested_amount,previous_amount,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pricing_approval_required',?,?,?)").run(REQUEST, BOOKING, PROVIDER, "EV-AUD", "Premium spa", APPROVED, START_TOTAL, REQUESTER, 1, 1);
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-ap", APPROVER, APPROVER, "admin", "active");
  return { sqlite, db };
}

const priceIt = async () => {
  const { POST } = await import("../app/api/booking-operations/route.ts");
  // Not localhost: a localhost URL resolves to a development-preview superuser, and the real pricing role
  // would never be exercised.
  return POST(new Request("https://uat.pawspace.in/api/booking-operations", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": APPROVER },
    body: JSON.stringify({ bookingId: BOOKING, providerId: PROVIDER, action: "apply_package_upgrade", upgradeRequestId: REQUEST, reason: "priced after finance review", upgradedAmount: APPROVED }),
  }));
};

const money = (sqlite) => ({
  bookingTotal: sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id=?").get(BOOKING).total_amount,
  paymentAmount: sqlite.prepare("SELECT amount FROM booking_payments WHERE booking_id=?").get(BOOKING).amount,
  audits: sqlite.prepare("SELECT COUNT(*) c FROM security_audit_events WHERE action='booking_operations.apply_package_upgrade'").get().c,
  appliedEvents: sqlite.prepare("SELECT COUNT(*) c FROM booking_operational_events WHERE event_type='package_upgrade.applied'").get().c,
  notifications: sqlite.prepare("SELECT COUNT(*) c FROM booking_customer_notifications WHERE template_code='package_upgrade.applied'").get().c,
});

test("baseline: a successful pricing moves the money and writes exactly one audit row", async () => {
  const { sqlite } = seed();
  assert.equal((await priceIt()).status, 200);
  assert.deepEqual(money(sqlite), { bookingTotal: APPROVED, paymentAmount: APPROVED, audits: 1, appliedEvents: 1, notifications: 1 });
});

test("when the audit write fails, the booking price does not change", async () => {
  const { sqlite, db } = seed();
  const realPrepare = db.prepare;
  // Fail only the audit statement, leaving every other statement in the batch untouched. This is the
  // scenario the old code could not survive: the audit ran as a separate await after the money batch, so
  // an audit failure left a repriced booking with nothing recording who repriced it.
  db.prepare = (sql) => (String(sql).includes("INSERT INTO security_audit_events")
    ? { bind: () => ({ run: async () => { throw new Error("audit write failed"); } }) }
    : realPrepare(sql));
  let status;
  try { status = (await priceIt()).status; } finally { db.prepare = realPrepare; }

  assert.equal(status, 500, "a failed audit must surface as an error, not a quiet success");
  const after = money(sqlite);
  assert.equal(after.audits, 0, "no audit row was written");
  assert.equal(after.bookingTotal, START_TOTAL, "the booking total must be untouched when the audit fails");
  assert.equal(after.paymentAmount, START_TOTAL, "the payment amount must be untouched when the audit fails");
  assert.equal(after.appliedEvents, 0, "no applied event without an audit record");
  assert.equal(after.notifications, 0, "and the customer is not told a price changed when it did not");
});

test("the audit is written in the same batch as the money, not after it", async () => {
  // The structural half of the same property, kept because the behavioural test above can only observe
  // one failure mode. A separate post-batch await would pass the failure test only by accident.
  const source = await (await import("node:fs/promises")).readFile(new URL("../app/api/booking-operations/route.ts", import.meta.url), "utf8");
  const applyBlock = source.slice(source.indexOf('if (input.action === "apply_package_upgrade")'), source.indexOf('if (input.action === "refund_status")'));
  assert.match(applyBlock, /INSERT INTO security_audit_events/, "the audit insert belongs to the priced branch");
  assert.doesNotMatch(applyBlock, /await securityAudit\(/, "the audit must not be a separate call after the batch");
  const auditIndex = applyBlock.indexOf("INSERT INTO security_audit_events");
  const batchEnd = applyBlock.indexOf("]);", applyBlock.indexOf("await db.batch(["));
  assert.ok(auditIndex > 0 && auditIndex < batchEnd, "the audit insert must sit inside the money batch");
});
