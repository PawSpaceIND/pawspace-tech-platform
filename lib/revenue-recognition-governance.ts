/**
 * Revenue recognition on an accrual (matching) basis, so the P&L reflects service actually delivered
 * rather than cash collected up front. Two schedules:
 *
 *   subscription   - a multi-session pack is billed once but recognised per session consumed. The
 *                    month's revenue is (sessions used that month) x (per-session value), NOT the
 *                    whole subscription amount. The unused remainder stays as Deferred Revenue.
 *   advance_booking - a booking paid in advance is recognised only when the service is utilised;
 *                     until then the cash sits in Advance from Customers, not revenue.
 *
 * Collection (cash in) and recognition (P&L) are deliberately separate journals:
 *   collect (subscription):  Dr Bank  Cr Deferred Revenue
 *   collect (advance):       Dr Bank  Cr Advance from Customers
 *   recognise:               Dr Deferred Revenue / Advance from Customers  Cr Service Revenue
 * The recognise journal is non-cash, so the cash-flow statement still shows the cash when it arrived.
 */

import { ACCT, postJournal, periodOf, round } from "./finance-accounts";

type Db = D1Database;
type Row = Record<string, unknown>;

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const SOURCE_TYPES = ["subscription", "advance_booking"];

export async function ensureRevenueRecognitionTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS revenue_recognition_schedules (id TEXT PRIMARY KEY,source_type TEXT NOT NULL,source_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,service_code TEXT,total_amount REAL NOT NULL,total_units INTEGER NOT NULL DEFAULT 1,recognized_amount REAL NOT NULL DEFAULT 0,recognized_units INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'open',collected INTEGER NOT NULL DEFAULT 0,collect_account TEXT NOT NULL,started_period TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS revenue_recognition_events (id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,units INTEGER NOT NULL,amount REAL NOT NULL,period_code TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)"),
  ]);
}

/**
 * Open a deferred-revenue schedule when a subscription or advance booking is billed/paid. The cash
 * is recorded as a liability (Deferred Revenue / Advance from Customers), not revenue. Idempotent per
 * source. subscriptions carry totalUnits = number of sessions; advance bookings default to 1 unit.
 */
export async function recordDeferredRevenue(db: Db, input: { sourceType: string; sourceId: string; customerId: string; serviceCode?: string; totalAmount: number; totalUnits?: number; collectedToBank?: boolean; at?: string; actorId: string }) {
  await ensureRevenueRecognitionTables(db);
  const sourceType = String(input.sourceType || "").toLowerCase();
  if (!SOURCE_TYPES.includes(sourceType)) throw new Error("Source type must be subscription or advance_booking");
  const sourceId = String(input.sourceId || "").trim();
  const customerId = String(input.customerId || "").trim();
  if (!sourceId || !customerId) throw new Error("A source and customer are required");
  const totalAmount = round(Number(input.totalAmount));
  if (!(totalAmount > 0)) throw new Error("Total amount must be positive");
  const totalUnits = sourceType === "subscription" ? Math.max(1, Math.floor(Number(input.totalUnits) || 1)) : 1;
  const existing = await db.prepare("SELECT * FROM revenue_recognition_schedules WHERE source_id=?").bind(sourceId).first<Row>();
  if (existing) return { alreadyRecorded: true, scheduleId: String(existing.id), totalAmount: Number(existing.total_amount), totalUnits: Number(existing.total_units) };
  const liabilityAccount = sourceType === "subscription" ? ACCT.DEFERRED_REVENUE : ACCT.ADVANCE_FROM_CUSTOMERS;
  const at = input.at || new Date().toISOString().slice(0, 10), period = periodOf(at);
  const id = uid("REVSCH"), now = Date.now();
  await db.prepare("INSERT INTO revenue_recognition_schedules (id,source_type,source_id,customer_id,service_code,total_amount,total_units,recognized_amount,recognized_units,status,collected,collect_account,started_period,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,0,'open',?,?,?,?,?)")
    .bind(id, sourceType, sourceId, customerId, input.serviceCode || null, totalAmount, totalUnits, input.collectedToBank ? 1 : 0, liabilityAccount, period, now, now).run();
  if (input.collectedToBank) {
    await postJournal(db, { groupKey: `revrec-collect-${sourceId}`, entryDate: at, periodCode: period, sourceType: `${sourceType}_collection`, sourceId: id, narration: `${sourceType === "subscription" ? "Subscription" : "Advance booking"} collected for ${customerId}`, lines: [
      { accountCode: ACCT.BANK, debit: totalAmount, vertical: input.serviceCode || null },
      { accountCode: liabilityAccount, credit: totalAmount, vertical: input.serviceCode || null },
    ] });
  }
  return { alreadyRecorded: false, scheduleId: id, sourceType, totalAmount, totalUnits, liabilityAccount, perUnitValue: round(totalAmount / totalUnits) };
}

async function loadSchedule(db: Db, sourceId: string): Promise<Row> {
  const row = await db.prepare("SELECT * FROM revenue_recognition_schedules WHERE source_id=?").bind(sourceId).first<Row>();
  if (!row) throw new Error("No revenue schedule for this source - record it first");
  return row;
}

async function recognize(db: Db, schedule: Row, units: number, amount: number, at: string, sequenceKey: string) {
  const period = periodOf(at);
  const idempotencyKey = `${String(schedule.source_id)}:${sequenceKey}`;
  const prior = await db.prepare("SELECT * FROM revenue_recognition_events WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) return { alreadyRecognized: true, eventId: String(prior.id), amount: Number(prior.amount), units: Number(prior.units), period: String(prior.period_code) };
  const recognizedUnits = Number(schedule.recognized_units) + units;
  const recognizedAmount = round(Number(schedule.recognized_amount) + amount);
  const status = recognizedUnits >= Number(schedule.total_units) || recognizedAmount >= Number(schedule.total_amount) - 0.01 ? "fully_recognized" : "open";
  const id = uid("REVEVT"), now = Date.now();
  await db.prepare("INSERT INTO revenue_recognition_events (id,schedule_id,units,amount,period_code,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)").bind(id, String(schedule.id), units, amount, period, idempotencyKey, now).run();
  await db.prepare("UPDATE revenue_recognition_schedules SET recognized_units=?,recognized_amount=?,status=?,updated_at=? WHERE id=?").bind(recognizedUnits, recognizedAmount, status, now, String(schedule.id)).run();
  const vertical = schedule.service_code ? String(schedule.service_code) : null;
  await postJournal(db, { groupKey: `revrec-recognize-${idempotencyKey}`, entryDate: at, periodCode: period, sourceType: "revenue_recognition", sourceId: id, narration: `Recognise ${units} unit(s) revenue for ${String(schedule.source_type)} ${String(schedule.source_id)}`, lines: [
    { accountCode: String(schedule.collect_account), debit: amount, vertical },
    { accountCode: ACCT.REVENUE, credit: amount, vertical },
  ] });
  return { alreadyRecognized: false, eventId: id, amount, units, period, recognizedAmount, recognizedUnits, status };
}

/**
 * Recognise subscription revenue for the sessions consumed since last time. Pass the cumulative
 * sessionsConsumed; only the delta above what's already recognised is booked, at per-session value.
 * The last session sweeps up any rounding remainder so the whole amount recognises exactly.
 */
export async function recognizeSubscriptionUsage(db: Db, input: { sourceId: string; sessionsConsumed: number; at?: string; actorId: string }) {
  await ensureRevenueRecognitionTables(db);
  const schedule = await loadSchedule(db, String(input.sourceId));
  if (String(schedule.source_type) !== "subscription") throw new Error("This schedule is not a subscription");
  const totalUnits = Number(schedule.total_units), totalAmount = Number(schedule.total_amount);
  const already = Number(schedule.recognized_units);
  const target = Math.min(Math.max(0, Math.floor(Number(input.sessionsConsumed))), totalUnits);
  const delta = target - already;
  if (delta <= 0) return { recognized: false, reason: "no_new_sessions", recognizedUnits: already };
  const at = input.at || new Date().toISOString().slice(0, 10);
  const perUnit = round(totalAmount / totalUnits);
  // if this brings us to the final session, book the exact remainder to avoid rounding drift
  const amount = target >= totalUnits ? round(totalAmount - Number(schedule.recognized_amount)) : round(perUnit * delta);
  return recognize(db, schedule, delta, amount, at, `sessions:${target}`);
}

/** Recognise an advance booking in full when the service is actually utilised. Idempotent. */
export async function recognizeAdvanceBooking(db: Db, input: { sourceId: string; at?: string; actorId: string }) {
  await ensureRevenueRecognitionTables(db);
  const schedule = await loadSchedule(db, String(input.sourceId));
  if (String(schedule.source_type) !== "advance_booking") throw new Error("This schedule is not an advance booking");
  if (String(schedule.status) === "fully_recognized") return { recognized: false, reason: "already_recognized" };
  const at = input.at || new Date().toISOString().slice(0, 10);
  const amount = round(Number(schedule.total_amount) - Number(schedule.recognized_amount));
  return recognize(db, schedule, 1, amount, at, "utilised");
}

/** Outstanding deferred-revenue / advance liability across all open schedules. */
export async function deferredRevenueBalance(db: Db) {
  await ensureRevenueRecognitionTables(db);
  const rows = await db.prepare("SELECT source_type,total_amount,recognized_amount,status FROM revenue_recognition_schedules").all<Row>();
  let deferredSubscription = 0, advanceBookings = 0;
  for (const r of rows.results) {
    const outstanding = round(Number(r.total_amount) - Number(r.recognized_amount));
    if (outstanding <= 0) continue;
    if (String(r.source_type) === "subscription") deferredSubscription += outstanding; else advanceBookings += outstanding;
  }
  return { deferredSubscription: round(deferredSubscription), advanceBookings: round(advanceBookings), total: round(deferredSubscription + advanceBookings) };
}

/** Revenue actually recognised in a period (YYYY-MM) - the accrual-basis figure for the month. */
export async function recognizedRevenueForPeriod(db: Db, periodCode: string) {
  await ensureRevenueRecognitionTables(db);
  const row = await db.prepare("SELECT COALESCE(SUM(amount),0) total,COUNT(*) events FROM revenue_recognition_events WHERE period_code=?").bind(periodCode).first<Row>();
  const byType = await db.prepare("SELECT s.source_type type,COALESCE(SUM(e.amount),0) total FROM revenue_recognition_events e JOIN revenue_recognition_schedules s ON s.id=e.schedule_id WHERE e.period_code=? GROUP BY s.source_type").bind(periodCode).all<Row>();
  return { periodCode, recognizedRevenue: round(Number(row?.total || 0)), events: Number(row?.events || 0), byType: byType.results.map((r: Row) => ({ sourceType: String(r.type), amount: round(Number(r.total)) })) };
}

export async function getRevenueSchedule(db: Db, sourceId: string) {
  await ensureRevenueRecognitionTables(db);
  const s = await db.prepare("SELECT * FROM revenue_recognition_schedules WHERE source_id=?").bind(sourceId).first<Row>();
  if (!s) return null;
  const events = await db.prepare("SELECT id,units,amount,period_code,created_at FROM revenue_recognition_events WHERE schedule_id=? ORDER BY created_at").bind(String(s.id)).all<Row>();
  return {
    id: String(s.id), sourceType: String(s.source_type), sourceId: String(s.source_id), customerId: String(s.customer_id), serviceCode: s.service_code ? String(s.service_code) : null,
    totalAmount: Number(s.total_amount), totalUnits: Number(s.total_units), recognizedAmount: Number(s.recognized_amount), recognizedUnits: Number(s.recognized_units),
    deferredAmount: round(Number(s.total_amount) - Number(s.recognized_amount)), status: String(s.status),
    events: events.results.map((e: Row) => ({ id: String(e.id), units: Number(e.units), amount: Number(e.amount), period: String(e.period_code) })),
  };
}
