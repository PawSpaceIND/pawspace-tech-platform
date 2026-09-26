// Pure helpers for 60-transactions-audit: the read-only SQL it runs against staging D1 and the evaluators that
// turn those rows into invariants. No I/O here, so the SQL and the rules can be proven against a local SQLite
// built from drizzle/*.sql plus the runtime ensure*() DDL, with rows written by the real capture/refund code.
//
// The money model this encodes (lib/razorpay-capture-atomic.ts, lib/grooming-payment-reconciliation.ts,
// lib/collection-ledger.ts, lib/refund-collection-reversal.ts, lib/stay-split-payments.ts):
//  - one Razorpay capture = processed payment_gateway_events rows for one gateway payment (the webhook and the
//    provider read may both land; later notifications are recorded as "Repeat notification…"), ONE posted
//    journal_transactions row `razorpay:capture:<pay_id>`, ONE collection posting
//    `COLL-online_payment_captured-<pay_id>` with two balanced finance_journal_entries lines, ONE timeline
//    `payment_captured` event, and captured_amount on payment_reconciliation_records grows by its amount once;
//  - booking_payments.status turns `captured` on the first capture (a split deposit included); the split
//    schedule (stay_payment_schedules / taxi_payment_schedules) says whether the balance is still owed;
//  - reconciliation is `partially_captured` until a schedule is fully collected, `matched` when it is (or for a
//    prepaid booking), `over_collected` with the excess as variance when more than the booking value was taken;
//  - a recorded refund processes its booking_refund_cases row, posts `COLL-refund_completed-<reference>`,
//    sets refunded_amount from the processed cases and moves the payment to partially_refunded / refunded.

export const CAPTURE_TYPES = ["payment.captured", "order.paid", "payment_link.paid"];
const CAPTURE_IN = `('payment.captured','order.paid','payment_link.paid')`;
const jsonField = (column, path) => `json_extract(CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END,'${path}')`;
export const COLLECTED_STATUSES = ["captured", "paid", "partially_refunded", "refunded"];
export const REFUND_DONE = ["processed", "completed"];
export const CREATION_EVENTS = ["booking_created", "sitting_payment_pending", "taxi_booking_fee_pending", "taxi_booking_created", "walking_booking_created", "sitting_booking_created"];
export const CONFIRM_EVENTS = { boarding: ["booking_confirmed_after_verified_payment"], pet_sitting: ["booking_confirmed_after_verified_payment"], grooming: ["booking_confirmed_after_verified_payment"], dog_training: ["booking_confirmed_after_verified_payment"], pet_taxi: ["taxi_booking_confirmed_after_booking_fee"] };
export const SETTLE_MS = 120_000;          // a webhook younger than this may still be in flight (lib unfinishedWebhooks)
export const EFFECTS_GRACE_MS = 10 * 60_000; // capture post-commit saga retries every minute; give it ten
export const GLOBAL_WINDOW_MS = 7 * 24 * 3_600_000;
export const IN_CHUNK = 80;                  // D1 refuses more than ~100 bound parameters per statement

export const placeholders = (n) => Array.from({ length: n }, () => "?").join(",");
export const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
export const same = (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.0095;
const rupees = (value) => (value === null || value === undefined || value === "" ? "—" : `₹${round2(value)}`);
const text = (value) => String(value ?? "").trim();

/** Per-booking reads. Each takes the number of ids in the IN list; the suite binds the ids (chunked). */
export const BOOKING_SQL = {
  bookings: (n) => `SELECT b.id booking_id,b.service_code,b.status booking_status,b.total_amount booking_total,b.customer_id,b.provider_id,b.scheduled_start,b.channel,b.created_at,b.updated_at,
      p.id payment_id,p.amount payment_amount,p.amount_due_now,p.status payment_status,p.mode payment_mode,p.method payment_method,p.gateway payment_gateway,p.created_at payment_created_at,p.updated_at payment_updated_at,
      ${jsonField("p.detail_json", "$.hasTripAdjustments")} trip_adjusted
    FROM canonical_bookings b LEFT JOIN booking_payments p ON p.booking_id=b.id WHERE b.id IN (${placeholders(n)})`,
  staySchedules: (n) => `SELECT booking_id,service_code,total_amount,paid_now_amount,balance_amount,balance_due_at,status,paid_at,payment_ref,created_at,updated_at FROM stay_payment_schedules WHERE booking_id IN (${placeholders(n)})`,
  taxiSchedules: (n) => `SELECT booking_id,total_amount,booking_fee_amount,balance_amount,status,booking_fee_paid_at,booking_fee_reference,final_paid_at,final_payment_reference,created_at,updated_at FROM taxi_payment_schedules WHERE booking_id IN (${placeholders(n)})`,
  intents: (n) => `SELECT id,booking_id,payment_id,environment,state,order_request_state,amount_paise,currency,gateway_order_id,gateway_payment_id,created_at,updated_at FROM payment_intents WHERE booking_id IN (${placeholders(n)})`,
  links: (n) => `SELECT booking_id,payment_id,environment,gateway_order_id,gateway_payment_id,status,updated_at FROM payment_gateway_links WHERE booking_id IN (${placeholders(n)})`,
  events: (n) => `SELECT id,booking_id,payment_id,environment,event_id,event_type,gateway_order_id,gateway_payment_id,gateway_refund_id,amount_subunits,currency,signature_verified,processing_status,failure_reason,received_at,processed_at,
      ${jsonField("detail_json", "$.captureAuthority")} capture_authority,${jsonField("detail_json", "$.duplicateCapture")} duplicate_capture
    FROM payment_gateway_events WHERE booking_id IN (${placeholders(n)})`,
  reconciliation: (n) => `SELECT payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at FROM payment_reconciliation_records WHERE booking_id IN (${placeholders(n)})`,
  exceptions: (n) => `SELECT id,booking_id,payment_id,event_id,exception_type,severity,status,created_at,resolved_at FROM payment_reconciliation_exceptions WHERE booking_id IN (${placeholders(n)})`,
  lifecycle: (n) => `SELECT id,booking_id,event_type,actor_id,occurred_at,${jsonField("detail_json", "$.gatewayPaymentId")} gateway_payment_id,${jsonField("detail_json", "$.gatewayRefundId")} gateway_refund_id,${jsonField("detail_json", "$.eventId")} event_id,${jsonField("detail_json", "$.amount")} amount
    FROM booking_lifecycle_events WHERE booking_id IN (${placeholders(n)})`,
  refundCases: (n) => `SELECT id,booking_id,payment_id,amount,status,gateway_reference,requested_by,approved_by,created_at,updated_at FROM booking_refund_cases WHERE booking_id IN (${placeholders(n)})`,
  boardingRefundLedger: (n) => `SELECT 'boarding' ledger,id,booking_id,amount,status,reference,created_at,updated_at FROM boarding_refund_ledger WHERE booking_id IN (${placeholders(n)})`,
  sittingRefundLedger: (n) => `SELECT 'sitting' ledger,id,booking_id,amount,status,reference,created_at,updated_at FROM sitting_refund_ledger WHERE booking_id IN (${placeholders(n)})`,
  taxiRefundLedger: (n) => `SELECT 'taxi' ledger,id,booking_id,amount,status,reference,created_at,updated_at FROM taxi_refund_ledger WHERE booking_id IN (${placeholders(n)})`,
  boardingCancellations: (n) => `SELECT id,booking_id,status,approved_refund_amount,created_at,updated_at FROM boarding_cancellation_requests WHERE booking_id IN (${placeholders(n)})`,
  invoices: (n) => `SELECT id,booking_id,invoice_number,status,gross_amount,tax_amount,net_amount,issued_at,created_at FROM booking_invoices WHERE booking_id IN (${placeholders(n)})`,
  financeInvoices: (n) => `SELECT id,invoice_number,source_type,source_id,status,total,created_at FROM finance_invoices WHERE source_id IN (${placeholders(n)})`,
};

/** Reads keyed by something other than the booking id (payment ids, ledger group keys, journal refs, outbox keys). */
export const KEYED_SQL = {
  postings: (n) => `SELECT group_key,event,payment_id,settlement_id,reversal_reference,amount,period_code,manual_entry,verification_status,created_by,created_at FROM collection_ledger_postings WHERE payment_id IN (${placeholders(n)})`,
  journalLines: (n) => `SELECT id,entry_date,source_type,source_id,account_code,debit,credit,booking_id,payment_id,settlement_id,reversal_reference,verification_status,created_at FROM finance_journal_entries WHERE id IN (${placeholders(n)})`,
  captureJournals: (n) => `SELECT id,source_type,source_id,source_event_id,status,created_at,posted_at FROM journal_transactions WHERE source_event_id IN (${placeholders(n)})`,
  captureJournalEntries: (n) => `SELECT transaction_id,direction,amount_paise,account_code,booking_id FROM journal_entries WHERE transaction_id IN (${placeholders(n)})`,
  captureOutbox: (n) => `SELECT id,dedupe_key,status,attempts,last_error,created_at,updated_at FROM financial_outbox WHERE dedupe_key IN (${placeholders(n)})`,
  /** First bound value is the lower received_at bound; then one LIKE pattern per key. Only ids are read back, never the payload. */
  webhooks: (n) => `SELECT id,event_id,event_type,processing_status,failure_reason,received_at,processed_at,
      CASE WHEN json_valid(raw_payload) THEN json_extract(raw_payload,'$.payload.payment.entity.order_id') END pay_order_id,
      CASE WHEN json_valid(raw_payload) THEN json_extract(raw_payload,'$.payload.payment.entity.id') END pay_id,
      CASE WHEN json_valid(raw_payload) THEN json_extract(raw_payload,'$.payload.order.entity.id') END order_id,
      CASE WHEN json_valid(raw_payload) THEN json_extract(raw_payload,'$.payload.refund.entity.payment_id') END refund_pay_id,
      CASE WHEN json_valid(raw_payload) THEN json_extract(raw_payload,'$.payload.payment.entity.notes.booking_id') END note_booking_id
    FROM gateway_webhook_events WHERE received_at>=? AND (${Array.from({ length: n }, () => "raw_payload LIKE ?").join(" OR ")})`,
};

/**
 * Staging-wide reads, bounded to a window (`since` = now - 7 days, `until` = now - the definition's settle margin,
 * two minutes unless it says otherwise) so they stay cheap and never judge work still in flight. Each returns
 * offending rows only (LIMIT 50). `params(since, until)` gives the bound values; see globalBounds().
 */
export const GLOBAL_SQL = {
  capturedWithoutEvidence: {
    params: (since, until) => [since, until],
    sql: `SELECT p.id payment_id,p.booking_id,p.status,p.gateway,p.amount,p.amount_due_now,p.updated_at,
        (SELECT COUNT(*) FROM payment_gateway_events e WHERE e.payment_id=p.id AND e.processing_status='processed' AND e.event_type IN ${CAPTURE_IN}) capture_events,
        (SELECT r.captured_amount FROM payment_reconciliation_records r WHERE r.payment_id=p.id) captured_amount
      FROM booking_payments p
      WHERE p.status IN ('captured','partially_refunded','refunded') AND p.gateway IN ('razorpay','razorpay_sandbox') AND p.updated_at>=? AND p.updated_at<?
        AND (NOT EXISTS (SELECT 1 FROM payment_gateway_events e WHERE e.payment_id=p.id AND e.processing_status='processed' AND e.event_type IN ${CAPTURE_IN})
          OR NOT EXISTS (SELECT 1 FROM payment_reconciliation_records r WHERE r.payment_id=p.id AND r.captured_amount>0))
      ORDER BY p.updated_at DESC LIMIT 50`,
  },
  duplicateCollections: {
    params: (since) => [since],
    sql: `SELECT c.payment_id,COUNT(*) postings,ROUND(SUM(c.amount),2) posted,GROUP_CONCAT(COALESCE(c.settlement_id,'(payment id)'),' ') settlements,
        (SELECT r.captured_amount FROM payment_reconciliation_records r WHERE r.payment_id=c.payment_id) captured_amount,
        (SELECT r.booking_id FROM payment_reconciliation_records r WHERE r.payment_id=c.payment_id) booking_id,
        (SELECT COUNT(DISTINCT COALESCE(NULLIF(e.gateway_payment_id,''),NULLIF(e.gateway_order_id,''),e.event_id)) FROM payment_gateway_events e WHERE e.payment_id=c.payment_id AND e.processing_status='processed' AND e.event_type IN ${CAPTURE_IN}) captures
      FROM collection_ledger_postings c
      WHERE c.event='online_payment_captured' AND c.created_at>=?
      GROUP BY c.payment_id
      HAVING (captures>0 AND COUNT(*)>captures) OR (captured_amount IS NOT NULL AND ROUND(SUM(c.amount),2)>ROUND(captured_amount,2)+0.009)
      LIMIT 50`,
  },
  capturesWithoutCollection: {
    settleMs: EFFECTS_GRACE_MS,
    params: (since, until) => [since, until],
    sql: `SELECT e.payment_id,e.booking_id,COALESCE(NULLIF(e.gateway_payment_id,''),NULLIF(e.gateway_order_id,''),e.event_id) capture_ref,MAX(e.amount_subunits) amount_subunits,MIN(e.received_at) first_seen
      FROM payment_gateway_events e
      WHERE e.processing_status='processed' AND e.event_type IN ${CAPTURE_IN}
        AND (e.signature_verified=1 OR ${jsonField("e.detail_json", "$.captureAuthority")}='provider_api')
        AND e.received_at>=? AND e.received_at<?
        AND NOT EXISTS (SELECT 1 FROM collection_ledger_postings c WHERE c.event IN ('online_payment_captured','cash_collected_confirmed') AND c.payment_id=e.payment_id
          AND (c.settlement_id IS NULL OR c.settlement_id=e.gateway_payment_id OR c.settlement_id=e.gateway_order_id))
      GROUP BY e.payment_id,capture_ref ORDER BY first_seen DESC LIMIT 50`,
  },
  moneyExceptions: {
    params: (since) => [since],
    sql: `SELECT id,booking_id,payment_id,exception_type,severity,status,created_at,
        ${jsonField("detail_json", "$.capturedAmount")} captured_amount,${jsonField("detail_json", "$.excessAmount")} excess_amount,${jsonField("detail_json", "$.refunded")} refunded,${jsonField("detail_json", "$.captured")} captured
      FROM payment_reconciliation_exceptions
      WHERE status='open' AND exception_type IN ('over_collection','refund_overage') AND created_at>=?
      ORDER BY created_at DESC LIMIT 50`,
  },
  orphanRefunds: {
    params: (since, until) => [since, since, until],
    sql: `SELECT 'exception' source,id,booking_id,payment_id,event_id,exception_type kind,status,created_at at FROM payment_reconciliation_exceptions
        WHERE exception_type IN ('orphan_gateway_refund','refund_amount_mismatch') AND status='open' AND created_at>=?
      UNION ALL
      SELECT 'gateway_event' source,id,booking_id,payment_id,event_id,event_type kind,processing_status status,received_at at FROM payment_gateway_events
        WHERE event_type IN ('refund.created','refund.processed','refund.failed') AND processing_status<>'processed' AND received_at>=? AND received_at<?
      ORDER BY at DESC LIMIT 50`,
  },
  refundsWithoutReversal: {
    params: (since, until) => [since, until],
    sql: `SELECT r.id,r.booking_id,r.payment_id,r.amount,r.status,r.gateway_reference,r.updated_at FROM booking_refund_cases r
      WHERE r.status IN ('processed','completed') AND r.updated_at>=? AND r.updated_at<?
        AND (COALESCE(r.gateway_reference,'')='' OR NOT EXISTS (SELECT 1 FROM collection_ledger_postings c WHERE c.group_key='COLL-refund_completed-'||r.gateway_reference))
      ORDER BY r.updated_at DESC LIMIT 50`,
  },
  /** One per service refund ledger; a missing table (never used on staging) is simply empty. */
  serviceRefundsNotInBooks: ["boarding_refund_ledger", "sitting_refund_ledger", "taxi_refund_ledger"].map(table => ({
    table,
    params: (since, until) => [since, until],
    sql: `SELECT '${table}' ledger,l.id,l.booking_id,l.amount,l.status,l.reference,l.updated_at FROM ${table} l
      WHERE l.status='sandbox_recorded' AND l.updated_at>=? AND l.updated_at<?
        AND NOT EXISTS (SELECT 1 FROM booking_refund_cases r WHERE r.booking_id=l.booking_id AND r.gateway_reference=l.reference AND r.status IN ('processed','completed'))
      ORDER BY l.updated_at DESC LIMIT 50`,
  })),
  captureEffectsPending: {
    settleMs: EFFECTS_GRACE_MS,
    params: (since, until) => [since, until],
    sql: `SELECT id,aggregate_type,aggregate_id,status,attempts,last_error,created_at,updated_at,${jsonField("payload_json", "$.bookingId")} booking_id FROM financial_outbox
      WHERE event_type='RAZORPAY_CAPTURE_POST_COMMIT' AND status<>'SUCCEEDED' AND created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 50`,
  },
  unbalancedCollectionJournals: {
    params: (since) => [since],
    sql: `SELECT source_type,source_id,COUNT(*) lines,ROUND(SUM(debit),2) debit,ROUND(SUM(credit),2) credit FROM finance_journal_entries
      WHERE source_type IN ('online_payment_captured','cash_collected_confirmed','bank_transfer_verified','gateway_settlement_received','refund_completed') AND created_at>=?
      GROUP BY source_type,source_id HAVING COUNT(*)<2 OR ABS(SUM(debit)-SUM(credit))>0.009 LIMIT 50`,
  },
  unbalancedCaptureJournals: {
    params: (since) => [since],
    sql: `SELECT t.id,t.source_event_id,t.status,COUNT(e.id) lines,COALESCE(SUM(CASE WHEN e.direction='DEBIT' THEN e.amount_paise END),0) debit_paise,COALESCE(SUM(CASE WHEN e.direction='CREDIT' THEN e.amount_paise END),0) credit_paise
      FROM journal_transactions t LEFT JOIN journal_entries e ON e.transaction_id=t.id
      WHERE t.source_type='razorpay_capture' AND t.created_at>=?
      GROUP BY t.id HAVING t.status<>'POSTED' OR COUNT(e.id)<2 OR debit_paise<>credit_paise LIMIT 50`,
  },
  collectionMarkersWithoutJournal: {
    params: (since) => [since],
    sql: `SELECT c.group_key,c.event,c.payment_id,c.amount,c.created_at FROM collection_ledger_postings c
      WHERE c.created_at>=? AND NOT EXISTS (SELECT 1 FROM finance_journal_entries j WHERE j.id='JRN-'||c.group_key||'-1') LIMIT 50`,
  },
  invoicesForUnpaid: {
    params: (since) => [since],
    sql: `SELECT i.id,i.booking_id,i.invoice_number,i.status,i.created_at,p.status payment_status FROM booking_invoices i LEFT JOIN booking_payments p ON p.booking_id=i.booking_id
      WHERE i.created_at>=? AND COALESCE(p.status,'') NOT IN ('captured','paid','partially_refunded','refunded') LIMIT 50`,
  },
  duplicateInvoiceNumbers: {
    params: (since) => [since, since],
    sql: `SELECT invoice_number,COUNT(*) n FROM (SELECT invoice_number FROM booking_invoices WHERE created_at>=? UNION ALL SELECT invoice_number FROM finance_invoices WHERE created_at>=?)
      GROUP BY invoice_number HAVING COUNT(*)>1 LIMIT 50`,
  },
  duplicateBookingInvoiceNumbers: {
    params: (since) => [since],
    sql: `SELECT invoice_number,COUNT(*) n FROM booking_invoices WHERE created_at>=? GROUP BY invoice_number HAVING COUNT(*)>1 LIMIT 50`,
  },
};

export const globalBounds = (def, now) => [now - GLOBAL_WINDOW_MS, now - (def.settleMs ?? SETTLE_MS)];

/** bookings.jsonl can hold several rows per booking (05 saves before and after paying): later values win, paid is sticky. */
export function mergeSavedBookings(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    const id = text(row?.bookingId);
    if (!id) continue;
    const prev = byId.get(id) || { bookingId: id, suites: [] };
    const next = { ...prev };
    for (const [key, value] of Object.entries(row)) if (value !== undefined && value !== null && value !== "" && key !== "t") next[key] = value;
    next.paid = prev.paid === true || row.paid === true;
    next.balancePaid = prev.balancePaid === true || row.balancePaid === true;
    next.suites = [...new Set([...(prev.suites || []), row.suite].filter(Boolean))];
    byId.set(id, next);
  }
  return [...byId.values()];
}

export const chunk = (list, size = IN_CHUNK) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };

/** Distinct gateway captures: rows sharing a payment id or an order id are the same money (distinctCaptureCount in lib). */
export function groupCaptures(rows) {
  const groups = [];
  for (const row of rows) {
    const refs = [row.gateway_payment_id, row.gateway_order_id].map(text).filter(Boolean);
    const key = refs.length ? refs : [text(row.event_id)];
    const hit = groups.filter(group => group.refs.some(ref => key.includes(ref)));
    let group = hit[0];
    if (!group) { group = { refs: [], rows: [] }; groups.push(group); }
    for (const other of hit.slice(1)) { group.refs.push(...other.refs); group.rows.push(...other.rows); groups.splice(groups.indexOf(other), 1); }
    group.refs.push(...key.filter(ref => !group.refs.includes(ref)));
    group.rows.push(row);
  }
  return groups.map(group => {
    const rowsSorted = [...group.rows].sort((a, b) => Number(a.received_at) - Number(b.received_at));
    const amounts = [...new Set(rowsSorted.map(row => Number(row.amount_subunits)))];
    const primary = rowsSorted.filter(row => !/repeat notification/i.test(text(row.failure_reason)) && !(row.duplicate_capture === 1 || row.duplicate_capture === true || row.duplicate_capture === "true"));
    return {
      refs: [...new Set(group.refs)],
      gatewayPaymentId: rowsSorted.map(row => text(row.gateway_payment_id)).find(Boolean) || null,
      gatewayOrderId: rowsSorted.map(row => text(row.gateway_order_id)).find(Boolean) || null,
      amount: round2(Math.max(...amounts.filter(Number.isFinite), 0) / 100),
      amountsDisagree: amounts.length > 1,
      rows: rowsSorted.length,
      primaryRows: primary.length,
      repeatRows: rowsSorted.length - primary.length,
      authorities: [...new Set(rowsSorted.map(row => (Number(row.signature_verified) === 1 ? "webhook" : text(row.capture_authority) || "untrusted")))],
      firstAt: Number(rowsSorted[0]?.received_at || 0),
    };
  }).sort((a, b) => a.firstAt - b.firstAt);
}

const trusted = (row) => Number(row.signature_verified) === 1 || text(row.capture_authority) === "provider_api";
const by = (rows, key) => { const map = new Map(); for (const row of rows || []) { const k = text(row[key]); if (!map.has(k)) map.set(k, []); map.get(k).push(row); } return map; };
const one = (rows, key) => { const map = new Map(); for (const row of rows || []) map.set(text(row[key]), row); return map; };
const journalGroup = (id) => text(id).replace(/-\d+$/, "");

/**
 * Index every per-booking read once. `data` holds arrays (rows) per source name; a source that failed is
 * absent and its name is in `data.failed` (the invariants that need it report BLOCKED instead of guessing).
 */
export function indexData(data) {
  return {
    bookings: one(data.bookings, "booking_id"),
    stay: one(data.staySchedules, "booking_id"),
    taxi: one(data.taxiSchedules, "booking_id"),
    intents: by(data.intents, "booking_id"),
    links: one(data.links, "booking_id"),
    events: by(data.events, "booking_id"),
    recon: one(data.reconciliation, "booking_id"),
    exceptions: by(data.exceptions, "booking_id"),
    lifecycle: by(data.lifecycle, "booking_id"),
    refundCases: by(data.refundCases, "booking_id"),
    serviceRefunds: by([...(data.boardingRefundLedger || []), ...(data.sittingRefundLedger || []), ...(data.taxiRefundLedger || [])], "booking_id"),
    boardingCancellations: by(data.boardingCancellations, "booking_id"),
    invoices: by(data.invoices, "booking_id"),
    financeInvoices: by(data.financeInvoices, "source_id"),
    postings: by(data.postings, "payment_id"),
    journalLines: by((data.journalLines || []).map(row => ({ ...row, __group: journalGroup(row.id) })), "__group"),
    captureJournals: one(data.captureJournals, "source_event_id"),
    captureJournalEntries: by(data.captureJournalEntries, "transaction_id"),
    outbox: one(data.captureOutbox, "dedupe_key"),
    webhooks: data.webhookRows || [],
    failed: new Set(data.failed || []),
  };
}

/** Everything the evaluators need about one booking, in one place (also written to transactions-audit.json). */
export function bookingFacts(saved, ix, now) {
  const id = saved.bookingId;
  const b = ix.bookings.get(id) || null;
  const service = text(b?.service_code) || text(saved.service);
  const events = ix.events.get(id) || [];
  const captureRows = events.filter(row => CAPTURE_TYPES.includes(text(row.event_type)));
  const counted = captureRows.filter(row => text(row.processing_status) === "processed" && trusted(row));
  const captures = groupCaptures(counted);
  const capturedSum = round2(captures.reduce((sum, capture) => sum + capture.amount, 0));
  const refundCases = ix.refundCases.get(id) || [];
  const refundsDone = refundCases.filter(row => REFUND_DONE.includes(text(row.status)));
  const refundedSum = round2(refundsDone.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const stay = ix.stay.get(id) || null, taxi = ix.taxi.get(id) || null;
  const scheduleTotal = stay ? round2(Number(stay.paid_now_amount || 0) + Number(stay.balance_amount || 0)) : taxi ? round2(Number(taxi.booking_fee_amount || 0) + Number(taxi.balance_amount || 0)) : null;
  const bookingValue = scheduleTotal ?? (b ? round2(Number(b.payment_amount || 0)) : null);
  const paymentStatus = text(b?.payment_status);
  const sandboxCaptured = Boolean(b) && captures.length === 0 && COLLECTED_STATUSES.includes(paymentStatus) && text(b.payment_gateway) === "uat_sandbox";
  const lifecycle = ix.lifecycle.get(id) || [];
  return {
    id, saved, b, service, events, captureRows, captures, capturedSum, refundCases, refundsDone, refundedSum, stay, taxi, scheduleTotal, bookingValue,
    paymentId: text(b?.payment_id) || null, paymentStatus, sandboxCaptured, lifecycle,
    recon: ix.recon.get(id) || null,
    intents: ix.intents.get(id) || [],
    link: ix.links.get(id) || null,
    exceptions: ix.exceptions.get(id) || [],
    serviceRefunds: ix.serviceRefunds.get(id) || [],
    boardingCancellations: ix.boardingCancellations.get(id) || [],
    invoices: ix.invoices.get(id) || [],
    financeInvoices: ix.financeInvoices.get(id) || [],
    postings: b?.payment_id ? (ix.postings.get(text(b.payment_id)) || []) : [],
    webhooks: [],
    // Shared lookups (keyed by journal source event, journal id, outbox dedupe key, JRN-<group key>).
    captureJournal: ix.captureJournals, captureJournalLines: ix.captureJournalEntries, captureOutbox: ix.outbox, journalLines: ix.journalLines,
    now,
  };
}

/** Keys for the keyed reads, derived from the per-booking facts. */
export function keyedReadKeys(facts) {
  const paymentIds = [...new Set(facts.map(fact => fact.paymentId).filter(Boolean))];
  const captureRefs = [...new Set(facts.flatMap(fact => fact.captures.flatMap(capture => capture.refs)))];
  return {
    paymentIds,
    captureJournalKeys: captureRefs.map(ref => `razorpay:capture:${ref}`),
    outboxKeys: captureRefs.map(ref => `razorpay-capture-effects:${ref}`),
  };
}

/** Journal line ids of the collection postings (prepareJournalPosting writes JRN-<group key>-1, -2, …). */
export const journalLineIds = (postings) => [...new Set((postings || []).flatMap(row => [1, 2, 3].map(n => `JRN-${text(row.group_key)}-${n}`)))];

/**
 * Chunked read through an injected `query(sql, params)` (lib d1() on the runner, node:sqlite locally). It returns
 * an array of rows, or null when the read failed; a table that does not exist yet reads as empty (noted), because
 * the runtime DDL only creates a table the first time the product needs it.
 */
export async function readChunked(query, data, name, sqlFor, keys, { lead = [], size = IN_CHUNK } = {}) {
  const rows = [];
  for (const part of chunk(keys, size)) {
    if (!part.length) continue;
    const result = await query(sqlFor(part.length), [...lead, ...part]);
    if (Array.isArray(result)) { rows.push(...result); continue; }
    const message = String(result?.detail || result?.error || result?.skipped || "no result").slice(0, 300);
    if (/no such table/i.test(message)) { data.missingTables.push(name); return rows; }
    data.failed.push(name); data.errors[name] = message; return null;
  }
  return rows;
}

/** Every per-booking and keyed read the audit needs, in dependency order. */
export async function collectAuditData(query, bookingIds) {
  const data = { failed: [], errors: {}, missingTables: [] };
  for (const [name, sqlFor] of Object.entries(BOOKING_SQL)) {
    const rows = await readChunked(query, data, name, sqlFor, bookingIds);
    if (rows) data[name] = rows;
  }
  // A service refund ledger that fails for another reason blocks the refunds invariant as a whole.
  if (["boardingRefundLedger", "sittingRefundLedger", "taxiRefundLedger"].some(name => data.failed.includes(name))) data.failed.push("serviceRefunds");
  const draft = bookingFactsFor(bookingIds.map(bookingId => ({ bookingId })), data, Date.now());
  const keys = keyedReadKeys(draft);
  const postings = await readChunked(query, data, "postings", KEYED_SQL.postings, keys.paymentIds);
  if (postings) data.postings = postings;
  const lines = postings ? await readChunked(query, data, "journalLines", KEYED_SQL.journalLines, journalLineIds(postings)) : null;
  if (lines) data.journalLines = lines;
  const journals = await readChunked(query, data, "captureJournals", KEYED_SQL.captureJournals, keys.captureJournalKeys);
  if (journals) {
    data.captureJournals = journals;
    const entries = await readChunked(query, data, "captureJournalEntries", KEYED_SQL.captureJournalEntries, journals.map(row => text(row.id)));
    if (entries) data.captureJournalEntries = entries; else data.failed.push("captureJournals");
  }
  const outbox = await readChunked(query, data, "captureOutbox", KEYED_SQL.captureOutbox, keys.outboxKeys);
  if (outbox) data.captureOutbox = outbox;
  return data;
}

/** Webhook inbox rows carrying any identifier of these bookings, received since `since` (40 LIKE patterns per read). */
export async function collectWebhooks(query, data, facts, since) {
  const keys = [...new Set(facts.flatMap(webhookKeys))];
  const rows = await readChunked(query, data, "webhooks", KEYED_SQL.webhooks, keys.map(key => `%${key}%`), { lead: [since], size: 40 });
  const unique = rows ? [...new Map(rows.map(row => [text(row.id), row])).values()] : null;
  if (unique) data.webhookRows = unique;
  return unique;
}

export const bookingFactsFor = (saved, data, now) => { const ix = indexData(data); return saved.map(row => bookingFacts(row, ix, now)); };

/** Gateway identifiers a webhook for this booking can carry (order ids of every stage, payment ids, the booking id in notes). */
export function webhookKeys(fact) {
  const keys = new Set([fact.id]);
  for (const intent of fact.intents) { if (text(intent.gateway_order_id)) keys.add(text(intent.gateway_order_id)); if (text(intent.gateway_payment_id)) keys.add(text(intent.gateway_payment_id)); }
  if (fact.link) { if (text(fact.link.gateway_order_id)) keys.add(text(fact.link.gateway_order_id)); if (text(fact.link.gateway_payment_id)) keys.add(text(fact.link.gateway_payment_id)); }
  for (const row of fact.events) { if (text(row.gateway_order_id)) keys.add(text(row.gateway_order_id)); if (text(row.gateway_payment_id)) keys.add(text(row.gateway_payment_id)); }
  return [...keys];
}

/** Attach each webhook row to the bookings whose identifiers it carries (ids read out of the payload in SQL). */
export function attachWebhooks(facts, rows) {
  const owner = new Map();
  for (const fact of facts) for (const key of webhookKeys(fact)) owner.set(key, fact);
  for (const fact of facts) fact.webhooks = [];
  for (const row of rows || []) {
    const hits = new Set([row.pay_order_id, row.pay_id, row.order_id, row.refund_pay_id, row.note_booking_id].map(text).filter(Boolean).map(key => owner.get(key)).filter(Boolean));
    for (const fact of hits) fact.webhooks.push(row);
  }
}

const problem = (list, sev, msg) => list.push({ sev, msg });
const note = (list, msg) => list.push({ sev: "note", msg });
const expectedGatewayStatus = (fact) => {
  if (!fact.refundsDone.length) return ["captured"];
  const expected = Number(fact.recon?.expected_amount || 0);
  return [fact.refundedSum + 0.009 >= expected ? "refunded" : "partially_refunded"];
};

/** booking_payments: the row exists, amounts match the quote the customer paid against, status follows the money. */
export function checkPayments(fact) {
  const out = [], { b, saved } = fact;
  if (!b) {
    if (/^PS-/i.test(fact.id)) problem(out, "P0", `booking not found in canonical_bookings (booking lost)`);
    else note(out, `saved id is not a canonical booking id; not audited`);
    return out;
  }
  if (!fact.paymentId) { problem(out, "P0", `no booking_payments row`); return out; }
  const total = Number(b.payment_amount), dueNow = Number(b.amount_due_now);
  if (Number.isFinite(Number(saved.total)) && saved.total !== null && !same(total, saved.total)) {
    // A completed Pet Taxi ride with waiting / extra-stop adjustments legitimately re-prices the booking.
    if (Number(b.trip_adjusted) === 1) note(out, `total re-priced by trip adjustments: ${rupees(saved.total)} quoted → ${rupees(total)}`);
    else problem(out, "P0", `booking_payments.amount ${rupees(total)} ≠ quoted total ${rupees(saved.total)}`);
  }
  if (Number.isFinite(Number(saved.dueNow)) && saved.dueNow !== null && !same(dueNow, saved.dueNow)) problem(out, "P0", `amount_due_now ${rupees(dueNow)} ≠ quoted due now ${rupees(saved.dueNow)}`);
  if (!same(b.booking_total, total)) problem(out, "P0", `canonical_bookings.total_amount ${rupees(b.booking_total)} ≠ booking_payments.amount ${rupees(total)}`);
  if (dueNow > total + 0.009) problem(out, "P0", `amount_due_now ${rupees(dueNow)} exceeds the booking total ${rupees(total)}`);
  const status = fact.paymentStatus, bookingStatus = text(b.booking_status);
  if (fact.sandboxCaptured) note(out, `payment ${status} on gateway uat_sandbox at creation (no Razorpay capture expected)`);
  else if (fact.captures.length) {
    const allowed = fact.refundsDone.length ? ["partially_refunded", "refunded"] : ["captured", "paid"];
    if (!allowed.includes(status)) problem(out, "P1", `payment status '${status}' after ${fact.captures.length} verified capture(s)${fact.refundsDone.length ? ` and ${fact.refundsDone.length} processed refund(s)` : ""}; expected ${allowed.join("/")}`);
    if (bookingStatus === "payment_pending" && fact.capturedSum + 0.009 >= dueNow) {
      if (fact.now - (fact.captures[0]?.firstAt || 0) > EFFECTS_GRACE_MS) problem(out, "P1", `booking still payment_pending after ${rupees(fact.capturedSum)} was captured (due now ${rupees(dueNow)})`);
      else note(out, `booking confirmation pending (captured ${Math.round((fact.now - (fact.captures[0]?.firstAt || 0)) / 1000)} s ago)`);
    }
  } else {
    if (COLLECTED_STATUSES.includes(status)) problem(out, "P0", `payment status '${status}' with no verified Razorpay capture`);
    if (["confirmed", "assigned", "awaiting_host_acceptance", "in_progress", "completed"].includes(bookingStatus) && text(b.payment_mode) !== "pay_after_service" && dueNow > 0) problem(out, "P1", `booking '${bookingStatus}' without any verified capture`);
  }
  if (saved.paid === true && !fact.captures.length && !fact.sandboxCaptured) problem(out, "P0", `the saving suite saw this payment captured, but D1 holds no verified capture (money not recorded)`);
  if (saved.paid !== true && fact.captures.length) note(out, `captured ${rupees(fact.capturedSum)} although the saving suite recorded it unpaid (capture landed after it stopped polling?)`);
  return out;
}

/** Split / taxi-fee schedules: instalments add up, due date is 24 h before the start, status follows the captures. */
export function checkSchedules(fact) {
  const out = [], { b, stay, taxi } = fact;
  if (!b || !fact.paymentId) return out;
  const total = Number(b.payment_amount), dueNow = Number(b.amount_due_now), mode = text(b.payment_mode);
  const isStay = ["boarding", "pet_sitting"].includes(fact.service), isTaxi = fact.service === "pet_taxi";
  if (isStay && mode === "split_50_50" && !stay) problem(out, "P0", `split booking has no stay_payment_schedules row (the balance would never be requested)`);
  if (isStay && mode !== "split_50_50" && stay) problem(out, "P1", `'${mode}' booking carries a split schedule (${text(stay.status)})`);
  if (stay) {
    if (!same(stay.total_amount, total)) problem(out, "P0", `schedule total ${rupees(stay.total_amount)} ≠ booking ${rupees(total)}`);
    if (!same(stay.paid_now_amount, dueNow)) problem(out, "P0", `schedule deposit ${rupees(stay.paid_now_amount)} ≠ amount_due_now ${rupees(dueNow)}`);
    if (!same(round2(Number(stay.paid_now_amount) + Number(stay.balance_amount)), total)) problem(out, "P0", `deposit ${rupees(stay.paid_now_amount)} + balance ${rupees(stay.balance_amount)} ≠ total ${rupees(total)}`);
    const start = Date.parse(text(b.scheduled_start)), due = Number(stay.balance_due_at);
    if (Number.isFinite(start) && Math.abs(due - (start - 24 * 3_600_000)) > 5 * 60_000) problem(out, "P1", `balance due ${new Date(due).toISOString()} is not 24 h before the start ${text(b.scheduled_start)}`);
    const balanceIn = fact.captures.length >= 2 || (fact.captures.length && fact.capturedSum + 0.009 >= Number(fact.scheduleTotal));
    const status = text(stay.status);
    if (balanceIn) {
      if (status !== "paid") problem(out, "P1", `balance captured (${rupees(fact.capturedSum)} of ${rupees(fact.scheduleTotal)}) but the schedule is '${status}'`);
      else {
        if (!Number(stay.paid_at)) problem(out, "P1", `schedule paid without paid_at`);
        const balanceRef = fact.captures.at(-1)?.gatewayPaymentId;
        if (!text(stay.payment_ref)) problem(out, "P1", `schedule paid without a payment_ref`);
        else if (balanceRef && text(stay.payment_ref) !== balanceRef && !/^SBX-BAL-/.test(text(stay.payment_ref))) note(out, `schedule payment_ref ${text(stay.payment_ref)} is not the balance capture ${balanceRef}`);
      }
    } else {
      if (status === "paid") problem(out, "P0", `schedule marked paid but only ${rupees(fact.capturedSum)} of ${rupees(fact.scheduleTotal)} was captured`);
      else if (!["pending_balance", "overdue"].includes(status)) problem(out, "P1", `unexpected schedule status '${status}'`);
      else if (status === "overdue" && fact.now < Number(stay.balance_due_at)) problem(out, "P1", `schedule 'overdue' before its due time`);
    }
    if (fact.saved.balancePaid === true && !balanceIn) problem(out, "P0", `the saving suite paid the balance, but D1 shows only ${rupees(fact.capturedSum)} captured`);
  }
  if (isTaxi) {
    if (!taxi) { problem(out, "P0", `Pet Taxi booking has no taxi_payment_schedules row (the balance would never be requested)`); return out; }
    if (!same(taxi.total_amount, total)) problem(out, "P0", `taxi schedule total ${rupees(taxi.total_amount)} ≠ booking ${rupees(total)}`);
    if (!same(taxi.booking_fee_amount, dueNow)) problem(out, "P0", `booking fee ${rupees(taxi.booking_fee_amount)} ≠ amount_due_now ${rupees(dueNow)}`);
    if (!same(round2(Number(taxi.booking_fee_amount) + Number(taxi.balance_amount)), total)) problem(out, "P0", `fee ${rupees(taxi.booking_fee_amount)} + balance ${rupees(taxi.balance_amount)} ≠ total ${rupees(total)}`);
    const status = text(taxi.status), full = fact.captures.length && fact.capturedSum + 0.009 >= Number(taxi.total_amount), fee = fact.captures.length && fact.capturedSum + 0.009 >= Number(taxi.booking_fee_amount);
    if (full) { if (status !== "paid" || !Number(taxi.final_paid_at) || !text(taxi.final_payment_reference)) problem(out, "P1", `fully captured but the taxi schedule is '${status}' (final_paid_at ${taxi.final_paid_at ?? "null"})`); }
    else if (fee) {
      if (!["pending_balance", "booking_fee_paid"].includes(status)) problem(out, status === "paid" ? "P0" : "P1", `booking fee captured but the taxi schedule is '${status}'`);
      if (!Number(taxi.booking_fee_paid_at) || !text(taxi.booking_fee_reference)) problem(out, "P1", `booking fee captured without booking_fee_paid_at / booking_fee_reference`);
      else if (fact.captures[0]?.gatewayPaymentId && text(taxi.booking_fee_reference) !== fact.captures[0].gatewayPaymentId) note(out, `booking_fee_reference ${text(taxi.booking_fee_reference)} is not the fee capture ${fact.captures[0].gatewayPaymentId}`);
    } else if (!fact.sandboxCaptured && status !== "booking_fee_pending") problem(out, status === "paid" ? "P0" : "P1", `nothing captured but the taxi schedule is '${status}'`);
    if (fact.saved.balancePaid === true && !full && text(b.payment_status) !== "paid") problem(out, "P0", `the saving suite paid the ride balance, but D1 shows only ${rupees(fact.capturedSum)} captured`);
  }
  return out;
}

/** Capture evidence: every counted capture is verified, matches its order, is journalled once and its effects ran. */
export function checkCaptures(fact) {
  const out = [];
  if (!fact.b || fact.sandboxCaptured) return out;
  const stages = fact.stay || fact.taxi ? 2 : 1;
  for (const row of fact.captureRows) {
    if (text(row.processing_status) === "processed" && !trusted(row)) problem(out, "P0", `capture event ${text(row.event_id)} counted without a verified signature or provider read`);
    if (text(row.processing_status) !== "processed") {
      const ref = text(row.gateway_payment_id) || text(row.gateway_order_id);
      const counted = fact.captures.some(capture => capture.refs.includes(ref));
      problem(out, counted ? "P1" : "P0", `capture event ${text(row.event_type)} ${ref || text(row.event_id)} is '${text(row.processing_status)}'${row.failure_reason ? ` (${text(row.failure_reason)})` : ""}${counted ? "" : " and that money is not counted"}`);
    }
  }
  // Decision (main session): an over-collection the product already flagged (reconciliation over_collected + open
  // over_collection exception) is reported as P2 "over-collection flagged correctly"; unflagged it stays P0.
  const flagged = text(fact.recon?.reconciliation_status) === "over_collected" && fact.exceptions.some(row => text(row.exception_type) === "over_collection" && text(row.status) === "open");
  if (fact.captures.length > stages) problem(out, flagged ? "P2" : "P0", `${flagged ? "over-collection flagged correctly: " : ""}${fact.captures.length} distinct Razorpay captures on a booking payable in ${stages} stage(s) (customer charged ${fact.captures.length} times: ${fact.captures.map(c => `${c.gatewayPaymentId || c.refs[0]} ${rupees(c.amount)}`).join(", ")})`);
  const dueNow = Number(fact.b.amount_due_now), total = Number(fact.b.payment_amount);
  if (fact.captures[0] && !same(fact.captures[0].amount, dueNow) && !same(fact.captures[0].amount, total)) problem(out, "P0", `first capture ${rupees(fact.captures[0].amount)} is neither the amount due now ${rupees(dueNow)} nor the total`);
  if (stages === 2 && fact.captures[1] && !same(fact.captures[1].amount, round2(total - dueNow))) problem(out, "P0", `balance capture ${rupees(fact.captures[1].amount)} ≠ balance ${rupees(round2(total - dueNow))}`);
  for (const capture of fact.captures) {
    const label = capture.gatewayPaymentId || capture.refs[0];
    if (capture.amountsDisagree) problem(out, "P0", `capture ${label}: its event rows disagree on the amount`);
    const intent = fact.intents.find(row => capture.refs.includes(text(row.gateway_order_id)));
    if (intent) {
      if (Number(intent.amount_paise) !== Math.round(capture.amount * 100)) problem(out, "P0", `capture ${label} ${rupees(capture.amount)} ≠ its order ${text(intent.gateway_order_id)} ${rupees(Number(intent.amount_paise) / 100)}`);
      if (!["CAPTURED", "SETTLED"].includes(text(intent.state))) problem(out, "P1", `order ${text(intent.gateway_order_id)} captured but its payment intent is '${text(intent.state)}'`);
    } else note(out, `capture ${label} has no payment intent (linked through payment_gateway_links)`);
    const journal = capture.refs.map(ref => fact.captureJournal?.get(`razorpay:capture:${ref}`)).find(Boolean);
    if (!journal) problem(out, "P1", `capture ${label} has no razorpay_capture journal transaction`);
    else {
      const lines = fact.captureJournalLines?.get(text(journal.id)) || [];
      const debit = lines.filter(line => text(line.direction) === "DEBIT").reduce((sum, line) => sum + Number(line.amount_paise || 0), 0);
      const credit = lines.filter(line => text(line.direction) === "CREDIT").reduce((sum, line) => sum + Number(line.amount_paise || 0), 0);
      if (text(journal.status) !== "POSTED") problem(out, "P1", `capture journal ${text(journal.id)} is '${text(journal.status)}'`);
      if (debit !== credit || debit !== Math.round(capture.amount * 100)) problem(out, "P0", `capture journal ${text(journal.id)} debit ${debit} / credit ${credit} paise ≠ capture ${Math.round(capture.amount * 100)} paise`);
    }
    const effects = capture.refs.map(ref => fact.captureOutbox?.get(`razorpay-capture-effects:${ref}`)).find(Boolean);
    if (!effects) problem(out, "P1", `capture ${label} has no post-commit effects outbox row`);
    else if (text(effects.status) !== "SUCCEEDED") {
      if (fact.now - Number(effects.created_at) > EFFECTS_GRACE_MS) problem(out, "P1", `capture ${label} post-commit effects '${text(effects.status)}' after ${effects.attempts} attempt(s): ${text(effects.last_error).slice(0, 120)}`);
      else note(out, `capture ${label} post-commit effects still '${text(effects.status)}' (in flight)`);
    }
    if (capture.primaryRows > 1) note(out, `capture ${label}: ${capture.primaryRows} processed rows raced past the replay check (counted once by design)`);
  }
  return out;
}

/** Webhooks for this booking's orders: none stuck RECEIVED/PROCESSING past the settle time, none FAILED. */
export function checkWebhooks(fact) {
  const out = [];
  if (!fact.b) return out;
  for (const row of fact.webhooks) {
    const status = text(row.processing_status), age = fact.now - Number(row.received_at), capture = CAPTURE_TYPES.includes(text(row.event_type));
    const moneyUncounted = capture && !fact.captures.length;
    if (["RECEIVED", "PROCESSING"].includes(status)) {
      if (age >= SETTLE_MS) problem(out, moneyUncounted ? "P0" : "P1", `webhook ${text(row.event_type) || "(untyped)"} ${text(row.event_id)} stuck '${status}' for ${Math.round(age / 60_000)} min${moneyUncounted ? " and no capture is recorded" : ""}`);
      else note(out, `webhook ${text(row.event_type)} ${text(row.event_id)} still '${status}' (${Math.round(age / 1000)} s old)`);
    } else if (status === "FAILED") problem(out, moneyUncounted ? "P0" : "P1", `webhook ${text(row.event_type)} ${text(row.event_id)} FAILED: ${text(row.failure_reason).slice(0, 120) || "no failure reason recorded"}${moneyUncounted ? " (no capture recorded)" : capture ? " (its capture is counted through another notification)" : ""}`);
    else if (status === "DEFERRED" && moneyUncounted && age >= SETTLE_MS) problem(out, "P0", `capture webhook ${text(row.event_id)} DEFERRED (${text(row.failure_reason).slice(0, 80)}) and no capture is recorded: money taken by Razorpay is not on the booking`);
    else if (["DEFERRED", "REJECTED"].includes(status)) note(out, `webhook ${text(row.event_type)} ${text(row.event_id)} '${status}' (${text(row.failure_reason).slice(0, 80)})`);
  }
  if (fact.captures.length && !fact.webhooks.length) note(out, `no Razorpay webhook for this booking's orders reached staging (captured through the provider read)`);
  return out;
}

/** Reconciliation: captured_amount is the sum of distinct captures, status and variance follow the booking value. */
export function checkReconciliation(fact) {
  const out = [], rec = fact.recon;
  if (!fact.b || !fact.paymentId) return out;
  if (fact.sandboxCaptured) { if (rec && Number(rec.captured_amount) > 0) note(out, `sandbox-captured payment also has a reconciliation record (${rupees(rec.captured_amount)})`); return out; }
  if (!fact.captures.length) {
    if (rec && text(rec.reconciliation_status) === "amount_mismatch") problem(out, "P0", `Razorpay captured ${rupees(rec.captured_amount)} with the wrong amount (capture_amount_mismatch): the customer was charged but the booking is not paid`);
    else {
      if (rec && Number(rec.captured_amount) > 0.009) problem(out, "P0", `reconciliation says ${rupees(rec.captured_amount)} captured, but there is no verified capture`);
      if (rec && ["captured", "refunded", "partially_refunded"].includes(text(rec.gateway_status))) problem(out, "P1", `reconciliation gateway_status '${text(rec.gateway_status)}' with no verified capture`);
    }
    return out;
  }
  if (!rec) { problem(out, "P0", `${fact.captures.length} capture(s) of ${rupees(fact.capturedSum)} but no payment_reconciliation_records row`); return out; }
  if (text(rec.payment_id) !== fact.paymentId) problem(out, "P1", `reconciliation row is for payment ${text(rec.payment_id)}, the booking's payment is ${fact.paymentId}`);
  const captured = round2(rec.captured_amount), refunded = round2(rec.refunded_amount), variance = round2(rec.variance_amount);
  if (!same(captured, fact.capturedSum)) problem(out, "P0", `captured_amount ${rupees(captured)} ≠ sum of distinct captures ${rupees(fact.capturedSum)}`);
  if (!same(refunded, fact.refundedSum)) problem(out, "P0", `refunded_amount ${rupees(refunded)} ≠ processed refund cases ${rupees(fact.refundedSum)}`);
  const gatewayExpected = expectedGatewayStatus(fact);
  if (!gatewayExpected.includes(text(rec.gateway_status))) problem(out, "P1", `gateway_status '${text(rec.gateway_status)}', expected ${gatewayExpected.join("/")}`);
  let expected, expectedVariance = 0;
  if (fact.refundsDone.length) {
    expected = refunded - captured > 0.009 ? "refund_overage" : "matched";
    expectedVariance = Math.max(0, round2(refunded - captured));
    if (expected === "refund_overage") problem(out, "P0", `refunded ${rupees(refunded)} exceeds the ${rupees(captured)} captured`);
  } else if (Number(fact.bookingValue) > 0 && captured > Number(fact.bookingValue) + 0.009) {
    expected = "over_collected"; expectedVariance = round2(captured - Number(fact.bookingValue));
    const flagged = text(rec.reconciliation_status) === "over_collected" && fact.exceptions.some(row => text(row.exception_type) === "over_collection" && text(row.status) === "open");
    problem(out, flagged ? "P2" : "P0", `${flagged ? "over-collection flagged correctly: " : ""}over-collected: ${rupees(captured)} captured on a ${rupees(fact.bookingValue)} booking`);
  } else if (fact.scheduleTotal !== null) expected = captured + 0.009 >= Number(fact.scheduleTotal) ? "matched" : "partially_captured";
  else expected = "matched";
  if (text(rec.reconciliation_status) !== expected) problem(out, "P1", `reconciliation_status '${text(rec.reconciliation_status)}', expected '${expected}' (captured ${rupees(captured)}, value ${rupees(fact.bookingValue)}${fact.refundsDone.length ? `, refunded ${rupees(refunded)}` : ""})`);
  if (!same(variance, expectedVariance)) problem(out, "P1", `variance_amount ${rupees(variance)}, expected ${rupees(expectedVariance)}`);
  return out;
}

/** Collection ledger: one balanced online_payment_captured posting per capture, nothing extra, total = captured. */
export function checkLedger(fact) {
  const out = [];
  if (!fact.b || !fact.paymentId) return out;
  const collections = fact.postings.filter(row => text(row.event) === "online_payment_captured" || text(row.event) === "cash_collected_confirmed");
  const balanced = (posting) => {
    const lines = fact.journalLines?.get(`JRN-${text(posting.group_key)}`) || [];
    const debit = round2(lines.reduce((sum, line) => sum + Number(line.debit || 0), 0)), credit = round2(lines.reduce((sum, line) => sum + Number(line.credit || 0), 0));
    if (lines.length < 2) return `${lines.length} journal line(s)`;
    if (!same(debit, credit) || !same(debit, posting.amount)) return `journal debit ${rupees(debit)} / credit ${rupees(credit)} ≠ ${rupees(posting.amount)}`;
    return null;
  };
  if (fact.sandboxCaptured) {
    if (!collections.length) problem(out, "P1", `sandbox-captured payment has no collection posting`);
    for (const posting of collections) { const issue = balanced(posting); if (issue) problem(out, "P0", `${text(posting.group_key)}: ${issue}`); }
    return out;
  }
  if (!fact.captures.length) {
    for (const posting of collections) problem(out, "P0", `collection ${text(posting.group_key)} ${rupees(posting.amount)} posted with no verified capture`);
    return out;
  }
  const used = new Set();
  for (const capture of fact.captures) {
    const label = capture.gatewayPaymentId || capture.refs[0];
    const posting = collections.find(row => capture.refs.includes(text(row.settlement_id)));
    if (!posting) {
      const effects = capture.refs.map(ref => fact.captureOutbox?.get(`razorpay-capture-effects:${ref}`)).find(Boolean);
      if (effects && text(effects.status) !== "SUCCEEDED" && fact.now - Number(effects.created_at) <= EFFECTS_GRACE_MS) note(out, `capture ${label}: collection posting pending (effects '${text(effects.status)}')`);
      else problem(out, "P1", `capture ${label} ${rupees(capture.amount)} has no collection posting COLL-online_payment_captured-${label}`);
      continue;
    }
    used.add(text(posting.group_key));
    if (!same(posting.amount, capture.amount)) problem(out, "P0", `collection ${text(posting.group_key)} ${rupees(posting.amount)} ≠ capture ${rupees(capture.amount)}`);
    if (text(posting.verification_status) !== "posted") problem(out, "P1", `collection ${text(posting.group_key)} is '${text(posting.verification_status)}'`);
    const issue = balanced(posting);
    if (issue) problem(out, "P0", `collection ${text(posting.group_key)}: ${issue}`);
  }
  for (const posting of collections) if (!used.has(text(posting.group_key))) problem(out, "P0", `extra collection posting ${text(posting.group_key)} ${rupees(posting.amount)} for a capture already posted (money counted twice)`);
  const postedTotal = round2(collections.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  if (fact.recon && !same(postedTotal, fact.recon.captured_amount) && !out.some(item => item.sev !== "note")) problem(out, "P0", `collections posted ${rupees(postedTotal)} ≠ reconciliation captured ${rupees(fact.recon.captured_amount)}`);
  return out;
}

/** Refunds: every recorded refund is a processed canonical case with a balanced reversal, a payment status and a timeline event. */
export function checkRefunds(fact) {
  const out = [];
  if (!fact.b) return out;
  for (const refund of fact.refundCases) {
    const status = text(refund.status), ref = text(refund.gateway_reference);
    if (!REFUND_DONE.includes(status)) { note(out, `refund case ${text(refund.id).slice(0, 8)} ${rupees(refund.amount)} is '${status}'`); continue; }
    if (!ref) { problem(out, "P1", `refund ${rupees(refund.amount)} is '${status}' without a gateway reference`); continue; }
    const reversal = fact.postings.find(row => text(row.group_key) === `COLL-refund_completed-${ref}`);
    if (!reversal) problem(out, "P1", `refund ${ref} ${rupees(refund.amount)} has no collection reversal COLL-refund_completed-${ref}`);
    else {
      if (!same(reversal.amount, refund.amount)) problem(out, "P0", `reversal ${ref} ${rupees(reversal.amount)} ≠ refund ${rupees(refund.amount)}`);
      const lines = fact.journalLines?.get(`JRN-${text(reversal.group_key)}`) || [];
      const debit = round2(lines.reduce((sum, line) => sum + Number(line.debit || 0), 0)), credit = round2(lines.reduce((sum, line) => sum + Number(line.credit || 0), 0));
      if (lines.length < 2 || !same(debit, credit) || !same(debit, refund.amount)) problem(out, "P0", `reversal ${ref} journal ${lines.length} line(s) debit ${rupees(debit)} / credit ${rupees(credit)} ≠ ${rupees(refund.amount)}`);
    }
    if (!fact.lifecycle.some(event => text(event.event_type) === "refund_processed" && (text(event.gateway_refund_id) === ref || text(event.id).endsWith(ref)))) problem(out, "P1", `refund ${ref} has no refund_processed timeline event`);
  }
  if (fact.refundsDone.length && !["partially_refunded", "refunded"].includes(fact.paymentStatus)) problem(out, "P1", `payment status '${fact.paymentStatus}' after ${rupees(fact.refundedSum)} refunded`);
  for (const row of fact.serviceRefunds) {
    const status = text(row.status), ref = text(row.reference);
    if (status === "sandbox_pending") { note(out, `${text(row.ledger)} refund ${rupees(row.amount)} approved, not yet recorded`); continue; }
    if (status !== "sandbox_recorded") continue;
    const canonical = fact.refundCases.find(refund => text(refund.gateway_reference) === ref && REFUND_DONE.includes(text(refund.status)));
    if (!canonical) problem(out, "P1", `${text(row.ledger)} refund ${ref} ${rupees(row.amount)} recorded in the service ledger but not in the canonical books (no processed refund case, reversal or reconciliation)`);
    else if (!same(canonical.amount, row.amount)) problem(out, "P0", `${text(row.ledger)} refund ${ref} ${rupees(row.amount)} ≠ canonical case ${rupees(canonical.amount)}`);
  }
  return out;
}

/** Timeline: created, confirmed after the capture, one payment_captured per capture, and the refund / over-collection facts. */
export function checkTimeline(fact) {
  const out = [];
  if (!fact.b) return out;
  const types = fact.lifecycle.map(event => text(event.event_type));
  if (!types.some(type => CREATION_EVENTS.includes(type))) problem(out, "P1", `no creation event (${[...new Set(types)].join(", ") || "no events at all"})`);
  const captured = fact.lifecycle.filter(event => text(event.event_type) === "payment_captured");
  if (fact.sandboxCaptured) return out;
  if (!fact.captures.length) { if (captured.length) problem(out, "P1", `${captured.length} payment_captured event(s) with no verified capture`); return out; }
  for (const capture of fact.captures) {
    const label = capture.gatewayPaymentId || capture.refs[0];
    const mine = captured.filter(event => capture.refs.includes(text(event.gateway_payment_id)) || capture.refs.some(ref => text(event.id).endsWith(`:${ref}`)));
    if (!mine.length) {
      if (fact.now - capture.firstAt > EFFECTS_GRACE_MS) problem(out, "P1", `capture ${label} has no payment_captured timeline event`);
      else note(out, `capture ${label}: timeline event pending`);
    } else if (mine.length > 1) problem(out, "P1", `capture ${label} has ${mine.length} payment_captured timeline events (duplicate)`);
  }
  const stray = captured.filter(event => !fact.captures.some(capture => capture.refs.includes(text(event.gateway_payment_id)) || capture.refs.some(ref => text(event.id).endsWith(`:${ref}`))));
  if (stray.length) problem(out, "P1", `${stray.length} payment_captured event(s) for no known capture (${stray.map(event => text(event.gateway_payment_id) || text(event.id)).join(", ")})`);
  const confirm = CONFIRM_EVENTS[fact.service];
  if (confirm && Number(fact.b.amount_due_now) > 0 && fact.capturedSum + 0.009 >= Number(fact.b.amount_due_now) && !types.some(type => confirm.includes(type))) {
    if (fact.now - (fact.captures[0]?.firstAt || 0) > EFFECTS_GRACE_MS) problem(out, "P1", `no ${confirm.join("/")} event after the capture (booking '${text(fact.b.booking_status)}')`);
  }
  if (text(fact.recon?.reconciliation_status) === "over_collected" && !types.includes("payment_over_collected")) problem(out, "P1", `over-collected but no payment_over_collected timeline event`);
  return out;
}

/** Invoices: none for an unpaid booking, numbers unique. */
export function checkInvoices(fact, allInvoiceNumbers) {
  const out = [];
  if (!fact.b) return out;
  const paid = fact.captures.length > 0 || fact.sandboxCaptured || COLLECTED_STATUSES.includes(fact.paymentStatus);
  for (const invoice of fact.invoices) {
    if (!paid) problem(out, "P1", `invoice ${text(invoice.invoice_number)} (${text(invoice.status)}) issued for an unpaid booking`);
    if ((allInvoiceNumbers.get(text(invoice.invoice_number)) || 0) > 1) problem(out, "P1", `invoice number ${text(invoice.invoice_number)} is used more than once`);
  }
  for (const invoice of fact.financeInvoices) if (!paid) problem(out, "P1", `finance invoice ${text(invoice.invoice_number)} issued for an unpaid booking`);
  if (fact.invoices.length > 1) problem(out, "P1", `${fact.invoices.length} booking invoices for one booking`);
  return out;
}

const short = (id) => text(id).replace(/^PS-UAT-/, "");
const day = (ms) => (Number(ms) ? new Date(Number(ms)).toISOString().slice(0, 10) : "—");
/** What each invariant saw on one booking, for PASS details (the report states what was observed). */
export const OBSERVE = {
  payments: (f) => `${short(f.id)} ${f.service} ${f.paymentStatus} ${rupees(f.b.payment_amount)} (due now ${rupees(f.b.amount_due_now)}, ${text(f.b.payment_mode)}), booking ${text(f.b.booking_status)}`,
  schedules: (f) => f.stay ? `${short(f.id)} split ${text(f.stay.status)} ${rupees(f.stay.paid_now_amount)}+${rupees(f.stay.balance_amount)} balance due ${day(f.stay.balance_due_at)}` : f.taxi ? `${short(f.id)} taxi ${text(f.taxi.status)} fee ${rupees(f.taxi.booking_fee_amount)} + ${rupees(f.taxi.balance_amount)}` : null,
  captures: (f) => f.captures.length ? `${short(f.id)} ${f.captures.map(c => `${c.gatewayPaymentId || c.refs[0]} ${rupees(c.amount)} (${c.rows} row${c.rows === 1 ? "" : "s"}${c.repeatRows ? `, ${c.repeatRows} repeat` : ""}; ${c.authorities.join("+")})`).join(" + ")}` : null,
  webhooks: (f) => f.webhooks.length ? `${short(f.id)} ${Object.entries(f.webhooks.reduce((m, w) => { const k = `${text(w.event_type)}:${text(w.processing_status)}`; m[k] = (m[k] || 0) + 1; return m; }, {})).map(([k, n]) => `${k}×${n}`).join(" ")}` : null,
  reconciliation: (f) => f.recon ? `${short(f.id)} ${text(f.recon.reconciliation_status)}/${text(f.recon.gateway_status)} captured ${rupees(f.recon.captured_amount)} refunded ${rupees(f.recon.refunded_amount)} variance ${rupees(f.recon.variance_amount)}` : null,
  ledger: (f) => f.postings.length ? `${short(f.id)} ${f.postings.map(p => `${text(p.event) === "refund_completed" ? "reversal" : "collection"} ${rupees(p.amount)}`).join(", ")}` : null,
  refunds: (f) => f.refundCases.length || f.serviceRefunds.length ? `${short(f.id)} ${[...f.refundCases.map(r => `case ${text(r.status)} ${rupees(r.amount)} ${text(r.gateway_reference)}`), ...f.serviceRefunds.map(r => `${text(r.ledger)} ledger ${text(r.status)} ${rupees(r.amount)}`)].join(", ")}` : null,
  timeline: (f) => `${short(f.id)} ${[...new Set(f.lifecycle.map(e => text(e.event_type)).filter(t => CREATION_EVENTS.includes(t) || /payment|confirm|refund|over_collected/.test(t)))].join(", ") || "no events"}`,
  invoices: (f) => f.invoices.length || f.financeInvoices.length ? `${short(f.id)} ${[...f.invoices, ...f.financeInvoices].map(i => text(i.invoice_number)).join(", ")}` : null,
};
export function observations(key, facts) { const fn = OBSERVE[key]; return fn ? facts.filter(f => f.b).map(fn).filter(Boolean) : []; }

export const INVARIANTS = [
  { key: "payments", journey: "Money trail: booking_payments status and amounts", needs: ["bookings", "events", "refundCases"], check: checkPayments,
    title: "booking_payments disagrees with the money actually paid", expected: "amount/amount_due_now equal the quote; status captured after a verified capture (partially_refunded/refunded after a refund), never captured without one; booking confirmed once due-now is captured" },
  { key: "schedules", journey: "Money trail: split and booking-fee schedules", needs: ["bookings", "events", "staySchedules", "taxiSchedules"], check: checkSchedules,
    title: "Payment schedule instalments or status are wrong", expected: "deposit + balance = total, deposit = amount due now, balance due 24 h before start; pending_balance until the balance capture, then paid (taxi: booking_fee_pending → pending_balance → paid)" },
  { key: "captures", journey: "Money trail: Razorpay capture events", needs: ["bookings", "events", "intents", "captureJournals", "captureOutbox"], check: checkCaptures,
    title: "Razorpay capture evidence is incomplete or counted wrongly", expected: "each gateway payment captured once: processed verified event rows (repeats flagged), order amount = capture, one posted balanced razorpay_capture journal, post-commit effects SUCCEEDED; never more captures than payment stages" },
  { key: "webhooks", journey: "Money trail: Razorpay webhooks for the booking's orders", needs: ["bookings", "webhooks"], check: checkWebhooks,
    title: "Razorpay webhooks for this run's orders are stuck or failed", expected: "every webhook PROCESSED (or DEFERRED/REJECTED by rule); none RECEIVED/PROCESSING after 2 minutes, none FAILED" },
  { key: "reconciliation", journey: "Money trail: payment reconciliation records", needs: ["bookings", "events", "reconciliation", "refundCases", "staySchedules", "taxiSchedules"], check: checkReconciliation,
    title: "Payment reconciliation does not match the captures", expected: "captured_amount = sum of distinct captures; partially_captured until the schedule is collected, matched after (or for prepaid), over_collected only above the booking value; variance 0 unless over-collected; refunded_amount = processed refunds" },
  { key: "ledger", journey: "Money trail: collection ledger postings", needs: ["bookings", "events", "postings", "journalLines", "reconciliation", "captureOutbox"], check: checkLedger,
    title: "Collection ledger does not equal the money captured", expected: "one online_payment_captured posting per capture keyed by the Razorpay payment id, amount = capture, two balanced journal lines, no extra posting, total = reconciliation captured_amount" },
  { key: "refunds", journey: "Money trail: refunds reversed in the books", needs: ["bookings", "refundCases", "postings", "journalLines", "lifecycle", "serviceRefunds"], check: checkRefunds,
    title: "A recorded refund did not reach the canonical books", expected: "each recorded refund = processed booking_refund_cases row with its reference, balanced COLL-refund_completed-<reference> reversal of the same amount, refund_processed timeline event, payment partially_refunded/refunded" },
  { key: "timeline", journey: "Money trail: booking timeline events", needs: ["bookings", "events", "lifecycle", "reconciliation"], check: checkTimeline,
    title: "Booking timeline is missing or duplicating payment events", expected: "a creation event, booking_confirmed_after_verified_payment (taxi: taxi_booking_confirmed_after_booking_fee) after the capture, exactly one payment_captured per capture" },
  { key: "invoices", journey: "Money trail: invoices", needs: ["bookings", "events", "invoices"], check: checkInvoices,
    title: "Invoice issued for an unpaid booking or invoice number reused", expected: "no booking or finance invoice for an unpaid booking; every invoice number unique" },
];

/** Run every per-booking invariant. Returns [{key, journey, blocked?, checked, problems:[{bookingId,sev,msg}], notes:[…]}]. */
export function evaluateBookings(facts, failedSources = new Set()) {
  const invoiceNumbers = new Map();
  for (const fact of facts) for (const invoice of [...fact.invoices, ...fact.financeInvoices]) invoiceNumbers.set(text(invoice.invoice_number), (invoiceNumbers.get(text(invoice.invoice_number)) || 0) + 1);
  return INVARIANTS.map(inv => {
    const missing = inv.needs.filter(source => failedSources.has(source));
    if (missing.length) return { ...inv, blocked: `D1 read failed for ${missing.join(", ")}`, checked: 0, problems: [], notes: [] };
    const problems = [], notes = [];
    let checked = 0;
    for (const fact of facts) {
      if (!fact.b && inv.key !== "payments") continue;
      checked += 1;
      for (const item of inv.check(fact, invoiceNumbers)) (item.sev === "note" ? notes : problems).push({ bookingId: fact.id, ...item });
    }
    return { ...inv, checked, problems, notes };
  });
}

export const worstSeverity = (problems) => (problems.some(item => item.sev === "P0") ? "P0" : problems.some(item => item.sev === "P1") ? "P1" : "P2");
export const onlyFlaggedOverCollection = (problems) => problems.length > 0 && problems.every(item => /^over-collection flagged correctly/.test(item.msg));

/** Compact per-booking summary for the JSON artefact and for record() details. */
export function factSummary(fact) {
  return {
    bookingId: fact.id, suites: fact.saved.suites, service: fact.service, saved: { total: fact.saved.total, dueNow: fact.saved.dueNow, paid: fact.saved.paid, balancePaid: fact.saved.balancePaid, paymentMode: fact.saved.paymentMode, nearTerm: fact.saved.nearTerm },
    booking: fact.b && { status: fact.b.booking_status, total: fact.b.booking_total, paymentId: fact.b.payment_id, amount: fact.b.payment_amount, dueNow: fact.b.amount_due_now, paymentStatus: fact.b.payment_status, mode: fact.b.payment_mode, gateway: fact.b.payment_gateway },
    captures: fact.captures.map(capture => ({ ref: capture.gatewayPaymentId || capture.refs[0], order: capture.gatewayOrderId, amount: capture.amount, rows: capture.rows, primaryRows: capture.primaryRows, repeats: capture.repeatRows, via: capture.authorities })),
    capturedSum: fact.capturedSum,
    schedule: fact.stay ? { kind: "stay", status: fact.stay.status, paidNow: fact.stay.paid_now_amount, balance: fact.stay.balance_amount, dueAt: fact.stay.balance_due_at && new Date(Number(fact.stay.balance_due_at)).toISOString(), paymentRef: fact.stay.payment_ref } : fact.taxi ? { kind: "taxi", status: fact.taxi.status, fee: fact.taxi.booking_fee_amount, balance: fact.taxi.balance_amount, feeRef: fact.taxi.booking_fee_reference, finalRef: fact.taxi.final_payment_reference } : null,
    reconciliation: fact.recon && { expected: fact.recon.expected_amount, captured: fact.recon.captured_amount, refunded: fact.recon.refunded_amount, gatewayStatus: fact.recon.gateway_status, status: fact.recon.reconciliation_status, variance: fact.recon.variance_amount },
    postings: fact.postings.map(row => ({ key: row.group_key, amount: row.amount, status: row.verification_status })),
    refunds: fact.refundCases.map(row => ({ status: row.status, amount: row.amount, reference: row.gateway_reference })),
    serviceRefunds: fact.serviceRefunds.map(row => ({ ledger: row.ledger, status: row.status, amount: row.amount, reference: row.reference })),
    webhooks: fact.webhooks.map(row => `${row.event_type}:${row.processing_status}`),
    timeline: [...new Set(fact.lifecycle.map(event => text(event.event_type)))],
    invoices: [...fact.invoices, ...fact.financeInvoices].map(row => row.invoice_number),
    exceptions: fact.exceptions.map(row => `${row.exception_type}:${row.status}`),
  };
}

/** Formatting shared by the INR screens (Intl, en-IN, no decimals) so UI text can be matched exactly. */
export const inr0 = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value || 0));
export const pretty = (value) => String(value || "Not recorded").replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
export const label = (value, fallback = "not configured") => String(value || fallback).replaceAll("_", " ");
