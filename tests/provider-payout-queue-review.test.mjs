/*
 * Review fixes for the provider payout queue (owner decision 6, 26 Sept 2026). Each test EXECUTES the real
 * queue, release, journal and route code on the in-memory SQLite harness and pins a way the first version
 * could pay the wrong amount, pay while the customer disputes the job, or leave the books wrong:
 *
 *  - a customer dispute about a COMPLETED job (the service_dispute case the cancellation flow opens) must
 *    hold the payout, not only complaint cases and escrow freezes;
 *  - a full refund that later fails at the gateway must give the provider their payout back;
 *  - two releases at once for the same provider must not both take the same earlier overpayment, and a
 *    release must not land on a payout the scheduled check reduced or blocked while the click was running;
 *  - a payout is never left between Rs 0 and Rs 1, which no bank payout can carry;
 *  - a taxi vehicle owner is paid without the scheduled check running the taxi fleet set-up and seed rows;
 *  - the sweep's journal reads use an index instead of scanning the whole finance journal;
 *  - the older commission sync (run on every Finance page load) costs the same few queries however many
 *    bookings the queue owns, and never adds an older row for a booking the queue will pay;
 *  - a release whose bookkeeping step fails after the money moved is reported as released, not refused;
 *  - Finance's "Check for due payouts now" stays inside the Worker's 1,000-query budget on a busy queue;
 *  - approving the Dog Walking settlement afterwards does not overwrite the payout status the queue wrote,
 *    and the accounts view still counts a payout waiting for release as owed to the provider;
 *  - the payout hold cannot be back-dated, and a refused release is still audited.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";
import { enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PAYOUT_REVIEW_DB__", "__PAYOUT_REVIEW_ENV__");
process.env.FORBID_PRODUCTION = "true";

const DAY = 86_400_000;
const SANDBOX = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" };
const FINANCE = "payout.review@pawspace.test";
const hold = await import("../lib/provider-payout-hold.ts");
const queue = await import("../lib/provider-payout-queue.ts");
const accounts = await import("../lib/finance-accounts.ts");
const commission = await import("../lib/provider-commission-governance.ts");

function payoutWorld(env = SANDBOX) {
  const { sqlite, db } = world("__PAYOUT_REVIEW_DB__", "__PAYOUT_REVIEW_ENV__", env);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT,detail_json TEXT DEFAULT '{}',occurred_at INTEGER NOT NULL);
    CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_verifications (id TEXT PRIMARY KEY,application_id TEXT NOT NULL,verification_type TEXT NOT NULL,status TEXT NOT NULL,verified_at INTEGER,expires_at INTEGER,created_at INTEGER,updated_at INTEGER);
  `);
  return { sqlite, db };
}

async function verifiedProvider(sqlite, db, providerId) {
  await commission.ensureProviderCommissionTables(db);
  const now = Date.now(), key = providerId.replace(/[^A-Za-z0-9]/g, "");
  sqlite.prepare("INSERT OR REPLACE INTO provider_compensation_profiles (provider_id,engagement_model,default_commission_mode,default_commission_value,razorpayx_contact_id,razorpayx_fund_account_id,status,reason,updated_by,created_at,updated_at) VALUES (?,'commission','percent',70,?,?,'active','payout review fixture','finance',?,?)")
    .run(providerId, `cont_${key}`, `fa_${key}`, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_onboarding_applications (id,provider_id,status,created_at,updated_at) VALUES (?,?,'approved',?,?)").run(`APP-${providerId}`, providerId, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_verifications (id,application_id,verification_type,status,verified_at,expires_at,created_at,updated_at) VALUES (?,?,'bank_kyc','verified',?,NULL,?,?)").run(`VER-${providerId}`, `APP-${providerId}`, now, now, now);
}

const iso = (at) => new Date(at).toISOString().slice(0, 10);
/** A completed commission booking whose completion journal credited 2110-Provider Payable, as the completion engines post it. */
async function completedBooking(sqlite, db, { id, providerId, service = "pet_grooming", total = 1000, payable = 700, gst = 54, completedAt = Date.now() - 8 * DAY }) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,status,total_amount,currency,created_at,updated_at) VALUES (?,'CUS-REV','blr',?,?,'completed',?,'INR',?,?)").run(id, service, providerId, total, completedAt, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_model,service_code,status,created_at,updated_at) VALUES (?,?,?,'commission',?,'completed',?,?)").run(`WO-${id}`, id, providerId, service, completedAt, now);
  sqlite.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,actor_id,occurred_at) VALUES (?,?,'booking_completed','provider',?)").run(`EV-${id}`, id, completedAt);
  await accounts.postJournal(db, {
    groupKey: `TEST-COMPLETION-${id}`, entryDate: iso(completedAt), periodCode: iso(completedAt).slice(0, 7), sourceType: "service_completion", sourceId: id,
    narration: `Service completion ${id}`, metadata: { bookingId: id },
    lines: [
      { accountCode: "2230-Customer Collections", debit: total },
      { accountCode: "2110-Provider Payable", credit: payable },
      { accountCode: "2130-GST Payable", credit: gst },
      { accountCode: "4000-Service Revenue", credit: Math.round((total - payable - gst) * 100) / 100 },
    ],
  });
}
const refund = (sqlite, bookingId, amount, status = "completed") =>
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,amount,reason,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,'support',?,?)")
    .run(`RF-${bookingId}-${amount}-${Math.random().toString(36).slice(2, 7)}`, bookingId, amount, "Customer refund", status, Date.now(), Date.now());
const item = (sqlite, bookingId) => sqlite.prepare("SELECT * FROM provider_payout_queue_items WHERE booking_id=?").get(bookingId);
const payouts = (sqlite, bookingId) => sqlite.prepare("SELECT * FROM provider_order_payouts WHERE booking_id=?").all(bookingId);
const ledger = (sqlite, account, bookingId) => Number(sqlite.prepare("SELECT ROUND(COALESCE(SUM(credit-debit),0),2) n FROM finance_journal_entries WHERE account_code=? AND source_id=?").get(account, bookingId).n);
const accountBalance = (sqlite, account) => Number(sqlite.prepare("SELECT ROUND(COALESCE(SUM(debit-credit),0),2) n FROM finance_journal_entries WHERE account_code=?").get(account).n);
function assertBooksBalance(sqlite) {
  const totals = sqlite.prepare("SELECT ROUND(SUM(debit),2) d,ROUND(SUM(credit),2) c FROM finance_journal_entries").get();
  assert.equal(Number(totals.d), Number(totals.c), "every journal the payout path posts must balance");
}

test("a customer dispute about a completed job holds the payout until the case is closed", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-SD");
  await completedBooking(sqlite, db, { id: "BK-SD", providerId: "PRV-SD" });
  // The real cancellation-case flow: a completed booking cannot be cancelled, so the request opens a service_dispute.
  const cases = await import("../lib/cancellation-case-governance.ts");
  const opened = await cases.openCancellationCase(db, { bookingId: "BK-SD", customerId: "CUS-REV", serviceCode: "pet_grooming", cityId: "blr", bookingStatus: "completed", requestedBy: "CUS-REV", reasonText: "The groomer cut my dog's fur far too short" });
  assert.equal(opened.case.caseType ?? sqlite.prepare("SELECT case_type FROM booking_cancellation_cases WHERE booking_id='BK-SD'").get().case_type, "service_dispute");

  const run = await queue.runProviderPayoutQueueSweep(db, { force: true });
  assert.deepEqual(run.errors, []);
  assert.equal(item(sqlite, "BK-SD"), undefined, "a disputed job is not queued");
  const candidate = sqlite.prepare("SELECT reason,detail FROM provider_payout_candidates WHERE booking_id='BK-SD'").get();
  assert.equal(candidate.reason, "dispute_open");
  assert.match(candidate.detail, /disputed this completed service/);

  // Once the dispute is closed the payout is queued; a dispute opened after queuing holds the release.
  sqlite.prepare("UPDATE booking_cancellation_cases SET status='closed' WHERE booking_id='BK-SD'").run();
  await queue.runProviderPayoutQueueSweep(db, { force: true });
  assert.equal(item(sqlite, "BK-SD").status, "awaiting_release");
  sqlite.prepare("UPDATE booking_cancellation_cases SET status='awaiting_finance' WHERE booking_id='BK-SD'").run();
  const release = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-SD"], actor: FINANCE });
  assert.equal(release.released.length, 0);
  assert.match(release.refused[0].error, /A customer dispute or complaint is open/);
  assert.equal(payouts(sqlite, "BK-SD").length, 0);
});

test("a full refund that later fails gives the provider the payout back, with the books restored", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-RF");
  await completedBooking(sqlite, db, { id: "BK-RF", providerId: "PRV-RF" });
  await queue.runProviderPayoutQueueSweep(db, {});
  refund(sqlite, "BK-RF", 1000, "processing");
  await queue.runProviderPayoutQueueSweep(db, { force: true });
  assert.equal(item(sqlite, "BK-RF").status, "cancelled");
  assert.equal(ledger(sqlite, "2110-Provider Payable", "BK-RF"), 0);

  // The gateway refused the refund: the customer keeps paying for the job, so the provider is owed again.
  sqlite.prepare("UPDATE booking_refund_cases SET status='failed' WHERE booking_id='BK-RF'").run();
  const run = await queue.runProviderPayoutQueueSweep(db, { asOf: Date.now() + DAY + 60_000 });
  assert.deepEqual(run.errors, []);
  assert.equal(run.reopened, 1);
  const reopened = item(sqlite, "BK-RF");
  assert.equal(reopened.status, "awaiting_release");
  assert.equal(Number(reopened.amount), 700);
  assert.equal(ledger(sqlite, "2110-Provider Payable", "BK-RF"), 700, "the provider payable taken off at cancellation is restored");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_queue_events WHERE booking_id='BK-RF' AND event_type='payout_reopened_refund_reversed'").get().n, 1);
  const released = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-RF"], actor: FINANCE });
  assert.equal(released.released[0].amount, 700);
  assert.equal(payouts(sqlite, "BK-RF").length, 1);
  assertBooksBalance(sqlite);
  assert.equal((await queue.reconcileProviderPayable(db)).ok, true);
});

test("two releases at once for one provider take an earlier overpayment only once", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-RACE");
  await completedBooking(sqlite, db, { id: "BK-RACE-0", providerId: "PRV-RACE", completedAt: Date.now() - 10 * DAY });
  await queue.runProviderPayoutQueueSweep(db, {});
  await queue.releaseProviderPayouts(db, { bookingIds: ["BK-RACE-0"], actor: FINANCE });
  refund(sqlite, "BK-RACE-0", 200);
  await queue.runProviderPayoutQueueSweep(db, { asOf: Date.now() + 2 * 3600_000 });
  assert.equal(Number(sqlite.prepare("SELECT amount FROM provider_payout_recoveries").get().amount), 140);
  await completedBooking(sqlite, db, { id: "BK-RACE-1", providerId: "PRV-RACE" });
  await completedBooking(sqlite, db, { id: "BK-RACE-2", providerId: "PRV-RACE" });
  await queue.runProviderPayoutQueueSweep(db, { force: true });

  // Hold both release transactions until both clicks have worked out their figures, as two Finance users
  // clicking at the same moment on D1 can: each sees the same open Rs 140 recovery.
  let arrived = 0, open;
  const gate = new Promise((resolve) => { open = resolve; });
  const racing = { ...db, batch: async (list) => {
    if (String(list[0]?.sql || "").startsWith("UPDATE provider_payout_queue_items SET status='released'")) { arrived++; if (arrived >= 2) open(); await gate; }
    return db.batch(list);
  } };
  const [a, b] = await Promise.all([
    queue.releaseProviderPayouts(racing, { bookingIds: ["BK-RACE-1"], actor: FINANCE }),
    queue.releaseProviderPayouts(racing, { bookingIds: ["BK-RACE-2"], actor: "second.finance@pawspace.test" }),
  ]);
  assert.equal(arrived, 2, "both releases reached their transaction with the same figures");
  assert.equal(a.released.length + b.released.length, 1, "the second deduction of the same recovery is refused, not committed");
  assert.match([...a.refused, ...b.refused][0].error, /refresh and release again/);
  const retryId = a.released.length ? "BK-RACE-2" : "BK-RACE-1";
  const retry = await queue.releaseProviderPayouts(db, { bookingIds: [retryId], actor: FINANCE });
  assert.equal(retry.released[0].recoveryDeducted, 0);
  assert.equal(retry.released[0].amount, 700);

  const recovery = sqlite.prepare("SELECT amount,recovered_amount,status FROM provider_payout_recoveries").get();
  assert.equal(Number(recovery.recovered_amount), 140);
  assert.equal(recovery.status, "recovered");
  const paid = Number(sqlite.prepare("SELECT ROUND(SUM(amount),2) n FROM provider_order_payouts WHERE booking_id IN ('BK-RACE-1','BK-RACE-2')").get().n);
  assert.equal(paid, 1260, "700 + 700 earned, less the 140 overpaid once");
  assert.equal(accountBalance(sqlite, "1310-Provider Recoveries Receivable"), 0, "the receivable is cleared exactly, not over-credited");
  assertBooksBalance(sqlite);
});

test("a recovery never leaves a payout between Rs 0 and Rs 1, and a payout under Rs 1 is held", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-MIN");
  await completedBooking(sqlite, db, { id: "BK-MIN-0", providerId: "PRV-MIN", completedAt: Date.now() - 10 * DAY });
  await queue.runProviderPayoutQueueSweep(db, {});
  await queue.releaseProviderPayouts(db, { bookingIds: ["BK-MIN-0"], actor: FINANCE });
  refund(sqlite, "BK-MIN-0", 999);
  await queue.runProviderPayoutQueueSweep(db, { asOf: Date.now() + 2 * 3600_000 });
  assert.equal(Number(sqlite.prepare("SELECT amount FROM provider_payout_recoveries").get().amount), 699.3, "700 paid, 0.70 earned after a Rs 999 refund");

  await completedBooking(sqlite, db, { id: "BK-MIN-1", providerId: "PRV-MIN" });
  await queue.runProviderPayoutQueueSweep(db, { force: true });
  const next = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-MIN-1"], actor: FINANCE });
  assert.equal(next.released[0].recoveryDeducted, 699, "Rs 1 is left so a real payout can carry it");
  assert.equal(next.released[0].amount, 1);
  assert.equal(payouts(sqlite, "BK-MIN-1").length, 1);
  assert.equal(Number(sqlite.prepare("SELECT amount-recovered_amount n FROM provider_payout_recoveries").get().n).toFixed(2), "0.30", "the rest waits for the next payout");
  assert.equal(ledger(sqlite, "2115-Provider Payouts in Transit", "BK-MIN-1"), 1);

  // A payable that is itself under Rs 1 cannot be sent at all: it waits with a plain reason, nothing in transit.
  await completedBooking(sqlite, db, { id: "BK-TINY", providerId: "PRV-MIN", total: 1, payable: 0.7, gst: 0.05 });
  await queue.runProviderPayoutQueueSweep(db, { force: true });
  const dashboard = await queue.getProviderPayoutQueueDashboard(db);
  const tiny = dashboard.queue.find((row) => row.booking_id === "BK-TINY");
  assert.equal(tiny.releasable, false);
  assert.equal(tiny.blockedLabel, "Less than Rs 1 to pay, too small for a bank payout");
  const refused = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-TINY"], actor: FINANCE });
  assert.equal(refused.released.length, 0);
  assert.match(refused.refused[0].error, /Less than Rs 1/);
  assert.equal(item(sqlite, "BK-TINY").status, "awaiting_release");
  assert.equal(ledger(sqlite, "2115-Provider Payouts in Transit", "BK-TINY"), 0);
  assertBooksBalance(sqlite);
});

test("a taxi vehicle owner is paid without the scheduled check running the taxi fleet set-up", async () => {
  const { sqlite, db } = payoutWorld();
  const fleet = await import("../lib/taxi-fleet-governance.ts");
  await fleet.ensureTaxiFleetTables(db);
  // This city's fleet is its own: the UAT seed vehicles were removed, and a partner-owned car is on the trip.
  sqlite.exec("DELETE FROM taxi_driver_vehicle_eligibility; DELETE FROM taxi_fleet_vehicles;");
  const now = Date.now();
  sqlite.prepare("INSERT INTO taxi_fleet_vehicles (id,vehicle_class,label,registration_suffix,ownership_model,pawspace_share_percent,owner_commission_percent,gst_rate,gst_base,inspection_status,active,features_json,created_at,updated_at,city_id,commercial_mode,owner_provider_id) VALUES ('TXF-OWNER-1','citroen_ec3','Partner car','OWN1','provider_owned',30,70,0.18,'pawspace_share','uat_verified',1,'[]',?,?,'blr','fixed','PRV-CAR-OWNER')").run(now, now);
  await verifiedProvider(sqlite, db, "PRV-CAR-OWNER");
  await verifiedProvider(sqlite, db, "PRV-DRIVER");
  await completedBooking(sqlite, db, { id: "BK-TAXI", providerId: "PRV-DRIVER", service: "pet_taxi" });
  sqlite.prepare("INSERT INTO taxi_fleet_reservations (id,vehicle_id,provider_id,quote_id,booking_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('TXR-1','TXF-OWNER-1','PRV-DRIVER','Q-1','BK-TAXI','2026-09-17T09:00','2026-09-17T12:00','confirmed',?,?)").run(now, now);

  const run = await queue.runProviderPayoutQueueSweep(db, { force: true });
  assert.deepEqual(run.errors, []);
  assert.equal(item(sqlite, "BK-TAXI").provider_id, "PRV-CAR-OWNER", "the vehicle owner is the payee");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM taxi_fleet_vehicles").get().n, 1, "a payout check writes no taxi seed vehicles");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM taxi_driver_vehicle_eligibility").get().n, 0);
});

test("the sweep reads the finance journal through an index, not a full scan", async () => {
  const { sqlite, db } = payoutWorld();
  await queue.ensureProviderPayoutQueueTables(db);
  const plan = (sql) => sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => String(row.detail)).join("\n");
  const payable = plan("SELECT COUNT(*) n,ROUND(COALESCE(SUM(credit-debit),0),2) amount FROM finance_journal_entries WHERE source_type='service_completion' AND source_id='BK-1' AND account_code='2110-Provider Payable' AND posted=1");
  assert.match(payable, /USING (COVERING )?INDEX idx_finance_journal_source/, payable);
  const candidates = plan("SELECT j.source_id,ROUND(SUM(j.credit-j.debit),2) payable FROM finance_journal_entries j WHERE j.source_type='service_completion' AND j.account_code='2110-Provider Payable' AND j.posted=1 GROUP BY j.source_id");
  assert.match(candidates, /SEARCH j USING (COVERING )?INDEX idx_finance_journal_source/, candidates);
});

test("the payout hold cannot be back-dated", async () => {
  const { db } = payoutWorld();
  await assert.rejects(
    () => hold.setProviderPayoutHoldDays(db, { days: 3, reason: "Shorten the hold for last week's jobs", actor: FINANCE, effectiveFrom: Date.now() - 3 * DAY }),
    (e) => e instanceof Response && e.status === 400,
  );
  assert.equal(await hold.providerPayoutHoldDays(db, Date.now() - 2 * DAY), 7, "jobs already completed keep the hold they were completed under");
});

test("a release refused because the environment is live is still audited", async () => {
  const { sqlite, db } = payoutWorld({ ...SANDBOX, PAWSPACE_PAYMENT_ENV: "live" });
  await seedActors(sqlite, db, [{ id: "USR-REV-FIN", email: FINANCE, role: "finance" }]);
  await verifiedProvider(sqlite, db, "PRV-LIVE-AUDIT");
  await completedBooking(sqlite, db, { id: "BK-LIVE-AUDIT", providerId: "PRV-LIVE-AUDIT" });
  await queue.runProviderPayoutQueueSweep(db, {});
  const route = await import("../app/api/partner-finance/route.ts");
  const response = await route.POST(asActor(FINANCE, "/api/partner-finance", { method: "POST", body: JSON.stringify({ action: "release_provider_payout", bookingIds: ["BK-LIVE-AUDIT"] }) }));
  assert.equal(response.status, 409);
  const audit = sqlite.prepare("SELECT outcome,detail_json FROM security_audit_events WHERE action='partner.payout.release'").all();
  assert.equal(audit.length, 1, "the refused live release leaves an audit row");
  assert.equal(audit[0].outcome, "rejected");
  assert.match(audit[0].detail_json, /BK-LIVE-AUDIT/);
  assert.equal(payouts(sqlite, "BK-LIVE-AUDIT").length, 0);
});

test("released payouts are described in plain English on the Finance screen", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-LABEL");
  await completedBooking(sqlite, db, { id: "BK-LABEL", providerId: "PRV-LABEL" });
  await queue.runProviderPayoutQueueSweep(db, {});
  await queue.releaseProviderPayouts(db, { bookingIds: ["BK-LABEL"], actor: FINANCE });
  const dashboard = await queue.getProviderPayoutQueueDashboard(db);
  assert.equal(dashboard.queue.find((row) => row.booking_id === "BK-LABEL").statusLabel, "Released, waiting for Send TEST payout");
});

test("the older commission sync costs a few queries however many bookings the queue owns", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-SYNC");
  for (let index = 0; index < 30; index++) await completedBooking(sqlite, db, { id: `BK-SYNC-${index}`, providerId: "PRV-SYNC", completedAt: Date.now() - (index < 10 ? 8 : 2) * DAY });
  await queue.runProviderPayoutQueueSweep(db, { force: true, limit: 50 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_queue_items").get().n, 10, "the due ones are queued, the rest are still in their hold");
  await commission.ensureProviderCommissionTables(db);
  let prepared = 0;
  const counting = { ...db, prepare: (sql) => { prepared++; return db.prepare(sql); } };
  assert.equal(await commission.syncCompletedCommissionOrders(counting), 0, "no older row for bookings the queue owns or will pay");
  assert.ok(prepared <= 10, `the sync ran ${prepared} queries for 30 bookings`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_order_commissions").get().n, 0);
});

test("a release whose bookkeeping fails after the money moved is reported as released, not refused", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-FOLLOW");
  await completedBooking(sqlite, db, { id: "BK-FOLLOW", providerId: "PRV-FOLLOW", service: "boarding" });
  await queue.runProviderPayoutQueueSweep(db, {});
  // A boarding settlement ledger that cannot take the payout status (an older shape without the column).
  sqlite.exec("CREATE TABLE boarding_host_settlement_ledger (booking_id TEXT PRIMARY KEY,payout_status TEXT NOT NULL,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO boarding_host_settlement_ledger VALUES ('BK-FOLLOW','not_instructed',0)").run();
  const result = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-FOLLOW"], actor: FINANCE });
  assert.deepEqual(result.refused, [], "the payout record exists, so the click must not read as refused");
  assert.equal(result.released.length, 1);
  assert.match(result.released[0].followUp, /books were not updated yet/);
  assert.equal(payouts(sqlite, "BK-FOLLOW").length, 1);
  assert.equal(item(sqlite, "BK-FOLLOW").status, "released");
  const again = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-FOLLOW"], actor: FINANCE });
  assert.equal(again.released[0].duplicatePrevented, true);
  assert.equal(payouts(sqlite, "BK-FOLLOW").length, 1);
  assertBooksBalance(sqlite);
});

test("Check for due payouts now stays inside the Worker's per-request query budget on a busy queue", async () => {
  const { sqlite, db } = payoutWorld();
  await seedActors(sqlite, db, [{ id: "USR-REV-BUDGET", email: FINANCE, role: "finance" }]);
  for (let p = 0; p < 25; p++) await verifiedProvider(sqlite, db, `PRV-BUSY-${p}`);
  // 25 released payouts still watched for refunds, 25 queued payouts to re-check, 25 newly due bookings.
  for (let i = 0; i < 50; i++) await completedBooking(sqlite, db, { id: `BK-BUSY-${i}`, providerId: `PRV-BUSY-${i % 25}`, completedAt: Date.now() - 9 * DAY });
  await queue.runProviderPayoutQueueSweep(db, { force: true, limit: 50 });
  await queue.releaseProviderPayouts(db, { bookingIds: Array.from({ length: 25 }, (_, i) => `BK-BUSY-${i}`), actor: FINANCE });
  for (let i = 50; i < 75; i++) await completedBooking(sqlite, db, { id: `BK-BUSY-${i}`, providerId: `PRV-BUSY-${i % 25}`, completedAt: Date.now() - 9 * DAY });
  sqlite.prepare("UPDATE provider_payout_queue_items SET checked_at=0").run();

  let queries = 0;
  const counting = { ...db, prepare: (sql) => { queries++; return db.prepare(sql); } };
  enterWorkersDbScope(counting);
  const route = await import("../app/api/partner-finance/route.ts");
  const response = await route.POST(asActor(FINANCE, "/api/partner-finance", { method: "POST", body: JSON.stringify({ action: "run_payout_queue" }) }));
  enterWorkersDbScope(db);
  assert.equal(response.status, 200, await response.clone().text());
  const data = (await response.json()).data;
  assert.deepEqual(data.errors, []);
  assert.ok(data.queued > 0 && data.refreshed > 0, "every phase had work to do");
  assert.ok(queries < 1000, `one click ran ${queries} D1 queries; a Worker request may run at most 1,000`);
});

test("a release does not land on a payout the scheduled check reduced while the click was running", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-MID");
  await completedBooking(sqlite, db, { id: "BK-MID", providerId: "PRV-MID" });
  await queue.runProviderPayoutQueueSweep(db, {});
  let hold, reached;
  const held = new Promise((resolve) => { hold = resolve; }), atBatch = new Promise((resolve) => { reached = resolve; });
  const slow = { ...db, batch: async (list) => {
    if (String(list[0]?.sql || "").startsWith("UPDATE provider_payout_queue_items SET status='released'")) { reached(); await held; }
    return db.batch(list);
  } };
  const clicking = queue.releaseProviderPayouts(slow, { bookingIds: ["BK-MID"], actor: FINANCE });
  await atBatch;
  // Meanwhile a Rs 200 refund is processed and the scheduled check reduces the payout to 560.
  refund(sqlite, "BK-MID", 200);
  await queue.runProviderPayoutQueueSweep(db, { force: true });
  assert.equal(Number(item(sqlite, "BK-MID").amount), 560);
  hold();
  const result = await clicking;
  assert.equal(result.released.length, 0, "the click assessed 700 and must not pay it");
  assert.match(result.refused[0].error, /changed while it was being released/);
  assert.equal(payouts(sqlite, "BK-MID").length, 0);
  const again = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-MID"], actor: FINANCE });
  assert.equal(again.released[0].amount, 560);
  assert.equal(ledger(sqlite, "2110-Provider Payable", "BK-MID"), 0);
  assertBooksBalance(sqlite);
  assert.equal((await queue.reconcileProviderPayable(db)).ok, true);
});

test("approving the Dog Walking settlement after release keeps the payout status the queue wrote", async () => {
  const { sqlite, db } = payoutWorld();
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,status TEXT)");
  const walking = await import("../lib/walking-finance-governance.ts");
  await walking.ensureWalkingFinanceTables(db);
  await verifiedProvider(sqlite, db, "PRV-WALK");
  await completedBooking(sqlite, db, { id: "BK-WALK", providerId: "PRV-WALK", service: "dog_walking" });
  const now = Date.now();
  sqlite.prepare("INSERT INTO walking_walker_settlement_ledger (booking_id,provider_id,gross_paid_value,currency,base_payout,payout_amount,payout_rule_status,tax_status,approval_status,payout_status,eligible_at,created_at,updated_at) VALUES ('BK-WALK','PRV-WALK',1000,'INR',700,700,'canonical_provider_payable','resolved','awaiting_finance_approval','accrued',?,?,?)").run(now - DAY, now, now);
  await queue.runProviderPayoutQueueSweep(db, {});
  await queue.releaseProviderPayouts(db, { bookingIds: ["BK-WALK"], actor: FINANCE });
  assert.equal(sqlite.prepare("SELECT payout_status FROM walking_walker_settlement_ledger WHERE booking_id='BK-WALK'").get().payout_status, "released_sandbox");
  await walking.mutateWalkingFinance(db, { bookingId: "BK-WALK", action: "approve_settlement", actorId: FINANCE, idempotencyKey: "walk-approve-1", reason: "Walker settlement reviewed" });
  const row = sqlite.prepare("SELECT approval_status,payout_status FROM walking_walker_settlement_ledger WHERE booking_id='BK-WALK'").get();
  assert.equal(row.approval_status, "ready");
  assert.equal(row.payout_status, "released_sandbox", "the ledger keeps showing that the queue already released the payout");
});

test("the accounts view still counts a payout waiting for Finance's release as owed to the provider", async () => {
  const { sqlite, db } = payoutWorld();
  sqlite.exec("CREATE TABLE sitting_sitter_settlement_ledger (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,payout_amount REAL,payout_status TEXT NOT NULL,payout_reference TEXT,updated_at INTEGER)");
  await verifiedProvider(sqlite, db, "PRV-VIEW");
  await completedBooking(sqlite, db, { id: "BK-VIEW", providerId: "PRV-VIEW", service: "pet_sitting" });
  sqlite.prepare("INSERT INTO sitting_sitter_settlement_ledger VALUES ('BK-VIEW','PRV-VIEW',700,'not_instructed',NULL,0)").run();
  const view = await import("../lib/accounts-business-view.ts");
  assert.equal((await view.buildAccountsBusinessView(db)).providerPayable.amount, 700);
  await queue.runProviderPayoutQueueSweep(db, {});
  assert.equal(sqlite.prepare("SELECT payout_status FROM sitting_sitter_settlement_ledger").get().payout_status, "queued_for_release");
  assert.equal((await view.buildAccountsBusinessView(db)).providerPayable.amount, 700, "queued is not paid: it is still owed");
  await queue.releaseProviderPayouts(db, { bookingIds: ["BK-VIEW"], actor: FINANCE });
  assert.equal((await view.buildAccountsBusinessView(db)).providerPayable.amount, 0, "released: no longer owed");
});
