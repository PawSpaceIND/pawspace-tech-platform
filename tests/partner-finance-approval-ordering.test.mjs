/*
 * /api/partner-finance: an approval the platform REFUSES must not have moved money-adjacent state
 * before it refused. [P0]
 *
 * The reproduction that opened this: the founder confirmed a commission (making them the maker) and
 * then clicked "Approval 1" themselves. The platform refused - maker/checker separation is enforced
 * inside approveOrderCommission() - and the operator saw a 500. But the route had already called
 * reserveEscrowForProviderPayout() one line earlier, so by the time the refusal was raised the
 * database held:
 *
 *   escrow_custodial_accounts        ESC-...   state=CUSTODY_HELD, custody_amount=300
 *   escrow_ledger_transactions       ESCL-...  CUSTODY_RESERVED, sequence=1, previous_hash=GENESIS,
 *                                              actor_id = the FORBIDDEN approver
 *   escrow_audit_events              CUSTODY_RESERVED
 *   finance_journal_entries          Dr 2230 Customer Collections 300 / Cr 2240 Escrow Custody 300
 *
 * and security_audit_events held no partner.commission.approve.level1 row for that actor - so the
 * only record of who reserved the money was the one place that can never be rewritten: a
 * hash-chained, append-only ledger, crediting the actor the platform had just said may not act.
 * When the legitimate approver then ran Approval 1, the reserve came back duplicatePrevented:true,
 * because the account already existed. The chain permanently attributes the reserve to the wrong
 * person, and the real approver's reserve is silently swallowed as a duplicate.
 *
 * Everything below EXECUTES the shipped route handler against a real SQLite-backed D1. Nothing here
 * matches on source text: the assertions are row counts and column values in the money tables.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__PF_ORDERING_DB__", "__PF_ORDERING_ENV__");
// runtimePaymentPolicy() refuses to touch escrow in NODE_ENV=test unless production is forbidden.
process.env.FORBID_PRODUCTION = "true";

/* A REAL https origin, never localhost: lib/development-preview.ts hands a localhost request a
 * superuser with ["*"], which would make every authorization assertion below vacuous. */
const ORIGIN = "https://app.pawspace.in";
const BOOKING = "BK-PF-ORD-001";
const CUSTOMER = "CUS-PF-ORD-001";
const PROVIDER = "PRV-PF-ORD-001";
const PAYMENT = "PAY-PF-ORD-001";
const ORDER_AMOUNT = 1500;
const COMMISSION = 300; // 20% of the order - the amount the founder's refused click reserved
const FOUNDER = "e2e.founder@pawspace.test";
const FINANCE = "e2e.finance@pawspace.test";
const OPS = "e2e.ops@pawspace.test";

function partnerFinanceWorld() {
  const { sqlite, db } = freshCountingD1();
  // Bind before any import so the route's database() resolves env.DB from this test's async scope.
  enterWorkersDbScope(db);
  globalThis.__PF_ORDERING_DB__ = db;
  globalThis.__PF_ORDERING_ENV__ = {
    PAWSPACE_PAYMENT_ENV: "sandbox",
    PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
    FORBID_PRODUCTION: "true",
  };
  return { sqlite, db };
}

async function seedActors(sqlite, db) {
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  for (const [id, email, role] of [
    ["USR-PF-FOUNDER", FOUNDER, "founder"],
    ["USR-PF-FINANCE", FINANCE, "finance"],
    ["USR-PF-OPS", OPS, "finance"],
  ]) {
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .run(id, email, email, role, now, now);
  }
}

/** A completed, fully captured commission booking - the state a level 1 approval acts on. */
function seedCompletedCommissionBooking(sqlite) {
  const now = Date.now();
  sqlite.exec(`
  CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,pet_ids_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS payment_reconciliation_records (payment_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,gateway TEXT,environment TEXT,expected_amount REAL,captured_amount REAL DEFAULT 0,refunded_amount REAL DEFAULT 0,currency TEXT,gateway_status TEXT,reconciliation_status TEXT,variance_amount REAL DEFAULT 0,last_event_id TEXT,updated_at INTEGER);
  `);
  const start = new Date(now - 6 * 86400000).toISOString();
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(CUSTOMER, "Ordering Customer", "9800000111", "ordering@example.test", "blr", "{}", now, now);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,pet_ids_json,created_by,created_at,updated_at) VALUES (?,?,'blr','blr-east','grooming','dog-basic','Bath & Basic','PF-SG-1',?,?,?,'completed','customer_app',?,'INR','{}','[]','test',?,?)")
    .run(BOOKING, CUSTOMER, PROVIDER, start, start, ORDER_AMOUNT, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,'PF-SG-1',?,'Ordering Provider','commission','grooming',?,?,1,'completed','{}',?,?)")
    .run("WO-PF-ORD-001", BOOKING, PROVIDER, start, start, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES (?,?,?,?,?,'INR','card','prepaid','captured','razorpay',?,'{}',?,?)")
    .run(PAYMENT, BOOKING, CUSTOMER, ORDER_AMOUNT, ORDER_AMOUNT, "pf-ord-idem-1", now, now);
  sqlite.prepare("INSERT OR REPLACE INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,updated_at) VALUES (?,?,'razorpay','sandbox',?,?,0,'INR','captured','matched',?)")
    .run(PAYMENT, BOOKING, ORDER_AMOUNT, ORDER_AMOUNT, now);
}

const post = async (email, body) => {
  const route = await import("../app/api/partner-finance/route.ts");
  const response = await route.POST(new Request(`${ORIGIN}/api/partner-finance`, {
    method: "POST",
    headers: { "oai-authenticated-user-email": email, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
};

/** Drive the real route up to the point where the commission is awaiting level 1, maker = founder. */
async function awaitingLevelOneApproval(sqlite, db) {
  seedCompletedCommissionBooking(sqlite);
  await seedActors(sqlite, db);
  const profile = await post(OPS, {
    action: "save_provider_profile", providerId: PROVIDER, engagementModel: "commission",
    commissionMode: "percent", commissionValue: 20, reason: "Ordering fixture commercial terms",
  });
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  // The founder CONFIRMS. That makes them the maker, and therefore ineligible to approve.
  const confirmed = await post(FOUNDER, { action: "confirm_order_commission", bookingId: BOOKING });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.commissionAmount, COMMISSION);
  assert.equal(
    sqlite.prepare("SELECT status,confirmed_by FROM provider_order_commissions WHERE booking_id=?").get(BOOKING).status,
    "awaiting_approval_1",
  );
}

/** Every table a level 1 approval writes to that cannot be taken back afterwards. */
const moneyTrail = (sqlite) => ({
  escrowAccounts: sqlite.prepare("SELECT COUNT(*) n FROM escrow_custodial_accounts").get().n,
  ledgerTransactions: sqlite.prepare("SELECT COUNT(*) n FROM escrow_ledger_transactions").get().n,
  escrowAuditEvents: sqlite.prepare("SELECT COUNT(*) n FROM escrow_audit_events").get().n,
  journalEntries: sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_entries WHERE source_id=?").get(BOOKING).n,
});

const tableMissing = (sqlite, name) =>
  !sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?").get(name).n;

/** Absent tables count as zero rows: "never created" is the strongest form of "wrote nothing". */
function assertNoMoneyTrail(sqlite, label) {
  for (const name of ["escrow_custodial_accounts", "escrow_ledger_transactions", "escrow_audit_events", "finance_journal_entries"]) {
    if (tableMissing(sqlite, name)) continue;
    const count = name === "finance_journal_entries"
      ? sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_entries WHERE source_id=?").get(BOOKING).n
      : sqlite.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n;
    assert.equal(count, 0, `${label}: a refused approval left ${count} row(s) in ${name}`);
  }
}

// ---- 1. The P0 itself -------------------------------------------------------------------------

test("an approval refused for maker/checker separation moves no escrow, no ledger and no GL", async () => {
  const { sqlite, db } = partnerFinanceWorld();
  await awaitingLevelOneApproval(sqlite, db);

  // The founder is the maker. The platform must refuse - and must refuse BEFORE reserving anything.
  const refused = await post(FOUNDER, { action: "approve_order_commission_level_1", bookingId: BOOKING });
  assert.ok(refused.status >= 400 && refused.status < 500, `a refusal is a client error, got ${refused.status}`);
  assert.match(String(refused.body.error), /different approver than the commission confirmer/,
    "the operator must be told the real reason, not a generic fallback");

  assertNoMoneyTrail(sqlite, "level 1 refused for the maker");

  // The commission itself must be untouched, and no "completed" approval may be claimed in the audit.
  const order = sqlite.prepare("SELECT status,approval_level_1_by FROM provider_order_commissions WHERE booking_id=?").get(BOOKING);
  assert.equal(order.status, "awaiting_approval_1");
  assert.equal(order.approval_level_1_by, null);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='partner.commission.approve.level1'").get().n,
    0,
  );
});

// ---- 2. The authorised path still does all of it, in the real approver's name -------------------

test("the legitimate approver reserves escrow and the ledger row carries THEIR actor id", async () => {
  const { sqlite, db } = partnerFinanceWorld();
  await awaitingLevelOneApproval(sqlite, db);

  // The refused attempt happens first, exactly as it did in production.
  const refused = await post(FOUNDER, { action: "approve_order_commission_level_1", bookingId: BOOKING });
  assert.ok(refused.status >= 400 && refused.status < 500, JSON.stringify(refused.body));

  const approved = await post(FINANCE, { action: "approve_order_commission_level_1", bookingId: BOOKING });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.status, "awaiting_approval_2");

  // Requirement 3: the real approver's reserve is a genuine first reserve, never a swallowed duplicate.
  assert.equal(approved.body.data.escrow.duplicatePrevented, false,
    "the refused attempt must not have already created the custodial account");

  const trail = moneyTrail(sqlite);
  assert.equal(trail.escrowAccounts, 1);
  assert.equal(trail.ledgerTransactions, 1);
  assert.equal(trail.escrowAuditEvents, 1);

  const account = sqlite.prepare("SELECT state,custody_amount,provider_id FROM escrow_custodial_accounts WHERE booking_id=?").get(BOOKING);
  assert.equal(account.state, "CUSTODY_HELD");
  assert.equal(Number(account.custody_amount), COMMISSION);
  assert.equal(account.provider_id, PROVIDER);

  const ledger = sqlite.prepare("SELECT event_type,actor_id,sequence,previous_hash,amount FROM escrow_ledger_transactions WHERE booking_id=?").get(BOOKING);
  assert.equal(ledger.event_type, "CUSTODY_RESERVED");
  assert.equal(ledger.actor_id, FINANCE, "the append-only chain must name the approver the platform ALLOWED");
  assert.notEqual(ledger.actor_id, FOUNDER, "the refused actor must appear nowhere on the chain");
  assert.equal(Number(ledger.sequence), 1);
  assert.equal(ledger.previous_hash, "GENESIS");
  assert.equal(Number(ledger.amount), COMMISSION);

  const journal = sqlite.prepare("SELECT account_code,debit,credit FROM finance_journal_entries WHERE source_id=? AND source_type='escrow_custody_reserve' ORDER BY account_code").all(BOOKING);
  assert.equal(journal.length, 2, "the reserve posts exactly one balanced pair");
  assert.equal(journal[0].account_code, "2230-Customer Collections");
  assert.equal(Number(journal[0].debit), COMMISSION);
  assert.equal(journal[1].account_code, "2240-Escrow Custody Liability");
  assert.equal(Number(journal[1].credit), COMMISSION);

  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='partner.commission.approve.level1' AND actor_email=?").get(FINANCE).n,
    1,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='partner.commission.approve.level1' AND actor_email=?").get(FOUNDER).n,
    0,
  );
});

// ---- 3. duplicatePrevented cannot be reached through a refusal ----------------------------------

test("no refused attempt can make a later approval look like a duplicate reserve", async () => {
  const { sqlite, db } = partnerFinanceWorld();
  await awaitingLevelOneApproval(sqlite, db);

  // Several refusals in a row: the founder (maker) repeatedly, which is what a confused operator does.
  for (let attempt = 0; attempt < 3; attempt++) {
    const refused = await post(FOUNDER, { action: "approve_order_commission_level_1", bookingId: BOOKING });
    assert.ok(refused.status >= 400 && refused.status < 500, JSON.stringify(refused.body));
    assertNoMoneyTrail(sqlite, `refusal #${attempt + 1}`);
  }

  const approved = await post(FINANCE, { action: "approve_order_commission_level_1", bookingId: BOOKING });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.escrow.duplicatePrevented, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM escrow_ledger_transactions WHERE event_type='CUSTODY_RESERVED'").get().n, 1);

  // Re-running the now-complete level 1 is refused on state, and still adds nothing to the chain.
  const replay = await post(FINANCE, { action: "approve_order_commission_level_1", bookingId: BOOKING });
  assert.equal(replay.status, 409, JSON.stringify(replay.body));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM escrow_ledger_transactions").get().n, 1);
});

// ---- 4. Refusals reach the operator; platform faults stay redacted -------------------------------

test("a governance refusal returns its real reason as a 4xx, a platform fault stays a redacted 500", async () => {
  const { sqlite, db } = partnerFinanceWorld();
  await awaitingLevelOneApproval(sqlite, db);

  const refused = await post(FOUNDER, { action: "approve_order_commission_level_1", bookingId: BOOKING });
  assert.equal(refused.status, 409, "a deliberate refusal is not a server fault");
  assert.notEqual(refused.body.error, "Unable to update partner finance");

  // A missing table is a platform defect, not a caller mistake. It must NOT be dressed up as a 409
  // with a plausible reason - that is how "no such column: verified_at" hid for a whole release.
  sqlite.exec("DROP TABLE provider_order_commissions");
  const faulted = await post(FINANCE, { action: "approve_order_commission_level_1", bookingId: BOOKING });
  assert.equal(faulted.status, 500);
  assert.equal(faulted.body.error, "Unable to update partner finance");
});
