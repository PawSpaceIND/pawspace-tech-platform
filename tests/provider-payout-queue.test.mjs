/*
 * Provider payouts, owner decision 6 (26 Sept 2026): commission providers become payable 7 calendar
 * days after the service completion event in every vertical, a scheduled job queues each due booking
 * once, and ONE Finance click releases it. Live money stays behind the live-payout approvals.
 *
 * Everything here EXECUTES the real modules on an in-memory SQLite database: the hold setting, the
 * queue job, the release, the journal, the beneficiary check and the partner-finance route. The
 * completion journal a booking starts from is posted with the real journal helper, exactly as the
 * completion engines post it (source_type 'service_completion', 2110-Provider Payable credited).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__PAYOUT_QUEUE_DB__", "__PAYOUT_QUEUE_ENV__");
process.env.FORBID_PRODUCTION = "true";

const DAY = 86_400_000;
const SANDBOX = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" };
const FINANCE = "payout.finance@pawspace.test";
const hold = await import("../lib/provider-payout-hold.ts");
const queue = await import("../lib/provider-payout-queue.ts");
const accounts = await import("../lib/finance-accounts.ts");
const commission = await import("../lib/provider-commission-governance.ts");

function payoutWorld(env = SANDBOX) {
  const { sqlite, db } = world("__PAYOUT_QUEUE_DB__", "__PAYOUT_QUEUE_ENV__", env);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT,detail_json TEXT DEFAULT '{}',occurred_at INTEGER NOT NULL);
    CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE unified_cases (id TEXT PRIMARY KEY,case_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',title TEXT NOT NULL,booking_id TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_verifications (id TEXT PRIMARY KEY,application_id TEXT NOT NULL,verification_type TEXT NOT NULL,status TEXT NOT NULL,verified_at INTEGER,expires_at INTEGER,created_at INTEGER,updated_at INTEGER);
  `);
  return { sqlite, db };
}

/** A provider with an active profile, RazorpayX TEST bindings and verified bank KYC. */
async function verifiedProvider(sqlite, db, providerId, { verified = true } = {}) {
  await commission.ensureProviderCommissionTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO provider_compensation_profiles (provider_id,engagement_model,default_commission_mode,default_commission_value,razorpayx_contact_id,razorpayx_fund_account_id,status,reason,updated_by,created_at,updated_at) VALUES (?,'commission','percent',70,?,?,'active','payout queue fixture','finance',?,?)")
    .run(providerId, `cont_${providerId.replace(/[^A-Za-z0-9]/g, "")}`, `fa_${providerId.replace(/[^A-Za-z0-9]/g, "")}`, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_onboarding_applications (id,provider_id,status,created_at,updated_at) VALUES (?,?,'approved',?,?)").run(`APP-${providerId}`, providerId, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_verifications (id,application_id,verification_type,status,verified_at,expires_at,created_at,updated_at) VALUES (?,?,'bank_kyc',?,?,NULL,?,?)")
    .run(`VER-${providerId}`, `APP-${providerId}`, verified ? "verified" : "pending", verified ? now : null, now, now);
}

const iso = (at) => new Date(at).toISOString().slice(0, 10);
/** A completed commission booking whose completion journal credited the provider payable. */
async function completedBooking(sqlite, db, { id, providerId, service = "pet_grooming", total = 1000, payable = 700, gst = 54, completedAt }) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,status,total_amount,currency,created_at,updated_at) VALUES (?,'CUS-PQ','blr',?,?,'completed',?,'INR',?,?)").run(id, service, providerId, total, completedAt, now);
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
    .run(`RF-${bookingId}-${amount}-${status}-${Math.random().toString(36).slice(2, 7)}`, bookingId, amount, "Customer refund", status, Date.now(), Date.now());
const item = (sqlite, bookingId) => sqlite.prepare("SELECT * FROM provider_payout_queue_items WHERE booking_id=?").get(bookingId);
const payouts = (sqlite, bookingId) => sqlite.prepare("SELECT * FROM provider_order_payouts WHERE booking_id=?").all(bookingId);
const ledger = (sqlite, account, bookingId) => Number(sqlite.prepare("SELECT ROUND(COALESCE(SUM(credit-debit),0),2) n FROM finance_journal_entries WHERE account_code=? AND source_id=?").get(account, bookingId).n);
function assertBooksBalance(sqlite) {
  const totals = sqlite.prepare("SELECT ROUND(SUM(debit),2) d,ROUND(SUM(credit),2) c FROM finance_journal_entries").get();
  assert.equal(Number(totals.d), Number(totals.c), "every journal the payout path posts must balance");
  const groups = sqlite.prepare("SELECT substr(id,1,length(id)-2) g,ROUND(SUM(debit)-SUM(credit),2) drift FROM finance_journal_entries GROUP BY g HAVING ABS(drift)>0.001").all();
  assert.deepEqual(groups, [], "no single journal group may be out of balance");
}

test("the payout hold is ONE effective-dated setting of 7 calendar days from completion", async () => {
  const { sqlite, db } = payoutWorld();
  const completedAt = Date.UTC(2026, 8, 20, 9, 0, 0);
  assert.equal(hold.DEFAULT_PROVIDER_PAYOUT_HOLD_DAYS, 7);
  assert.equal(await hold.providerPayoutHoldDays(db, completedAt), 7, "no setting row yet: the owner's 7 days apply");
  assert.equal(await hold.providerPayoutDueAt(db, completedAt), completedAt + 7 * DAY);

  await assert.rejects(() => hold.setProviderPayoutHoldDays(db, { days: 0, reason: "not allowed at all", actor: FINANCE }), (e) => e instanceof Response && e.status === 400);
  await assert.rejects(() => hold.setProviderPayoutHoldDays(db, { days: 7.5, reason: "not a whole number", actor: FINANCE }), (e) => e instanceof Response && e.status === 400);
  await assert.rejects(() => hold.setProviderPayoutHoldDays(db, { days: 10, reason: "short", actor: FINANCE }), (e) => e instanceof Response && e.status === 400);

  const changedAt = Math.max(completedAt, Date.now()) + 3 * DAY; // a change starts now or later, never in the past
  await hold.setProviderPayoutHoldDays(db, { days: 10, reason: "Owner asked for a longer complaint window", actor: FINANCE, effectiveFrom: changedAt });
  assert.equal(await hold.providerPayoutHoldDays(db, completedAt), 7, "a job completed before the change keeps the hold that applied when it was completed");
  assert.equal(await hold.providerPayoutHoldDays(db, changedAt + 1), 10);
  assert.throws(() => sqlite.prepare("UPDATE finance_payout_hold_settings SET hold_days=1").run(), /append_only/, "the setting history cannot be rewritten");
  assert.throws(() => sqlite.prepare("DELETE FROM finance_payout_hold_settings").run(), /append_only/);
});

test("every vertical becomes payable exactly 7 days after completion, and not a moment before", async () => {
  const { sqlite, db } = payoutWorld();
  const now = Date.now();
  const services = ["pet_grooming", "boarding", "pet_sitting", "dog_walking", "dog_training", "pet_taxi"];
  for (const [index, service] of services.entries()) {
    const providerId = `PRV-${service}`;
    await verifiedProvider(sqlite, db, providerId);
    await completedBooking(sqlite, db, { id: `BK-EARLY-${index}`, providerId, service, completedAt: now - 7 * DAY + 60 * 60_000 });
    await completedBooking(sqlite, db, { id: `BK-DUE-${index}`, providerId, service, completedAt: now - 7 * DAY - 60_000 });
  }
  const run = await queue.runProviderPayoutQueueSweep(db, { asOf: now, limit: 50, force: true });
  assert.deepEqual(run.errors, []);
  for (const [index, service] of services.entries()) {
    assert.equal(item(sqlite, `BK-EARLY-${index}`), undefined, `${service}: 6 days 23 hours after completion is not due`);
    const due = item(sqlite, `BK-DUE-${index}`);
    assert.ok(due, `${service}: 7 days after completion is queued`);
    assert.equal(due.hold_days, 7);
    assert.equal(Number(due.due_at) - Number(due.completed_at), 7 * DAY, `${service}: counted from the completion event`);
    assert.equal(due.status, "awaiting_release");
  }
  const early = sqlite.prepare("SELECT reason,due_at,completed_at FROM provider_payout_candidates WHERE booking_id='BK-EARLY-0'").get();
  assert.equal(early.reason, "not_due");
  assert.equal(Number(early.due_at) - Number(early.completed_at), 7 * DAY);

  // An hour and a bit later the early ones fall due and are picked up without anyone acting.
  const later = await queue.runProviderPayoutQueueSweep(db, { asOf: now + 61 * 60_000, limit: 50 });
  assert.equal(later.queued, services.length);
  for (const index of services.keys()) assert.equal(item(sqlite, `BK-EARLY-${index}`).status, "awaiting_release");
});

test("the older commission sync and the training milestones use the same 7-day hold", async () => {
  const { sqlite, db } = payoutWorld();
  const completedAt = Date.now() - DAY;
  await verifiedProvider(sqlite, db, "PRV-LEGACY");
  // No completion journal: this booking still belongs to the older flow, which now waits 7 days too.
  sqlite.prepare("INSERT INTO canonical_bookings (id,service_code,provider_id,status,total_amount,updated_at) VALUES ('BK-LEGACY','pet_grooming','PRV-LEGACY','completed',1000,?)").run(completedAt);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_model,status) VALUES ('WO-LEGACY','BK-LEGACY','PRV-LEGACY','commission','completed')").run();
  sqlite.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,occurred_at) VALUES ('EV-LEGACY','BK-LEGACY','booking_completed',?)").run(completedAt);
  await commission.syncCompletedCommissionOrders(db);
  const legacy = sqlite.prepare("SELECT completed_at,due_at FROM provider_order_commissions WHERE booking_id='BK-LEGACY'").get();
  assert.equal(Number(legacy.due_at) - Number(legacy.completed_at), 7 * DAY);

  const training = await import("../lib/training-commission-payout.ts");
  await training.ensureTrainingCommissionPayoutTables(db);
  sqlite.exec("CREATE TABLE training_programmes (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,total_sessions INTEGER); CREATE TABLE training_sessions (id TEXT PRIMARY KEY,programme_id TEXT,booking_id TEXT,sequence_no INTEGER,status TEXT,completed_at INTEGER,updated_at INTEGER);");
  sqlite.prepare("INSERT INTO canonical_bookings (id,service_code,provider_id,status,total_amount,updated_at) VALUES ('BK-TRN','dog_training','PRV-LEGACY','in_progress',10000,?)").run(completedAt);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_model,status) VALUES ('WO-TRN','BK-TRN','PRV-LEGACY','commission','assigned')").run();
  sqlite.prepare("INSERT INTO training_programmes VALUES ('PG-TRN','BK-TRN','PRV-LEGACY',2)").run();
  sqlite.prepare("INSERT INTO training_sessions VALUES ('S1','PG-TRN','BK-TRN',1,'completed',?,?)").run(completedAt, completedAt);
  sqlite.prepare("INSERT INTO training_sessions VALUES ('S2','PG-TRN','BK-TRN',2,'locked',NULL,?)").run(completedAt);
  // Owner decision 8 / G14: the milestone share comes from the trainer's commercial term. The older profile percentage was
  // carried over once, for the services known then (grooming), so training gets its own approved term.
  const terms = await import("../lib/provider-commercial-terms.ts");
  const trainerTerm = await terms.saveCommercialTerm(db, { serviceCode: "dog_training", providerId: "PRV-LEGACY", engagementModel: "commission_standard", providerSharePct: 0.70, effectiveFrom: "2026-01-01", reason: "Trainer commercial terms", actorId: "terms.maker@pawspace.test" });
  await terms.activateCommercialTerm(db, { termId: trainerTerm.id, approvalReference: "TEST-TRN", actorId: "terms.checker@pawspace.test" });
  await training.syncTrainingCommissionPayoutMilestones(db, completedAt + DAY);
  const milestone = sqlite.prepare("SELECT reached_at,due_at,status FROM training_commission_payout_milestones WHERE booking_id='BK-TRN'").get();
  assert.equal(Number(milestone.due_at) - Number(milestone.reached_at), 7 * DAY);
  assert.equal(milestone.status, "waiting_payout_hold");
});

test("the job queues a booking exactly once, however often it runs", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-ONCE");
  await completedBooking(sqlite, db, { id: "BK-ONCE", providerId: "PRV-ONCE", completedAt: Date.now() - 8 * DAY });
  const first = await queue.runProviderPayoutQueueSweep(db, {});
  const second = await queue.runProviderPayoutQueueSweep(db, {});
  const forced = await queue.runProviderPayoutQueueSweep(db, { force: true, asOf: Date.now() + 2 * 60 * 60_000 });
  const concurrent = await Promise.all([queue.runProviderPayoutQueueSweep(db, { force: true }), queue.runProviderPayoutQueueSweep(db, { force: true })]);
  assert.equal(first.queued, 1);
  assert.equal(second.queued + forced.queued + concurrent[0].queued + concurrent[1].queued, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_queue_items WHERE booking_id='BK-ONCE'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_queue_events WHERE booking_id='BK-ONCE' AND event_type='payout_queued'").get().n, 1);
  const queued = item(sqlite, "BK-ONCE");
  assert.equal(queued.status, "awaiting_release");
  assert.equal(Number(queued.payable_amount), 700, "the amount is the 2110-Provider Payable the completion journal credited");
  assert.equal(Number(queued.amount), 700);
  assert.equal(payouts(sqlite, "BK-ONCE").length, 0, "queuing is not paying: nothing moves until Finance releases it");
  // The older commission sync can no longer create a second payout authority for this booking.
  await commission.syncCompletedCommissionOrders(db);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_order_commissions WHERE booking_id='BK-ONCE'").get().n, 0);
});

test("refunded, disputed, refund-pending and unverified-bank bookings are not queued", async () => {
  const { sqlite, db } = payoutWorld();
  const completedAt = Date.now() - 8 * DAY;
  await verifiedProvider(sqlite, db, "PRV-OK");
  await verifiedProvider(sqlite, db, "PRV-NOKYC", { verified: false });
  await completedBooking(sqlite, db, { id: "BK-FULL-REFUND", providerId: "PRV-OK", completedAt });
  refund(sqlite, "BK-FULL-REFUND", 1000);
  await completedBooking(sqlite, db, { id: "BK-DISPUTE", providerId: "PRV-OK", completedAt });
  sqlite.prepare("INSERT INTO unified_cases (id,case_type,status,title,booking_id,created_at) VALUES ('CASE-1','customer_complaint','open','Groomer left the dog wet','BK-DISPUTE',?)").run(Date.now());
  await completedBooking(sqlite, db, { id: "BK-ESCROW-DISPUTE", providerId: "PRV-OK", completedAt });
  sqlite.exec("CREATE TABLE dispute_freezes (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,status TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO dispute_freezes VALUES ('DSP-1','BK-ESCROW-DISPUTE','OPEN')").run();
  await completedBooking(sqlite, db, { id: "BK-REFUND-OPEN", providerId: "PRV-OK", completedAt });
  refund(sqlite, "BK-REFUND-OPEN", 300, "approved");
  await completedBooking(sqlite, db, { id: "BK-NOKYC", providerId: "PRV-NOKYC", completedAt });
  await completedBooking(sqlite, db, { id: "BK-CANCELLED", providerId: "PRV-OK", completedAt });
  sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='BK-CANCELLED'").run();

  const run = await queue.runProviderPayoutQueueSweep(db, { limit: 50 });
  assert.equal(run.queued, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_queue_items").get().n, 0);
  const reasons = Object.fromEntries(sqlite.prepare("SELECT booking_id,reason FROM provider_payout_candidates").all().map((r) => [r.booking_id, r.reason]));
  assert.deepEqual(reasons, { "BK-FULL-REFUND": "refunded_in_full", "BK-DISPUTE": "dispute_open", "BK-ESCROW-DISPUTE": "dispute_open", "BK-REFUND-OPEN": "refund_open", "BK-NOKYC": "no_beneficiary", "BK-CANCELLED": "booking_not_completed" });

  // The Finance screen shows each one with a plain-English reason.
  const dashboard = await queue.getProviderPayoutQueueDashboard(db);
  const labels = Object.fromEntries(dashboard.upcoming.map((row) => [row.booking_id, row.reasonLabel]));
  assert.equal(labels["BK-NOKYC"], "No verified bank account for this provider");
  assert.equal(labels["BK-DISPUTE"], "A customer dispute or complaint is open");
  assert.equal(labels["BK-FULL-REFUND"], "Refunded in full, nothing to pay");
  assert.equal(labels["BK-REFUND-OPEN"], "A refund request is still open");

  // Once the complaint is resolved it is queued on the next hourly check.
  sqlite.prepare("UPDATE unified_cases SET status='resolved' WHERE id='CASE-1'").run();
  const later = await queue.runProviderPayoutQueueSweep(db, { asOf: Date.now() + 61 * 60_000, limit: 50 });
  assert.equal(later.queued, 1);
  assert.equal(item(sqlite, "BK-DISPUTE").status, "awaiting_release");
});

test("a refund or dispute read that fails holds the money instead of paying in full", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-FAIL");
  await completedBooking(sqlite, db, { id: "BK-QUEUED-FIRST", providerId: "PRV-FAIL", completedAt: Date.now() - 8 * DAY });
  await queue.runProviderPayoutQueueSweep(db, {});
  assert.equal(item(sqlite, "BK-QUEUED-FIRST").status, "awaiting_release");
  await completedBooking(sqlite, db, { id: "BK-READ-FAILS", providerId: "PRV-FAIL", completedAt: Date.now() - 8 * DAY });
  // A refund table that exists but cannot be read the way the queue needs it (a broken schema).
  sqlite.exec("DROP TABLE booking_refund_cases; CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,amount REAL NOT NULL)");
  const run = await queue.runProviderPayoutQueueSweep(db, { force: true });
  assert.equal(run.queued, 0);
  assert.ok(run.errors.some((error) => error.startsWith("BK-READ-FAILS")), "the failure is reported, not swallowed");
  assert.equal(item(sqlite, "BK-READ-FAILS"), undefined, "a booking whose refunds cannot be read is not queued");
  const release = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-QUEUED-FIRST"], actor: FINANCE });
  assert.equal(release.released.length, 0, "and a queued payout is not released while its refunds cannot be read");
  assert.equal(payouts(sqlite, "BK-QUEUED-FIRST").length, 0);
});

test("ONE click releases the payout into exactly one sandbox payout record, and the books clear 2110", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-REL");
  await completedBooking(sqlite, db, { id: "BK-REL", providerId: "PRV-REL", completedAt: Date.now() - 8 * DAY });
  await queue.runProviderPayoutQueueSweep(db, {});
  assert.equal(ledger(sqlite, "2110-Provider Payable", "BK-REL"), 700);

  const result = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-REL"], actor: FINANCE });
  assert.deepEqual(result.refused, []);
  assert.equal(result.released.length, 1);
  assert.equal(result.environment, "sandbox");
  assert.equal(result.liveMoney, false);
  const released = item(sqlite, "BK-REL");
  assert.equal(released.status, "released");
  assert.equal(released.released_by, FINANCE);
  const records = payouts(sqlite, "BK-REL");
  assert.equal(records.length, 1, "exactly one payout record");
  assert.equal(records[0].id, released.payout_id);
  assert.equal(records[0].environment, "sandbox");
  assert.equal(records[0].status, "queued_sandbox", "the record the RazorpayX TEST dispatch sends");
  assert.equal(Number(records[0].amount), 700);
  assert.equal(records[0].razorpayx_fund_account_id, "fa_PRVREL");
  assert.ok(records[0].beneficiary_snapshot_sha256, "the verified bank snapshot is bound to the payout");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_order_commissions WHERE booking_id='BK-REL'").get().n, 0, "no approver chain was needed");

  assert.equal(ledger(sqlite, "2110-Provider Payable", "BK-REL"), 0, "the provider payable for the booking is cleared by the release");
  assert.equal(ledger(sqlite, "2115-Provider Payouts in Transit", "BK-REL"), 700);
  assertBooksBalance(sqlite);
  const reconciliation = await queue.reconcileProviderPayable(db);
  assert.equal(reconciliation.ok, true, JSON.stringify(reconciliation.mismatches));

  // The released payout is what the existing RazorpayX TEST dispatcher picks up.
  const runtime = await import("../lib/razorpayx-payout-runtime.ts");
  await assert.rejects(() => runtime.dispatchRazorpayXSandboxPayout(db, {}, { payoutId: records[0].id }), (e) => e instanceof Response && e.status === 503, "reaches the sandbox runtime, which then needs TEST credentials; no network call is made here");
});

test("a double click, or two people clicking at once, pays once", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-DBL");
  await completedBooking(sqlite, db, { id: "BK-DBL", providerId: "PRV-DBL", completedAt: Date.now() - 9 * DAY });
  await queue.runProviderPayoutQueueSweep(db, {});
  const [a, b] = await Promise.all([
    queue.releaseProviderPayouts(db, { bookingIds: ["BK-DBL"], actor: FINANCE }),
    queue.releaseProviderPayouts(db, { bookingIds: ["BK-DBL"], actor: "second.finance@pawspace.test" }),
  ]);
  const again = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-DBL", "BK-DBL"], actor: FINANCE });
  const outcomes = [...a.released, ...b.released, ...again.released];
  assert.equal(outcomes.filter((r) => r.duplicatePrevented === false).length, 1);
  assert.equal(new Set(outcomes.map((r) => r.payoutId)).size, 1, "every click reports the same payout");
  assert.equal(payouts(sqlite, "BK-DBL").length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_entries WHERE source_type='provider_payout_release' AND source_id='BK-DBL' AND account_code='2110-Provider Payable'").get().n, 1);
  assertBooksBalance(sqlite);
});

test("a partial refund before release reduces the payout pro-rata: Rs 1,000 at 70% with Rs 200 back pays 560", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-PART");
  await completedBooking(sqlite, db, { id: "BK-PART", providerId: "PRV-PART", completedAt: Date.now() - 8 * DAY });
  await queue.runProviderPayoutQueueSweep(db, {});
  assert.equal(Number(item(sqlite, "BK-PART").amount), 700);
  refund(sqlite, "BK-PART", 200);
  const result = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-PART"], actor: FINANCE, reason: "Weekly payout run" });
  assert.deepEqual(result.refused, []);
  assert.equal(result.released[0].amount, 560);
  const released = item(sqlite, "BK-PART");
  assert.equal(Number(released.refund_adjustment), 140, "the provider carries 70% of the Rs 200 refund");
  assert.equal(Number(released.amount), 560);
  assert.equal(released.release_reason, "Weekly payout run");
  assert.equal(Number(payouts(sqlite, "BK-PART")[0].amount), 560);
  assert.equal(ledger(sqlite, "2110-Provider Payable", "BK-PART"), 0);
  assert.equal(ledger(sqlite, "4900-Refunds and Cancellations", "BK-PART"), 140, "the provider's share of the refund is taken back off the refund expense");
  assertBooksBalance(sqlite);

  // A refund recorded before the job first sees the booking is applied at queue time as well.
  await completedBooking(sqlite, db, { id: "BK-PART-2", providerId: "PRV-PART", completedAt: Date.now() - 8 * DAY });
  refund(sqlite, "BK-PART-2", 200);
  await queue.runProviderPayoutQueueSweep(db, { force: true });
  assert.equal(Number(item(sqlite, "BK-PART-2").amount), 560);
  assert.equal(ledger(sqlite, "2110-Provider Payable", "BK-PART-2"), 560);

  // A vertical refund ledger (here Pet Sitting's) counts the same way as a refund case.
  sqlite.exec("CREATE TABLE sitting_refund_ledger (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL)");
  await completedBooking(sqlite, db, { id: "BK-PART-3", providerId: "PRV-PART", service: "pet_sitting", completedAt: Date.now() - 8 * DAY });
  sqlite.prepare("INSERT INTO sitting_refund_ledger VALUES ('SRF-1','BK-PART-3',200,'sandbox_recorded')").run();
  sqlite.prepare("INSERT INTO sitting_refund_ledger VALUES ('SRF-2','BK-PART-3',500,'rejected')").run();
  assert.equal(await queue.refundedForProviderPayout(db, "BK-PART-3"), 200, "a rejected refund is not a refund");
  await queue.runProviderPayoutQueueSweep(db, { force: true });
  assert.equal(Number(item(sqlite, "BK-PART-3").amount), 560);
  assert.equal((await queue.reconcileProviderPayable(db)).ok, true);
  assertBooksBalance(sqlite);
});

test("a full refund before release cancels the queued payout", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-FULL");
  await completedBooking(sqlite, db, { id: "BK-FULL", providerId: "PRV-FULL", completedAt: Date.now() - 8 * DAY });
  await queue.runProviderPayoutQueueSweep(db, {});
  refund(sqlite, "BK-FULL", 1000);
  const run = await queue.runProviderPayoutQueueSweep(db, { force: true });
  assert.equal(run.cancelled, 1);
  const cancelled = item(sqlite, "BK-FULL");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancel_reason, "refunded_in_full");
  assert.equal(Number(cancelled.amount), 0);
  const release = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-FULL"], actor: FINANCE });
  assert.equal(release.released.length, 0);
  assert.match(release.refused[0].error, /refunded in full/);
  assert.equal(payouts(sqlite, "BK-FULL").length, 0);
  assert.equal(ledger(sqlite, "2110-Provider Payable", "BK-FULL"), 0, "nothing is left owing to the provider");
  assertBooksBalance(sqlite);
  const dashboard = await queue.getProviderPayoutQueueDashboard(db);
  assert.equal(dashboard.queue.find((row) => row.booking_id === "BK-FULL").statusLabel, "Cancelled, refunded in full");
});

test("a refund after release is recorded as a recovery and taken off the provider's next payout", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-REC");
  await completedBooking(sqlite, db, { id: "BK-REC-1", providerId: "PRV-REC", completedAt: Date.now() - 9 * DAY });
  await queue.runProviderPayoutQueueSweep(db, {});
  await queue.releaseProviderPayouts(db, { bookingIds: ["BK-REC-1"], actor: FINANCE });
  refund(sqlite, "BK-REC-1", 200);
  const run = await queue.runProviderPayoutQueueSweep(db, { asOf: Date.now() + 2 * 60 * 60_000 });
  assert.equal(run.recoveries, 1);
  const recovery = sqlite.prepare("SELECT * FROM provider_payout_recoveries WHERE booking_id='BK-REC-1'").get();
  assert.equal(Number(recovery.amount), 140, "700 paid, 560 earned after the refund");
  assert.equal(recovery.status, "open");
  assert.equal(ledger(sqlite, "1310-Provider Recoveries Receivable", "BK-REC-1"), -140, "a receivable from the provider");
  const replay = await queue.runProviderPayoutQueueSweep(db, { asOf: Date.now() + 4 * 60 * 60_000 });
  assert.equal(replay.recoveries, 0, "the same refund is recovered once");

  await completedBooking(sqlite, db, { id: "BK-REC-2", providerId: "PRV-REC", completedAt: Date.now() - 8 * DAY });
  await queue.runProviderPayoutQueueSweep(db, { force: true });
  assert.equal(Number(item(sqlite, "BK-REC-2").amount), 560, "the queue shows the deduction before anyone releases it");
  const next = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-REC-2"], actor: FINANCE });
  assert.equal(next.released[0].recoveryDeducted, 140);
  assert.equal(next.released[0].amount, 560);
  assert.equal(Number(payouts(sqlite, "BK-REC-2")[0].amount), 560);
  assert.equal(sqlite.prepare("SELECT status FROM provider_payout_recoveries WHERE booking_id='BK-REC-1'").get().status, "recovered");
  assert.equal(Number(sqlite.prepare("SELECT ROUND(SUM(debit-credit),2) n FROM finance_journal_entries WHERE account_code='1310-Provider Recoveries Receivable'").get().n), 0, "the receivable is cleared by the deduction");
  assertBooksBalance(sqlite);
  assert.equal((await queue.reconcileProviderPayable(db)).ok, true);
});

test("TDS is deducted once the provider's commission for the year crosses the existing 194H threshold", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-TDS");
  const completedAt = Date.now() - 8 * DAY;
  await completedBooking(sqlite, db, { id: "BK-TDS-1", providerId: "PRV-TDS", total: 27000, payable: 18900, gst: 1458, completedAt });
  await queue.runProviderPayoutQueueSweep(db, {});
  const first = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-TDS-1"], actor: FINANCE });
  assert.equal(first.released[0].tds, 0, "Rs 18,900 for the year is under the Rs 20,000 threshold");
  await completedBooking(sqlite, db, { id: "BK-TDS-2", providerId: "PRV-TDS", total: 2000, payable: 1400, gst: 108, completedAt });
  await queue.runProviderPayoutQueueSweep(db, { force: true });
  const second = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-TDS-2"], actor: FINANCE });
  // 18,900 + 1,400 = 20,300 crosses Rs 20,000: 2% of the whole untaxed 20,300 is Rs 406.
  assert.equal(second.released[0].tds, 406);
  assert.equal(second.released[0].amount, 994);
  assert.equal(item(sqlite, "BK-TDS-2").tds_section, "194H");
  assert.equal(ledger(sqlite, "2150-TDS Payable", "BK-TDS-2"), 406);
  assertBooksBalance(sqlite);
});

test("the older approval steps and the monthly statements cannot pay a queued booking a second time", async () => {
  const { sqlite, db } = payoutWorld();
  await verifiedProvider(sqlite, db, "PRV-BRIDGE");
  const completedAt = Date.now() - 8 * DAY;
  // Untouched older row: moved to the queue. Confirmed older row: left alone, never queued here.
  await completedBooking(sqlite, db, { id: "BK-OLD-UNTOUCHED", providerId: "PRV-BRIDGE", completedAt });
  await completedBooking(sqlite, db, { id: "BK-OLD-CONFIRMED", providerId: "PRV-BRIDGE", completedAt });
  for (const [id, status] of [["BK-OLD-UNTOUCHED", "pending_confirmation"], ["BK-OLD-CONFIRMED", "awaiting_approval_1"]]) {
    sqlite.prepare("INSERT INTO provider_order_commissions (id,booking_id,work_order_id,provider_id,service_code,order_amount,commission_mode,commission_value,commission_amount,commission_source,status,completed_at,due_at,created_at,updated_at) VALUES (?,?,?,?,'pet_grooming',1000,'percent',70,700,'provider_default',?,?,?,?,?)")
      .run(`COMM-${id}`, id, `WO-${id}`, "PRV-BRIDGE", status, completedAt, completedAt + 5 * DAY, completedAt, completedAt);
  }
  await queue.runProviderPayoutQueueSweep(db, { limit: 50 });
  assert.equal(item(sqlite, "BK-OLD-UNTOUCHED").status, "awaiting_release");
  assert.equal(sqlite.prepare("SELECT status FROM provider_order_commissions WHERE booking_id='BK-OLD-UNTOUCHED'").get().status, "moved_to_payout_queue");
  await assert.rejects(() => commission.confirmOrderCommission(db, { bookingId: "BK-OLD-UNTOUCHED", actor: "maker@pawspace.test" }), /provider payout queue/);
  assert.equal(item(sqlite, "BK-OLD-CONFIRMED"), undefined);
  assert.equal(sqlite.prepare("SELECT reason FROM provider_payout_candidates WHERE booking_id='BK-OLD-CONFIRMED'").get().reason, "older_approval_flow");

  // Monthly statements (full-time partners) leave commission work to the queue.
  const settlement = await import("../lib/partner-settlement-governance.ts");
  sqlite.exec("CREATE TABLE provider_payout_computations (booking_id TEXT,provider_id TEXT,service_code TEXT,provider_net_payout REAL,computed_at INTEGER)");
  const now = Date.now();
  sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('BK-OLD-UNTOUCHED','PRV-STATEMENT','pet_grooming',700,?)").run(now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,service_code,provider_id,status,total_amount,updated_at) VALUES ('BK-FULLTIME','pet_grooming','PRV-STATEMENT','completed',1000,?)").run(now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_model,status) VALUES ('WO-FULLTIME','BK-FULLTIME','PRV-STATEMENT','full_time','completed')").run();
  sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('BK-FULLTIME','PRV-STATEMENT','pet_grooming',300,?)").run(now);
  await settlement.refreshPartnerSettlementStatements(db, new Date(now).toISOString().slice(0, 7));
  const statement = sqlite.prepare("SELECT earned_amount FROM partner_settlement_statements WHERE provider_id='PRV-STATEMENT'").get();
  assert.equal(Number(statement.earned_amount), 300, "only the full-time booking is in the monthly statement");
});

test("live money stays behind the live-payout approvals: release refuses outside sandbox", async () => {
  const { sqlite, db } = payoutWorld({ ...SANDBOX, PAWSPACE_PAYMENT_ENV: "live" });
  await verifiedProvider(sqlite, db, "PRV-LIVE");
  await completedBooking(sqlite, db, { id: "BK-LIVE", providerId: "PRV-LIVE", completedAt: Date.now() - 8 * DAY });
  await queue.runProviderPayoutQueueSweep(db, {});
  assert.equal(item(sqlite, "BK-LIVE").status, "awaiting_release", "queuing is allowed; it moves no money");
  const refused = await attempt(() => queue.releaseProviderPayouts(db, { bookingIds: ["BK-LIVE"], actor: FINANCE }));
  assert.equal(refused.status, 409);
  assert.match(refused.body, /live-payout approvals/);
  assert.equal(payouts(sqlite, "BK-LIVE").length, 0);
  assert.equal(item(sqlite, "BK-LIVE").status, "awaiting_release");
});

test("only Finance can release: the partner-finance route refuses other staff and audits every release", async () => {
  const { sqlite, db } = payoutWorld();
  await seedActors(sqlite, db, [
    { id: "USR-PQ-FIN", email: FINANCE, role: "finance" },
    { id: "USR-PQ-AUD", email: "auditor@pawspace.test", role: "auditor" },
    { id: "USR-PQ-MGR", email: "manager@pawspace.test", role: "manager" },
  ]);
  await verifiedProvider(sqlite, db, "PRV-ROUTE");
  await completedBooking(sqlite, db, { id: "BK-ROUTE-1", providerId: "PRV-ROUTE", completedAt: Date.now() - 8 * DAY });
  await completedBooking(sqlite, db, { id: "BK-ROUTE-2", providerId: "PRV-ROUTE", completedAt: Date.now() - 8 * DAY });
  const route = await import("../app/api/partner-finance/route.ts");
  const post = (email, body) => route.POST(asActor(email, "/api/partner-finance", { method: "POST", body: JSON.stringify(body) }));

  for (const email of ["auditor@pawspace.test", "manager@pawspace.test"]) {
    const denied = await post(email, { action: "run_payout_queue" });
    assert.equal(denied.status, 403, `${email} cannot run the payout queue`);
    const deniedRelease = await post(email, { action: "release_provider_payout", bookingIds: ["BK-ROUTE-1"] });
    assert.equal(deniedRelease.status, 403, `${email} cannot release a payout`);
    const deniedHold = await post(email, { action: "set_payout_hold_days", holdDays: 3, reason: "trying to shorten the hold" });
    assert.equal(deniedHold.status, 403);
  }

  const ran = await post(FINANCE, { action: "run_payout_queue" });
  assert.equal(ran.status, 200, await ran.clone().text());
  assert.equal((await ran.json()).data.queued, 2);
  const batch = await post(FINANCE, { action: "release_provider_payout", bookingIds: ["BK-ROUTE-1", "BK-ROUTE-2"] });
  assert.equal(batch.status, 200, await batch.clone().text());
  const body = await batch.json();
  assert.equal(body.data.released.length, 2, "a selected batch is released with one click");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_order_payouts WHERE booking_id IN ('BK-ROUTE-1','BK-ROUTE-2')").get().n, 2);
  const audits = sqlite.prepare("SELECT resource_id,outcome,actor_email FROM security_audit_events WHERE action='partner.payout.release' ORDER BY resource_id").all();
  assert.deepEqual(audits.map((a) => [a.resource_id, a.outcome, a.actor_email]), [["BK-ROUTE-1", "completed", FINANCE], ["BK-ROUTE-2", "completed", FINANCE]]);

  const read = await route.GET(asActor(FINANCE, "/api/partner-finance"));
  assert.equal(read.status, 200);
  const snapshot = (await read.json()).data.payoutQueue;
  assert.equal(snapshot.holdDays, 7);
  assert.equal(snapshot.policy.releaseClicks, 1);
  assert.equal(snapshot.queue.filter((row) => row.status === "released").length, 2);
  assert.equal(snapshot.reconciliation.ok, true);
});

test("the Worker cron runs the payout queue alongside the other sweeps", () => {
  const worker = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const settled = worker.indexOf("await Promise.allSettled([");
  assert.ok(settled > 0);
  assert.ok(worker.indexOf("runProviderPayoutQueueSweep(env.DB", settled) > settled, "the sweep is one of the scheduled sweeps");
  assert.match(worker, /providerPayoutQueue\.status==="rejected"/, "a failing payout sweep is reported, not swallowed");
});
