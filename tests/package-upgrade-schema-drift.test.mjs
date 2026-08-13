import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// The approval became a claim-token compare-and-set, which added `claim_token` to
// booking_package_upgrade_requests. That column was added inside `CREATE TABLE IF NOT EXISTS`, and that
// statement is a no-op once the table exists — so on any database that created the table before the
// column existed, `claim_token` never appears and every apply_package_upgrade dies with:
//
//   HTTP 500  {"error":"no such column: claim_token"}
//
// Money-safe (the rollback semantics hold) but the remediation path is completely unusable, and there
// was no route to fix it. lib/schema-drift-repair.ts exists for exactly this class of problem; the
// column is now registered there, and this route runs the repair.
//
// Every test below starts from the OLD table shape, taken verbatim from commit 73b3682, and drives the
// real production path — no test DDL creates claim_token.
// ---------------------------------------------------------------------------
installWorkersHooks("__PUD_DB__", "__PUD_ENV__");

/** The shape booking_package_upgrade_requests had before claim_token existed. Verbatim from 73b3682. */
const OLD_SHAPE = "CREATE TABLE booking_package_upgrade_requests (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,source_event_id TEXT NOT NULL,requested_package_name TEXT NOT NULL,requested_amount REAL NOT NULL,previous_amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'pricing_approval_required',requested_by TEXT NOT NULL,approved_by TEXT,approved_amount REAL,decision_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

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
    // Atomic, and serialised: node:sqlite is one connection where BEGIN does not nest.
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

const BOOKING = "BK-DRIFT", PROVIDER = "PRV-DRIFT", REQUEST = "REQ-DRIFT";
const APPROVER = "pricing.approver@pawspace.in", OTHER = "second.approver@pawspace.in";
const REQUESTER = "reporting.provider@pawspace.in";
const ORIGINAL = 6000, APPROVED = 9000;

/** @param withClaimToken false = the drifted database; true = a fresh one built by the route itself. */
function seed({ preExistingTable }) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PUD_DB__ = db;
  globalThis.__PUD_ENV__ = {};
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,package_name TEXT NOT NULL DEFAULT 'Basic',total_amount REAL NOT NULL DEFAULT 0,scheduled_start TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'confirmed',pricing_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,amount REAL NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL DEFAULT 0)");
  // booking_lifecycle_events is owned by another module, so the route does not create it.
  sqlite.exec("CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,total_amount) VALUES (?,?,?,?)").run(BOOKING, "CUS-DRIFT", PROVIDER, ORIGINAL);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,amount) VALUES (?,?,?)").run("PAY-DRIFT", BOOKING, ORIGINAL);
  // REQUESTER holds communications.message and provider authority so it can REPORT; it is a
  // different identity from the approvers, so segregation of duties still applies to the approval.
  for (const [id, email] of [["u-1", APPROVER], ["u-2", OTHER], ["u-3", REQUESTER]])
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run(id, email, email, "admin", "active");
  if (preExistingTable) {
    // The drifted database: the table already exists, without claim_token, exactly as an earlier build
    // of this branch would have left it.
    sqlite.exec(OLD_SHAPE);
    sqlite.prepare("INSERT INTO booking_package_upgrade_requests (id,booking_id,provider_id,source_event_id,requested_package_name,requested_amount,previous_amount,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pricing_approval_required',?,?,?)").run(REQUEST, BOOKING, PROVIDER, "EV-DRIFT", "Premium spa", APPROVED, ORIGINAL, REQUESTER, 1, 1);
  }
  return { sqlite, db };
}

const columns = (sqlite) => sqlite.prepare("PRAGMA table_info(booking_package_upgrade_requests)").all().map((row) => row.name);

const post = async (body, email = APPROVER) => {
  const { POST } = await import("../app/api/booking-operations/route.ts");
  return POST(new Request("https://uat.pawspace.in/api/booking-operations", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
    body: JSON.stringify(body),
  }));
};
const apply = (email = APPROVER, amount = APPROVED, requestId = REQUEST) =>
  post({ bookingId: BOOKING, providerId: PROVIDER, action: "apply_package_upgrade", upgradeRequestId: requestId, reason: "priced after finance review", upgradedAmount: amount }, email);

const state = (sqlite, requestId = REQUEST) => {
  const request = sqlite.prepare("SELECT status,approved_by,approved_amount FROM booking_package_upgrade_requests WHERE id=?").get(requestId);
  return {
    status: request?.status ?? null,
    approvedBy: request?.approved_by ?? null,
    approvedAmount: request?.approved_amount ?? null,
    bookingTotal: sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id=?").get(BOOKING).total_amount,
    paymentAmount: sqlite.prepare("SELECT amount FROM booking_payments WHERE booking_id=?").get(BOOKING).amount,
    appliedOps: sqlite.prepare("SELECT COUNT(*) c FROM booking_operational_events WHERE event_type='package_upgrade.applied'").get().c,
    appliedLifecycle: sqlite.prepare("SELECT COUNT(*) c FROM booking_lifecycle_events WHERE event_type='package_upgrade.applied'").get().c,
    confirmations: sqlite.prepare("SELECT COUNT(*) c FROM booking_customer_notifications WHERE template_code='package_upgrade.applied'").get().c,
    audits: sqlite.prepare("SELECT COUNT(*) c FROM security_audit_events WHERE action='booking_operations.apply_package_upgrade'").get().c,
  };
};

test("the drifted table really is missing the column before anything runs", () => {
  const { sqlite } = seed({ preExistingTable: true });
  assert.ok(!columns(sqlite).includes("claim_token"), "the fixture must start from the genuinely drifted shape, or this suite proves nothing");
});

test("pre-existing table: the production repair path adds claim_token and the approval then works", async () => {
  const { sqlite } = seed({ preExistingTable: true });
  assert.ok(!columns(sqlite).includes("claim_token"));

  // The real route, on the real path. Nothing here creates the column by hand.
  const response = await apply();

  assert.ok(columns(sqlite).includes("claim_token"), "claim_token must exist after the repair");
  assert.equal(response.status, 200, `apply must succeed on a repaired database: ${JSON.stringify(await response.json()).slice(0, 160)}`);

  const s = state(sqlite);
  assert.equal(s.status, "applied");
  assert.equal(s.approvedAmount, APPROVED);
  assert.equal(s.approvedBy, APPROVER);
  assert.equal(s.bookingTotal, APPROVED, "booking total is the approved amount");
  assert.equal(s.paymentAmount, APPROVED, "payment is the approved amount");
  assert.equal(s.audits, 1, "exactly one audit");
  assert.equal(s.appliedOps, 1, "exactly one applied operational event");
  assert.equal(s.appliedLifecycle, 1, "exactly one lifecycle event");
  assert.equal(s.confirmations, 1, "exactly one confirmation");
});

test("running the repair twice is harmless", async () => {
  const { sqlite, db } = seed({ preExistingTable: true });
  const { repairSchemaDrift } = await import("../lib/schema-drift-repair.ts");

  const first = await repairSchemaDrift(db);
  assert.ok(first.repaired.includes("booking_package_upgrade_requests.claim_token"), `the first run must repair the column, got ${JSON.stringify(first.repaired)}`);

  const second = await repairSchemaDrift(db);
  assert.ok(!second.repaired.includes("booking_package_upgrade_requests.claim_token"), "the second run must find nothing to do");

  // Idempotent in the sense that matters: one column, still usable.
  assert.equal(columns(sqlite).filter((name) => name === "claim_token").length, 1, "exactly one claim_token column");
  assert.equal((await apply()).status, 200, "and the approval still works after repeated repairs");
});

test("fresh database: ensureTables still creates the column itself, with no repair needed", async () => {
  const { sqlite } = seed({ preExistingTable: false });
  // No booking_package_upgrade_requests at all yet — the route must create it complete.
  assert.equal(columns(sqlite).length, 0);

  // Report an upgrade, which is what creates the request row on a fresh database.
  const reported = await post({ bookingId: BOOKING, providerId: PROVIDER, action: "package_upgrade", reason: "customer agreed on site", upgradedPackageName: "Premium spa", upgradedAmount: APPROVED }, REQUESTER);
  assert.equal(reported.status, 201, `reporting must work on a fresh database: ${JSON.stringify(await reported.json()).slice(0, 160)}`);
  assert.ok(columns(sqlite).includes("claim_token"), "the fresh-database DDL path must still include claim_token");

  const requestId = String((await (await post({ bookingId: BOOKING, providerId: PROVIDER, action: "package_upgrade", reason: "second report for id capture", upgradedPackageName: "Premium spa", upgradedAmount: APPROVED }, REQUESTER)).json()).data?.upgradeRequestId ?? "");
  assert.ok(requestId, "the report returns the request id it created");

  // And the money still only moves through a priced approval.
  const before = state(sqlite, requestId);
  assert.equal(before.bookingTotal, ORIGINAL, "reporting moves no money");
  const applied = await apply(APPROVER, APPROVED, requestId);
  assert.equal(applied.status, 200);
  const after = state(sqlite, requestId);
  assert.equal(after.bookingTotal, APPROVED);
  assert.equal(after.audits, 1);
  assert.equal(after.confirmations, 1);
});

test("failure and retry semantics are unchanged on a repaired database", async () => {
  // The repair must not have loosened the rollback behaviour certified in the previous round.
  const { sqlite, db } = seed({ preExistingTable: true });
  const realPrepare = db.prepare;
  db.prepare = (sql) => (String(sql).includes("INSERT INTO security_audit_events")
    ? { bind: () => ({ run: async () => { throw new Error("injected audit failure"); } }) }
    : realPrepare(sql));
  let failed;
  try { failed = await apply(); } finally { db.prepare = realPrepare; }

  assert.equal(failed.status, 500);
  const s = state(sqlite);
  assert.equal(s.status, "pricing_approval_required", "still retryable after a failure");
  assert.equal(s.approvedBy, null);
  assert.equal(s.approvedAmount, null);
  assert.equal(s.bookingTotal, ORIGINAL, "money untouched");
  assert.equal(s.paymentAmount, ORIGINAL);
  assert.equal(s.appliedOps, 0);
  assert.equal(s.confirmations, 0);
  assert.equal(s.audits, 0);

  assert.equal((await apply(OTHER)).status, 200, "and the retry succeeds");
  const after = state(sqlite);
  assert.equal(after.bookingTotal, APPROVED);
  assert.equal(after.approvedBy, OTHER);
  assert.equal(after.audits, 1);
  assert.equal(after.confirmations, 1);
});

test("concurrency is unchanged on a repaired database: one winner, one 409", async () => {
  const { sqlite } = seed({ preExistingTable: true });
  const [a, b] = await Promise.all([apply(APPROVER, APPROVED), apply(OTHER, 25000)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `expected one 200 and one 409, got ${JSON.stringify([a.status, b.status])}`);
  const s = state(sqlite);
  assert.equal(s.status, "applied");
  assert.equal(s.bookingTotal, s.approvedAmount, "the booking carries the winning figure");
  assert.equal(s.paymentAmount, s.approvedAmount);
  assert.equal(s.appliedOps, 1);
  assert.equal(s.confirmations, 1);
  assert.equal(s.audits, 1);
});

test("the column is registered in the shared repair mechanism, not repaired ad hoc here", async () => {
  // If a future change moves this route off repairSchemaDrift, or drops the registration, the drifted
  // database silently breaks again. Pin both halves.
  const { REQUIRED_COLUMN_REPAIRS } = await import("../lib/schema-drift-repair.ts");
  const entry = REQUIRED_COLUMN_REPAIRS.find((item) => item.table === "booking_package_upgrade_requests" && item.column === "claim_token");
  assert.ok(entry, "claim_token must be registered in the shared REQUIRED_COLUMNS list");
  assert.ok(entry.why && entry.why.length > 20, "each registration carries why it exists");
  const route = await (await import("node:fs/promises")).readFile(new URL("../app/api/booking-operations/route.ts", import.meta.url), "utf8");
  assert.match(route, /repairSchemaDrift\(db\)/, "the route must run the shared repair, not its own ALTER");
  assert.doesNotMatch(route, /ALTER TABLE/, "no ad-hoc column patching in the route");
});
