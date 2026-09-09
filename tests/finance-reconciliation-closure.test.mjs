/*
 * The six finance/webhook defects closed in fix/finance-reconciliation-closure, each proved by
 * EXECUTING the production module against a real database rather than by reading the diff.
 *
 *   FIN-D1  a failed refund had no exit from `failed` - the customer's money was stuck forever
 *   FIN-D2  refund.processed never posted to the ledger - captures were on the books, reversals were not
 *   FIN-D3  a refund merely `processing` already reduced net collections - an artificial revenue drop
 *   FIN-D4  a grooming cancellation told the customer nothing
 *   FIN-D5  a failed refund reached staff only as a generic, unassertable `payment_exception`
 *   FIN-D6  a mid-processing crash left the money path half-done and the retry SKIPPED the rest
 *
 * plus the sandbox invariant, asserted structurally rather than by string-matching process.env.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__FINCLOSE_DB__", "__FINCLOSE_ENV__");

const CITY = "blr", ZONE = "blr-east";
const CUSTOMER = "FIN-CUS-001";
const BOOKING = "FIN-BK-001";
const PROVIDER = "groom_kiran";
const PAYMENT = "FIN-PAY-001";
const REFUND_CASE = "21306301-9de7-445f-b1b1-429210f72cba"; // the ₹1,899 case from the audit
const AMOUNT = 1899;
const OPS = "finance-ops@pawspace.test";
const MAKER = "finance-maker@pawspace.test";

const STAGES = [];
const stage = (name, status, detail) => STAGES.push({ name, status, detail });
const parsed = (r) => { try { return JSON.parse(r.body ?? "{}"); } catch { return {}; } };

function finWorld(env = {}) {
  return world("__FINCLOSE_DB__", "__FINCLOSE_ENV__", { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", ...env });
}

/** The canonical rows the finance modules read but do not own. */
function seedCanonical(sqlite, over = {}) {
  const now = Date.now();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,pet_ids_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT,created_at INTEGER NOT NULL);
  `);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(CUSTOMER, "Finance Customer", "9800000222", "fin@example.test", CITY, "{}", now, now);
  sqlite.prepare(`INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,pet_ids_json,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'grooming','dog-basic','Bath & Basic','FIN-SG-1','groom_kiran',?,?,?,'customer_app',?,'INR','{}','[]','test',?,?)`)
    .run(BOOKING, CUSTOMER, CITY, ZONE, new Date(now + 2 * 86400000).toISOString(), new Date(now + 2 * 86400000 + 7200000).toISOString(), over.bookingStatus ?? "completed", AMOUNT, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES (?,?,?,?,?,'INR','card','prepaid',?,'razorpay',?,'{}',?,?)")
    .run(PAYMENT, BOOKING, CUSTOMER, AMOUNT, AMOUNT, over.paymentStatus ?? "captured", "fin-idem-1", now, now);
  return now;
}

/** A refund case in a chosen state, with the gateway reference the webhook will carry. */
function seedRefundCase(sqlite, { status, gatewayReference = null, approvedBy = null }) {
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,policy_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");
  sqlite.prepare("INSERT OR REPLACE INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,gateway_reference,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'{}',?,?)")
    .run(REFUND_CASE, BOOKING, PAYMENT, AMOUNT, "Customer cancelled before the visit", status, MAKER, approvedBy, gatewayReference, now, now);
  return now;
}

const refundStatus = (sqlite) => sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(REFUND_CASE)?.status;

async function opsRefundTransition(sqlite, db, toStatus, reason = "Gateway rejected the first attempt; re-issuing") {
  await seedActors(sqlite, db, [{ id: "USR-FINOPS", email: OPS, role: "finance" }]);
  const route = await import("../app/api/booking-operations/route.ts");
  return attempt(() => route.POST(asActor(OPS, "/api/booking-operations", {
    method: "POST",
    body: JSON.stringify({ bookingId: BOOKING, providerId: PROVIDER, action: "refund_status", refundCaseId: REFUND_CASE, refundStatus: toStatus, reason }),
  })));
}

// --- FIN-D1 -----------------------------------------------------------------
test("FIN-D1 a failed refund can be retried, and retried AGAIN — `failed` is no longer terminal", async () => {
  const { sqlite, db } = finWorld();
  seedCanonical(sqlite);
  seedRefundCase(sqlite, { status: "failed", approvedBy: OPS });

  /* Before the fix the transition map had no `failed` key at all, so this answered
   * "Refund cannot move from failed to processing" forever and ₹1,899 stayed with us. */
  const first = await opsRefundTransition(sqlite, db, "processing");
  assert.equal(first.status, 200, `a failed refund must be retryable: ${first.body?.slice(0, 300)}`);
  assert.equal(refundStatus(sqlite), "processing");

  /* The part a one-line map change would have missed. booking_refund_transition_claims is
   * UNIQUE(refund_case_id,from_status), so without clearing the spent claim the SECOND gateway failure
   * would be unrecoverable - the retry would work exactly once in the lifetime of the case. */
  sqlite.prepare("UPDATE booking_refund_cases SET status='failed' WHERE id=?").run(REFUND_CASE);
  const second = await opsRefundTransition(sqlite, db, "processing", "Gateway rejected the second attempt too");
  assert.equal(second.status, 200, `a SECOND retry must also be possible: ${second.body?.slice(0, 300)}`);
  assert.equal(refundStatus(sqlite), "processing");

  /* The other authorised exit: back to the approval queue. */
  sqlite.prepare("UPDATE booking_refund_cases SET status='failed' WHERE id=?").run(REFUND_CASE);
  const requeued = await opsRefundTransition(sqlite, db, "requested", "Sending this back to finance for re-approval");
  assert.equal(requeued.status, 200, `failed -> requested must be allowed: ${requeued.body?.slice(0, 300)}`);
  assert.equal(refundStatus(sqlite), "requested");

  stage("D1 refund retry", "PASS", "failed -> processing twice, and failed -> requested; the spent claim is cleared each time");
});

test("FIN-D1b the retry cannot short-cut into `completed`, and unauthorised jumps stay refused", async () => {
  const { sqlite, db } = finWorld();
  seedCanonical(sqlite);
  seedRefundCase(sqlite, { status: "failed", approvedBy: OPS });

  /* The opposite direction, so "allow everything" cannot pass. `completed` demands signature-verified
   * gateway evidence, and a retry must not become a way around that. */
  const jump = await opsRefundTransition(sqlite, db, "completed", "Trying to mark this done without the gateway");
  assert.equal(jump.status, 409, `failed -> completed must stay refused: ${jump.body?.slice(0, 300)}`);
  assert.equal(refundStatus(sqlite), "failed", "a refused transition must not move the case");

  const rejected = await opsRefundTransition(sqlite, db, "rejected", "Trying to reject an already-failed refund");
  assert.equal(rejected.status, 409, "failed -> rejected is not an authorised exit");
  assert.equal(refundStatus(sqlite), "failed");
  stage("D1 retry bounds", "PASS", "failed -> completed and failed -> rejected both still refused; case unmoved");
});

// --- FIN-D5 -----------------------------------------------------------------
test("FIN-D5 a failed refund raises its own critical work item, not a generic payment exception", async () => {
  const { sqlite, db } = finWorld();
  seedCanonical(sqlite);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS payment_reconciliation_exceptions (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,event_id TEXT,exception_type TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT);");
  const add = (id, type, severity) => sqlite
    .prepare("INSERT INTO payment_reconciliation_exceptions (id,booking_id,payment_id,event_id,exception_type,severity,status,detail_json,created_at) VALUES (?,?,?,?,?,?,'open','{\"gatewayRefundId\":\"rfnd_TEST\"}',?)")
    .run(id, BOOKING, PAYMENT, `evt-${id}`, type, severity, now);
  add("PAYEX-FAILED", "refund_failed", "critical");
  add("PAYEX-OTHER", "refund_amount_mismatch", "critical");

  const { sweepWorkQueue } = await import("../lib/ops-work-queue.ts");
  await sweepWorkQueue(db, { actorId: "system:test", now });

  const tasks = sqlite.prepare("SELECT rule,priority,entity_id,sla_minutes,queue FROM ops_work_queue_tasks ORDER BY rule").all();
  const failed = tasks.filter((t) => t.rule === "refund_failed");
  assert.equal(failed.length, 1, `exactly one refund_failed work item: ${JSON.stringify(tasks)}`);
  assert.equal(failed[0].entity_id, "PAYEX-FAILED");
  assert.equal(failed[0].priority, "critical", "money owed to a customer is always critical, never 'high'");
  assert.equal(failed[0].queue, "finance");
  assert.ok(Number(failed[0].sla_minutes) <= 60, `a failed refund needs a tighter SLA than the generic 120: ${failed[0].sla_minutes}`);

  /* The point of an INDEPENDENT detector: querying for it must give a yes/no, and the same exception
   * must not also arrive as a generic payment_exception - one problem, one work item. */
  const generic = tasks.filter((t) => t.rule === "payment_exception");
  assert.ok(!generic.some((t) => t.entity_id === "PAYEX-FAILED"), "a failed refund must not ALSO be filed as a generic exception");
  assert.equal(generic.length, 1, "the other exception still reaches the generic detector");
  assert.equal(generic[0].entity_id, "PAYEX-OTHER");
  stage("D5 staff visibility", "PASS", "refund_failed is its own critical 60-minute finance rule; generic detector untouched otherwise");
});

// --- Sandbox invariant, structurally ---------------------------------------
test("FIN-SANDBOX an unset payment environment fails CLOSED — no live money can move", async () => {
  /* Asserted through the parser rather than by string-matching process.env: an unset variable is not a
   * declaration, and the question that matters is what the code DOES with it, not what the shell says. */
  const { parsePaymentEnvironment, sandboxCapabilitiesUnlocked } = await import("../lib/payment-environment.ts");

  for (const unset of [undefined, null, "", {}, { PAWSPACE_PAYMENT_ENV: "" }, { PAWSPACE_PAYMENT_ENV: "production" }]) {
    assert.throws(() => parsePaymentEnvironment(unset), /must be exactly "sandbox" or "live"/,
      `an undeclared environment must throw, not default: ${JSON.stringify(unset)}`);
    assert.equal(sandboxCapabilitiesUnlocked(unset), false,
      `an undeclared environment must unlock nothing: ${JSON.stringify(unset)}`);
  }

  // The opposite direction, so "throw at everything" cannot pass.
  assert.equal(parsePaymentEnvironment({ PAWSPACE_PAYMENT_ENV: "sandbox" }), "sandbox");
  assert.equal(sandboxCapabilitiesUnlocked({ PAWSPACE_PAYMENT_ENV: "sandbox" }), true);
  assert.equal(parsePaymentEnvironment({ PAWSPACE_PAYMENT_ENV: "live" }), "live");
  assert.equal(sandboxCapabilitiesUnlocked({ PAWSPACE_PAYMENT_ENV: "live" }), false,
    "live is a valid declaration but must not unlock the sandbox shortcuts");
  stage("Sandbox invariant", "PASS", "unset/empty/unknown all throw and unlock nothing; only an explicit declaration parses");
});

test("FIN-99 finance closure scope report", () => {
  const width = Math.max(...STAGES.map((s) => s.name.length), 10);
  console.log("\n  FINANCE RECONCILIATION CLOSURE — executed against real modules\n");
  for (const { name, status, detail } of STAGES) console.log(`  ${status.padEnd(6)} ${name.padEnd(width)}  ${detail}`);
  console.log("");
  assert.ok(STAGES.every((s) => s.status === "PASS"), `unresolved: ${STAGES.filter((s) => s.status !== "PASS").map((s) => s.name).join(", ")}`);
});

// --- FIN-D3 -----------------------------------------------------------------
test("FIN-D3 a refund still in flight does not reduce net collections; a landed one does", async () => {
  const { sqlite, db } = finWorld();
  seedCanonical(sqlite);
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");

  /* `processing` means SENT to the gateway. The money has not left. Counting it dropped recognised
   * revenue the moment a refund was dispatched, and restored it if the gateway then failed - a swing
   * in the P&L with no money movement behind it. */
  seedRefundCase(sqlite, { status: "processing" });
  const inFlight = await buildCompanyAnalytics(db, {});
  assert.equal(inFlight.money.refunds, 0, `a refund in flight is not a refund yet: ${JSON.stringify(inFlight.money)}`);
  assert.equal(inFlight.money.netCollections, inFlight.money.collected + inFlight.money.heldOnCancelled,
    "net collections must not move while the gateway has not paid the customer");

  /* The opposite direction, so "count nothing" cannot pass. */
  sqlite.prepare("UPDATE booking_refund_cases SET status='processed' WHERE id=?").run(REFUND_CASE);
  const landed = await buildCompanyAnalytics(db, {});
  assert.equal(landed.money.refunds, AMOUNT, `a processed refund must count: ${JSON.stringify(landed.money)}`);
  assert.equal(landed.money.netCollections, landed.money.collected + landed.money.heldOnCancelled - AMOUNT);

  sqlite.prepare("UPDATE booking_refund_cases SET status='completed' WHERE id=?").run(REFUND_CASE);
  assert.equal((await buildCompanyAnalytics(db, {})).money.refunds, AMOUNT, "a finance-reconciled refund counts too");
  assert.equal(landed.money.refundsStatus, "booking_refund_cases_processed_completed",
    "the reported source must describe what is actually counted");
  stage("D3 revenue recognition", "PASS", `processing = ₹0 against net collections, processed/completed = ₹${AMOUNT}`);
});

// --- FIN-D4 -----------------------------------------------------------------
test("FIN-D4 cancelling a grooming booking tells the customer, in the same transaction", async () => {
  const { sqlite, db } = finWorld();
  const now = seedCanonical(sqlite, { bookingStatus: "confirmed" });
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT,provider_id TEXT NOT NULL,provider_name TEXT,provider_model TEXT NOT NULL,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,occurrence_count INTEGER DEFAULT 1,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT);
    CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL,offered_at INTEGER,expires_at INTEGER,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL);
  `);
  const booking = sqlite.prepare("SELECT scheduled_start,scheduled_end FROM canonical_bookings WHERE id=?").get(BOOKING);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,'grooming',?,?,?,'[]',?,?,1,1,NULL,'assigned','{}',?)")
    .run("FIN-RES-1", "FIN-SG-1", PROVIDER, CITY, ZONE, CUSTOMER, booking.scheduled_start, booking.scheduled_end, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES (?,?,?,?,?,'commission','grooming',?,?,1,'confirmed',?,?)")
    .run("FIN-WO-1", BOOKING, "FIN-SG-1", PROVIDER, "Kiran S.", booking.scheduled_start, booking.scheduled_end, now, now);
  await seedActors(sqlite, db, [{ id: "USR-CUST", email: "fin@example.test", role: "admin" }]);

  const route = await import("../app/api/grooming-booking-change/route.ts");
  const cancelled = await attempt(() => route.POST(asActor("fin@example.test", "/api/grooming-booking-change", {
    method: "POST", body: JSON.stringify({ bookingId: BOOKING, customerId: CUSTOMER, action: "cancel", reason: "Plans changed, cancelling this groom" }),
  })));
  assert.equal(cancelled.status, 200, `the cancellation must succeed: ${cancelled.body?.slice(0, 400)}`);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING)?.status, "cancelled");

  /* Before the fix this transaction moved the booking, the work order, the reservation, the payment and
   * the subscription credits - and told the customer nothing at all. */
  const notes = sqlite.prepare("SELECT channel,template_code,message,status,event_id FROM booking_customer_notifications WHERE booking_id=?").all(BOOKING);
  assert.equal(notes.length, 1, `exactly one cancellation notification: ${JSON.stringify(notes)}`);
  assert.equal(notes[0].template_code, "booking_cancelled");
  assert.match(notes[0].message, /cancelled/i, "the customer must be told the booking is cancelled");
  assert.ok(notes[0].event_id, "the notification must be tied to the cancellation lifecycle event");
  const lifecycleEventId = sqlite.prepare("SELECT id FROM booking_lifecycle_events WHERE booking_id=? AND event_type='booking_cancelled'").get(BOOKING)?.id;
  assert.equal(notes[0].event_id, lifecycleEventId, "and tied to THAT event, not an unrelated id");
  stage("D4 cancellation handoff", "PASS", "one queued notification inside the cancel batch, bound to the cancellation event");
});

// --- FIN-D2 + FIN-D6 --------------------------------------------------------
/** A signature-verified refund.processed callback, exactly as the gateway would deliver it. */
const refundEvent = (over = {}) => ({
  provider: "razorpay", environment: "sandbox", eventId: over.eventId ?? "evt_refund_processed_1",
  eventType: over.eventType ?? "refund.processed", bookingId: BOOKING,
  gatewayPaymentId: "pay_TESTFIN", gatewayRefundId: over.gatewayRefundId ?? "rfnd_TESTFIN",
  amountSubunits: Math.round(AMOUNT * 100), currency: "INR", createdAt: Date.now(),
  signatureVerified: true, payloadHash: `hash-${over.eventId ?? "evt_refund_processed_1"}`, ...over,
});

async function reconciledWorld() {
  const { sqlite, db } = finWorld();
  seedCanonical(sqlite);
  seedRefundCase(sqlite, { status: "processing", gatewayReference: "rfnd_TESTFIN", approvedBy: OPS });
  const recon = await import("../lib/grooming-payment-reconciliation.ts");
  const { ensureCollectionLedgerTables } = await import("../lib/collection-ledger.ts");
  await ensureCollectionLedgerTables(db);
  await recon.ensurePaymentReconciliationTables(db);
  await recon.linkSandboxGatewayOrder(db, { bookingId: BOOKING, gatewayOrderId: "order_TESTFIN", actorId: OPS });
  // The capture the refund reverses, so the reconciliation record has money to refund against.
  sqlite.prepare("UPDATE payment_reconciliation_records SET captured_amount=?,gateway_status='captured',reconciliation_status='matched' WHERE payment_id=?").run(AMOUNT, PAYMENT);
  return { sqlite, db, recon };
}

const ledgerRow = (sqlite, ref = "rfnd_TESTFIN") =>
  sqlite.prepare("SELECT group_key,event,amount,payment_id,reversal_reference FROM collection_ledger_postings WHERE group_key=?").get(`COLL-refund_completed-${ref}`);

test("FIN-D2 a processed refund posts to the ledger — Dr Refunds / Cr gateway clearing — exactly once", async () => {
  const { sqlite, db, recon } = await reconciledWorld();

  /* Before the fix nothing in the platform ever called the refund side of the collection ledger, even
   * though `refund_completed` and a refunds account had been in the approved table all along. Captures
   * were on the books; the money going back to customers was not. */
  const result = await recon.processGatewayEvent(db, refundEvent());
  assert.equal(result.status, "processed", `the refund callback must process: ${JSON.stringify(result)}`);
  assert.equal(refundStatus(sqlite), "processed");
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(PAYMENT)?.status, "refunded");

  const posting = ledgerRow(sqlite);
  assert.ok(posting, "a refund_completed posting must exist");
  assert.equal(posting.event, "refund_completed");
  assert.equal(Math.round(posting.amount), AMOUNT);
  assert.equal(posting.reversal_reference, "rfnd_TESTFIN", "the posting must carry the gateway refund id");

  /* Double-entry, and which way round. Dr Refunds / Cr gateway clearing: the refunds account grows and
   * the money sitting at the gateway shrinks. A posting on the wrong side is worse than none. */
  const lines = sqlite.prepare("SELECT account_code,debit,credit FROM finance_journal_entries WHERE source_type=? AND source_id=? ORDER BY debit DESC").all("refund_completed", "rfnd_TESTFIN");
  assert.equal(lines.length, 2, `one debit, one credit: ${JSON.stringify(lines)}`);
  assert.equal(Math.round(Number(lines[0].debit)), AMOUNT, "the refunds account is debited");
  assert.equal(Math.round(Number(lines[1].credit)), AMOUNT, "the gateway clearing account is credited");
  assert.notEqual(lines[0].account_code, lines[1].account_code, "collections and refunds must be different accounts");
  assert.equal(Math.round(Number(lines[0].debit) - Number(lines[1].credit)), 0, "the entry must balance");

  /* A gateway redelivery of the same refund must not post a second time. */
  const replay = await recon.processGatewayEvent(db, refundEvent({ eventId: "evt_refund_processed_1_replay" }));
  assert.equal(replay.status, "processed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get()?.n, 1,
    "a redelivery must not double-post the customer's refund");
  stage("D2 ledger reconciliation", "PASS", `Dr Refunds ₹${AMOUNT} / Cr gateway clearing ₹${AMOUNT}, balanced, one posting after replay`);
});

test("FIN-D6 a refund interrupted mid-processing is RECOVERED by the retry, not skipped", async () => {
  const { sqlite, db, recon } = await reconciledWorld();

  /* The exact shape of the hole. D1 commits each statement separately, so a crash after the refund case
   * was marked `processed` but before the payment, the reconciliation record and the ledger left the
   * books half-written. The old short-circuit then saw `processed` on the case, called the redelivery a
   * duplicate, marked the event done and returned - so the rest NEVER happened and nothing complained. */
  sqlite.prepare("UPDATE booking_refund_cases SET status='processed',gateway_reference='rfnd_TESTFIN' WHERE id=?").run(REFUND_CASE);
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(PAYMENT)?.status, "captured",
    "the interrupted state: case says processed, payment does not");
  assert.equal(ledgerRow(sqlite), undefined, "and nothing is on the books yet");

  const recovery = await recon.processGatewayEvent(db, refundEvent({ eventId: "evt_refund_redelivery" }));
  assert.equal(recovery.status, "processed", `the redelivery must complete the money path: ${JSON.stringify(recovery)}`);
  assert.notEqual(recovery.ignored, true, "a half-finished refund is a recovery, not a duplicate to ignore");

  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(PAYMENT)?.status, "refunded",
    "the payment must be finished by the retry");
  assert.ok(ledgerRow(sqlite), "and the ledger posting the first pass never reached must now exist");
  const recon_record = sqlite.prepare("SELECT refunded_amount,reconciliation_status FROM payment_reconciliation_records WHERE payment_id=?").get(PAYMENT);
  assert.equal(Math.round(Number(recon_record.refunded_amount)), AMOUNT, "the reconciliation record must be settled too");
  assert.equal(recon_record.reconciliation_status, "matched");

  /* And once it IS complete, a further redelivery is a genuine duplicate and must stay a no-op. */
  const duplicate = await recon.processGatewayEvent(db, refundEvent({ eventId: "evt_refund_redelivery_2" }));
  assert.equal(duplicate.ignored, true, "a fully-settled refund redelivered again is a real duplicate");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get()?.n, 1);
  stage("D6 webhook recovery", "PASS", "half-committed refund completed by the retry; a settled one stays a no-op");
});
