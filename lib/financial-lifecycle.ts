import { createPaymentOrderPaise, paymentEnvironment } from "./razorpay-client";

type Db = D1Database;
type Row = Record<string, unknown>;

export type PaymentState = "CREATED" | "AUTHORIZED" | "CAPTURED" | "SETTLED" | "FAILED" | "CANCELLED";

const encoder = new TextEncoder();
const PAYMENT_RANK: Record<PaymentState, number> = { CREATED: 0, AUTHORIZED: 1, CAPTURED: 2, SETTLED: 3, FAILED: 90, CANCELLED: 91 };

function hex(bytes: ArrayBuffer | Uint8Array) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(left: string, right: string) {
  const a = String(left || "").trim().toLowerCase(), b = String(right || "").trim().toLowerCase();
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
}

export function rupeesToPaiseExact(value: string | number) {
  const source = String(value).trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(source);
  if (!match) throw new Error("Money must be a positive decimal with at most two fractional digits");
  const rupees = BigInt(match[1]);
  const fraction = BigInt((match[2] || "").padEnd(2, "0"));
  const paise = rupees * BigInt(100) + fraction;
  if (paise <= BigInt(0) || paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Money is outside the supported paise range");
  return Number(paise);
}

export function paiseToRupeesDisplay(amountPaise: number) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) throw new Error("Invalid paise amount");
  const major = Math.trunc(amountPaise / 100), minor = amountPaise % 100;
  return `${major}.${String(minor).padStart(2, "0")}`;
}

export async function claimPaymentIntent(db: Db, input: {
  bookingId: string;
  customerId: string;
  paymentId: string;
  idempotencyKey: string;
  amountPaise: number;
  currency: string;
  grossServiceValuePaise?: number;
  platformFeePaise?: number;
  partnerEarningPaise?: number;
  tdsPaise?: number;
  gstPaise?: number;
  commissionRateBps?: number;
  commissionRateVersion?: string;
  taxRuleVersion?: string;
  commercialSnapshot?: Record<string, unknown>;
  environment: "sandbox" | "live";
}) {
  const bookingId = input.bookingId.trim(), customerId = input.customerId.trim(), paymentId = input.paymentId.trim(), idempotencyKey = input.idempotencyKey.trim();
  if (!bookingId || !customerId || !paymentId || !idempotencyKey) throw new Error("Payment intent identity is incomplete");
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new Error("Payment intent amount must be positive integer paise");
  const now = Date.now(), intentId = `PI-${crypto.randomUUID()}`, outboxId = `FO-${crypto.randomUUID()}`;
  const gross = input.grossServiceValuePaise ?? input.amountPaise;
  const platform = input.platformFeePaise ?? 0;
  const partner = input.partnerEarningPaise ?? Math.max(0, gross - platform);
  const tds = input.tdsPaise ?? 0, gst = input.gstPaise ?? 0, commissionBps = input.commissionRateBps ?? 0;
  for (const [label, amount] of Object.entries({ gross, platform, partner, tds, gst, commissionBps })) if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`${label} must be a non-negative integer`);
  const snapshot = JSON.stringify(input.commercialSnapshot || {});
  const payload = JSON.stringify({ intentId, bookingId, paymentId, amountPaise: input.amountPaise, currency: input.currency });
  await db.batch([
    db.prepare(`INSERT INTO payment_intents
      (id,booking_id,customer_id,payment_id,provider,environment,idempotency_key,amount_paise,currency,state,order_request_state,gross_service_value_paise,platform_fee_paise,partner_earning_paise,tds_paise,gst_paise,commission_rate_bps,commission_rate_version,tax_rule_version,commercial_snapshot_json,created_at,updated_at)
      VALUES (?,?,?,?, 'razorpay',?,?,?,?, 'CREATED','PAYMENT_ORDER_REQUESTED',?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(customer_id,booking_id,idempotency_key) DO NOTHING`)
      .bind(intentId, bookingId, customerId, paymentId, input.environment, idempotencyKey, input.amountPaise, input.currency, gross, platform, partner, tds, gst, commissionBps, input.commissionRateVersion || "unspecified", input.taxRuleVersion || "unspecified", snapshot, now, now),
    db.prepare(`INSERT INTO financial_outbox
      (id,aggregate_type,aggregate_id,event_type,dedupe_key,payload_json,status,attempts,next_attempt_at,created_at,updated_at)
      SELECT ?,'payment_intent',?,'CREATE_RAZORPAY_ORDER',?,?, 'PENDING',0,?,?,?
      WHERE EXISTS (SELECT 1 FROM payment_intents WHERE id=?)`)
      .bind(outboxId, intentId, `razorpay-order:${intentId}`, payload, now, now, now, intentId),
  ]);
  const winner = await db.prepare("SELECT * FROM payment_intents WHERE customer_id=? AND booking_id=? AND idempotency_key=?").bind(customerId, bookingId, idempotencyKey).first<Row>();
  if (!winner) throw new Error("Payment intent could not be claimed");
  return winner;
}

export async function claimOutboxWork(db: Db, input: { outboxId: string; workerId: string; leaseMs?: number }) {
  const now = Date.now(), leaseUntil = now + Math.max(5_000, Math.min(input.leaseMs || 30_000, 120_000));
  const result = await db.prepare(`UPDATE financial_outbox SET status='PROCESSING',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=?
    WHERE id=? AND event_type='CREATE_RAZORPAY_ORDER' AND (
      (status IN ('PENDING','RETRY') AND next_attempt_at<=?) OR
      (status='PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at<?)
    )`).bind(input.workerId, leaseUntil, now, input.outboxId, now, now).run();
  if (Number(result.meta?.changes || 0) !== 1) return null;
  return db.prepare("SELECT * FROM financial_outbox WHERE id=? AND lease_owner=?").bind(input.outboxId, input.workerId).first<Row>();
}

export async function executeRazorpayOrderOutbox(db: Db, env: Record<string, unknown>, input: { outboxId: string; workerId: string }) {
  const work = await claimOutboxWork(db, input);
  if (!work) return { claimed: false as const };
  const intent = await db.prepare("SELECT * FROM payment_intents WHERE id=?").bind(String(work.aggregate_id)).first<Row>();
  if (!intent) throw new Error("Outbox payment intent is missing");
  if (String(intent.gateway_order_id || "")) {
    await db.prepare("UPDATE financial_outbox SET status='SUCCEEDED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?").bind(Date.now(), input.outboxId, input.workerId).run();
    return { claimed: true as const, connected: true as const, orderId: String(intent.gateway_order_id), replay: true };
  }
  const request = { bookingId: String(intent.booking_id), paymentId: String(intent.payment_id), amountPaise: Number(intent.amount_paise), currency: String(intent.currency) };
  await db.prepare("UPDATE financial_outbox SET request_json=?,updated_at=? WHERE id=? AND lease_owner=?").bind(JSON.stringify(request), Date.now(), input.outboxId, input.workerId).run();
  const created = await createPaymentOrderPaise(env, request);
  const now = Date.now();
  if (!created.connected) {
    const ambiguous = /timed out|request failed|network|fetch/i.test(created.reason);
    await db.batch([
      db.prepare("UPDATE financial_outbox SET status=?,response_json=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?")
        .bind(ambiguous ? "RECONCILIATION_REQUIRED" : "RETRY", JSON.stringify(created), created.reason, now, input.outboxId, input.workerId),
      db.prepare("UPDATE payment_intents SET order_request_state=?,version=version+1,updated_at=? WHERE id=? AND gateway_order_id IS NULL")
        .bind(ambiguous ? "RECONCILIATION_REQUIRED" : "FAILED", now, String(intent.id)),
    ]);
    return { claimed: true as const, connected: false as const, reason: created.reason, reconciliationRequired: ambiguous };
  }
  const orderId = String(created.order.id || "");
  if (!orderId) throw new Error("Razorpay order response has no id");
  await db.batch([
    db.prepare(`UPDATE payment_intents SET gateway_order_id=?,order_request_state='ORDER_CREATED',version=version+1,updated_at=?
      WHERE id=? AND gateway_order_id IS NULL AND order_request_state IN ('PAYMENT_ORDER_REQUESTED','PROCESSING','FAILED')`).bind(orderId, now, String(intent.id)),
    db.prepare("INSERT INTO gateway_object_identities (provider,object_type,external_id,owner_type,owner_id,created_at) VALUES ('razorpay','order',?,'payment_intent',?,?) ON CONFLICT DO NOTHING").bind(orderId, String(intent.id), now),
    db.prepare("UPDATE financial_outbox SET status='SUCCEEDED',response_json=?,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?")
      .bind(JSON.stringify(created.order), now, input.outboxId, input.workerId),
  ]);
  const persisted = await db.prepare("SELECT gateway_order_id FROM payment_intents WHERE id=?").bind(String(intent.id)).first<Row>();
  if (String(persisted?.gateway_order_id || "") !== orderId) throw new Error("Gateway order identity conflict detected");
  return { claimed: true as const, connected: true as const, orderId, replay: false };
}

export async function verifyRazorpayRawBody(rawBody: string, signature: string, secret: string) {
  if (!rawBody || !signature || !secret) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  return constantTimeHexEqual(expected, signature);
}

export async function sha256Hex(rawBody: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(rawBody)));
}

export async function acceptRazorpayWebhook(db: Db, input: {
  rawBody: string;
  signature: string;
  webhookSecret: string;
  eventId: string;
  environment: "sandbox" | "live";
}) {
  if (!(await verifyRazorpayRawBody(input.rawBody, input.signature, input.webhookSecret))) throw new Error("Invalid Razorpay webhook signature");
  const eventId = input.eventId.trim();
  if (!eventId) throw new Error("Razorpay webhook event id is required");
  const payloadHash = await sha256Hex(input.rawBody), id = `GWE-${crypto.randomUUID()}`, now = Date.now();
  const result = await db.prepare(`INSERT INTO gateway_webhook_events
    (id,provider,environment,event_id,raw_payload,payload_sha256,signature,processing_status,received_at)
    VALUES (?,'razorpay',?,?,?,?,?,'RECEIVED',?) ON CONFLICT(provider,event_id) DO NOTHING`)
    .bind(id, input.environment, eventId, input.rawBody, payloadHash, input.signature, now).run();
  const inserted = Number(result.meta?.changes || 0) === 1;
  const row = await db.prepare("SELECT * FROM gateway_webhook_events WHERE provider='razorpay' AND event_id=?").bind(eventId).first<Row>();
  if (!row) throw new Error("Webhook inbox persistence failed");
  if (String(row.payload_sha256) !== payloadHash) throw new Error("Razorpay event id was replayed with a different payload");
  if (!inserted) return { duplicate: true as const, row };
  let event: Record<string, unknown>;
  try { event = JSON.parse(input.rawBody) as Record<string, unknown>; } catch {
    await db.prepare("UPDATE gateway_webhook_events SET processing_status='REJECTED',failure_reason=?,processed_at=? WHERE id=?").bind("invalid_json", Date.now(), String(row.id)).run();
    throw new Error("Signed Razorpay webhook body is not valid JSON");
  }
  return { duplicate: false as const, row, event };
}

export async function advancePaymentState(db: Db, input: { intentId: string; target: PaymentState; gatewayPaymentId?: string; gatewaySettlementId?: string }) {
  const current = await db.prepare("SELECT state,version FROM payment_intents WHERE id=?").bind(input.intentId).first<Row>();
  if (!current) throw new Error("Payment intent was not found");
  const from = String(current.state) as PaymentState;
  if (!(from in PAYMENT_RANK) || !(input.target in PAYMENT_RANK)) throw new Error("Unknown payment state");
  if (PAYMENT_RANK[input.target] < PAYMENT_RANK[from]) return { changed: false, state: from, regressive: true };
  if (input.target === from) return { changed: false, state: from, regressive: false };
  if (PAYMENT_RANK[input.target] >= 90 || PAYMENT_RANK[from] >= 90) throw new Error(`Payment transition ${from} -> ${input.target} is not allowed`);
  if (PAYMENT_RANK[input.target] !== PAYMENT_RANK[from] + 1) return { changed: false, state: from, deferred: true };
  const now = Date.now(), version = Number(current.version || 0);
  const result = await db.prepare(`UPDATE payment_intents SET state=?,gateway_payment_id=COALESCE(?,gateway_payment_id),gateway_settlement_id=COALESCE(?,gateway_settlement_id),version=version+1,updated_at=?
    WHERE id=? AND state=? AND version=?`).bind(input.target, input.gatewayPaymentId || null, input.gatewaySettlementId || null, now, input.intentId, from, version).run();
  return { changed: Number(result.meta?.changes || 0) === 1, state: input.target, regressive: false };
}

export async function postBalancedJournal(db: Db, input: {
  sourceType: string;
  sourceId: string;
  sourceEventId: string;
  narration: string;
  currency?: string;
  entries: Array<{ accountCode: string; direction: "DEBIT" | "CREDIT"; amountPaise: number; bookingId?: string; partnerId?: string }>;
}) {
  if (input.entries.length < 2) throw new Error("A journal requires at least two entries");
  let debits = BigInt(0), credits = BigInt(0);
  for (const entry of input.entries) {
    if (!Number.isSafeInteger(entry.amountPaise) || entry.amountPaise <= 0) throw new Error("Journal amounts must be positive integer paise");
    if (entry.direction === "DEBIT") debits += BigInt(entry.amountPaise); else credits += BigInt(entry.amountPaise);
  }
  if (debits !== credits) throw new Error("Journal debit and credit totals must balance");
  const existing = await db.prepare("SELECT id,status FROM journal_transactions WHERE source_event_id=?").bind(input.sourceEventId).first<Row>();
  if (existing) return { transactionId: String(existing.id), duplicate: true };
  const transactionId = `JT-${crypto.randomUUID()}`, now = Date.now();
  const statements = [
    db.prepare("INSERT INTO journal_transactions (id,source_type,source_id,source_event_id,currency,status,narration,created_at) VALUES (?,?,?,?,?,'DRAFT',?,?) ON CONFLICT(source_event_id) DO NOTHING")
      .bind(transactionId, input.sourceType, input.sourceId, input.sourceEventId, input.currency || "INR", input.narration, now),
    ...input.entries.map((entry) => db.prepare(`INSERT INTO journal_entries (id,transaction_id,account_code,direction,amount_paise,booking_id,partner_id,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM journal_transactions WHERE id=?)`)
      .bind(`JE-${crypto.randomUUID()}`, transactionId, entry.accountCode, entry.direction, entry.amountPaise, entry.bookingId || null, entry.partnerId || null, now, transactionId)),
    db.prepare("UPDATE journal_transactions SET status='POSTED',posted_at=? WHERE id=? AND status='DRAFT'").bind(now, transactionId),
  ];
  await db.batch(statements);
  const posted = await db.prepare("SELECT status FROM journal_transactions WHERE id=?").bind(transactionId).first<Row>();
  if (String(posted?.status || "") !== "POSTED") {
    const winner = await db.prepare("SELECT id,status FROM journal_transactions WHERE source_event_id=?").bind(input.sourceEventId).first<Row>();
    if (winner) return { transactionId: String(winner.id), duplicate: true };
    throw new Error("Journal posting failed");
  }
  return { transactionId, duplicate: false };
}

export async function releasePartnerEarning(db: Db, input: { bookingId: string; releaseType: string }) {
  const now = Date.now(), id = `PPR-${crypto.randomUUID()}`;
  const earning = await db.prepare(`SELECT e.*,b.status booking_status FROM partner_earning_pending e
    JOIN canonical_bookings b ON b.id=e.booking_id WHERE e.booking_id=?`).bind(input.bookingId).first<Row>();
  if (!earning) throw new Error("Pending partner earning was not found");
  if (String(earning.booking_status).toLowerCase() !== "completed") throw new Error("Partner earning cannot be released before booking completion");
  const results = await db.batch([
    db.prepare(`INSERT INTO partner_payable_released
      (id,booking_id,partner_id,pending_earning_id,release_type,amount_paise,currency,transfer_status,released_at,updated_at)
      SELECT ?,e.booking_id,e.partner_id,e.id,?,e.earning_paise,e.currency,'ELIGIBLE',?,?
      FROM partner_earning_pending e JOIN canonical_bookings b ON b.id=e.booking_id
      WHERE e.id=? AND e.status='PENDING' AND lower(b.status)='completed'
      ON CONFLICT(booking_id,release_type) DO NOTHING`)
      .bind(id, input.releaseType, now, now, String(earning.id)),
    db.prepare(`UPDATE partner_earning_pending SET status='RELEASED',updated_at=?
      WHERE id=? AND status='PENDING' AND EXISTS (
        SELECT 1 FROM partner_payable_released r WHERE r.pending_earning_id=? AND r.booking_id=? AND r.release_type=?
      )`).bind(now, String(earning.id), String(earning.id), input.bookingId, input.releaseType),
  ]);
  const inserted = Number(results[0]?.meta?.changes || 0) === 1;
  const released = await db.prepare("SELECT * FROM partner_payable_released WHERE booking_id=? AND release_type=?").bind(input.bookingId, input.releaseType).first<Row>();
  if (!released) throw new Error("Partner earning release failed");
  const source = await db.prepare("SELECT status FROM partner_earning_pending WHERE id=?").bind(String(earning.id)).first<Row>();
  if (String(source?.status || "") !== "RELEASED") throw new Error("Partner earning release was not atomic");
  return { released, duplicate: !inserted };
}

export function activePaymentEnvironment(env: Record<string, unknown>) {
  return paymentEnvironment(env);
}
