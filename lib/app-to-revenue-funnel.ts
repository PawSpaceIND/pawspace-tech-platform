/**
 * The canonical App-to-Revenue funnel - the one state machine that connects the pieces PawSpace already
 * has (app install → identify → Sales CRM → payment → ₹300 recovery → paid lifecycle) so the whole
 * "download → booked / payment-pending / not-booked → convert" flow is closed and reportable end to end.
 *
 * It does NOT rebuild Sales CRM, coupons, reminders or cross-sell - those exist. It (1) ingests app
 * installs and binds them to canonical customers at OTP verify, (2) derives each identified customer's
 * funnel stage from PAYMENT TRUTH (booked-but-unpaid ≠ converted), (3) auto-feeds the right customers
 * into the existing Sales system: a "No booking" app user becomes an App-Inbound Sales lead, and a
 * booked-but-payment-not-done customer gets the customer-bound ₹300 recovery entitlement + a Sales call
 * task; and (4) reports the four management funnels. Idempotent + cold-DB safe.
 *
 * Stages: installed → identified → no_booking → payment_pending → converted.
 */

import { ensureLeadWorkItemsTable } from "./lead-conversion-attribution";
import { issueRecoveryEntitlement, cancelRecoveryEntitlements, runRecoveryExpirySweep } from "./payment-recovery-governance";

type Db = D1Database;
type Row = Record<string, unknown>;
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const text = (v: unknown) => String(v ?? "").trim();
const empty = () => ({ results: [] as Row[] });
const SALES_OWNERS = ["Neha", "Rahul", "Priya", "Sanjay"];
const DEFAULT_ABANDON_MINUTES = 60;

export async function ensureFunnelTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS app_installs (install_id TEXT PRIMARY KEY,source TEXT,campaign TEXT,os TEXT,app_version TEXT,first_open_at INTEGER NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS install_identity_links (install_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,identified_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_install_identity_customer ON install_identity_links(customer_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS funnel_producer_marks (kind TEXT NOT NULL,ref_id TEXT NOT NULL,lead_id TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(kind,ref_id))"),
  ]);
}

/** Anonymous app install / first-open. Idempotent on the install id. */
export async function recordAppInstall(db: Db, input: { installId: string; source?: string; campaign?: string; os?: string; appVersion?: string; at?: number }) {
  await ensureFunnelTables(db);
  const installId = text(input.installId);
  if (!installId) throw new Error("installId is required");
  const at = input.at ?? Date.now();
  await db.prepare("INSERT OR IGNORE INTO app_installs (install_id,source,campaign,os,app_version,first_open_at,created_at) VALUES (?,?,?,?,?,?,?)").bind(installId, text(input.source) || null, text(input.campaign) || null, text(input.os) || null, text(input.appVersion) || null, at, at).run();
  return { installId, recorded: true };
}

/** Bind an install to a canonical customer at OTP verify / identification. Idempotent. */
export async function identifyInstall(db: Db, input: { installId: string; customerId: string; at?: number }) {
  await ensureFunnelTables(db);
  const installId = text(input.installId), customerId = text(input.customerId);
  if (!installId || !customerId) throw new Error("installId and customerId are required");
  const at = input.at ?? Date.now();
  // record the install too (a first-open may not have been separately ingested)
  await db.prepare("INSERT OR IGNORE INTO app_installs (install_id,first_open_at,created_at) VALUES (?,?,?)").bind(installId, at, at).run();
  await db.prepare("INSERT INTO install_identity_links (install_id,customer_id,identified_at) VALUES (?,?,?) ON CONFLICT(install_id) DO UPDATE SET customer_id=excluded.customer_id").bind(installId, customerId, at).run();
  return { installId, customerId };
}

/** Create an App-Inbound Sales lead (10-minute first-call SLA), once per customer. */
async function ensureAppInboundLead(db: Db, customerId: string, at: number): Promise<string | null> {
  const claim = await db.prepare("INSERT OR IGNORE INTO funnel_producer_marks (kind,ref_id,created_at) VALUES ('app_inbound',?,?)").bind(customerId, at).run();
  if (Number(claim.meta?.changes || 0) === 0) return null;
  // if the customer already has an open lead, attribute the mark to it instead of duplicating
  const open = await db.prepare("SELECT id FROM lead_work_items WHERE customer_id=? AND status NOT IN ('closed','converted') ORDER BY assigned_at DESC LIMIT 1").bind(customerId).first<Row>().catch(() => null);
  if (open) { await db.prepare("UPDATE funnel_producer_marks SET lead_id=? WHERE kind='app_inbound' AND ref_id=?").bind(String(open.id), customerId).run(); return String(open.id); }
  const owner = SALES_OWNERS[Math.abs(hashRef(customerId)) % SALES_OWNERS.length], leadId = uid("LWI");
  await db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,last_outcome,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,?,?,?)")
    .bind(leadId, customerId, "App Inbound", "general", owner, "Sales Manager", at, at + 10 * 60_000, at + 30 * 60_000, "app_download_no_booking", at, at).run();
  await db.prepare("UPDATE funnel_producer_marks SET lead_id=? WHERE kind='app_inbound' AND ref_id=?").bind(leadId, customerId).run();
  return leadId;
}

/** Create a payment-recovery Sales call task for a booked-but-unpaid customer, once per booking. */
async function ensureRecoveryTask(db: Db, input: { customerId: string; bookingId: string; service: string; at: number }): Promise<string | null> {
  const claim = await db.prepare("INSERT OR IGNORE INTO funnel_producer_marks (kind,ref_id,created_at) VALUES ('recovery_task',?,?)").bind(input.bookingId, input.at).run();
  if (Number(claim.meta?.changes || 0) === 0) return null;
  const owner = SALES_OWNERS[Math.abs(hashRef(input.customerId)) % SALES_OWNERS.length], leadId = uid("LWI");
  await db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,last_outcome,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,?,?,?)")
    .bind(leadId, input.customerId, "Payment Recovery", text(input.service) || "general", owner, "Sales Manager", input.at, input.at + 10 * 60_000, input.at + 30 * 60_000, "payment_abandoned_high_intent", input.at, input.at).run();
  await db.prepare("UPDATE funnel_producer_marks SET lead_id=? WHERE kind='recovery_task' AND ref_id=?").bind(leadId, input.bookingId).run();
  return leadId;
}

function hashRef(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

/**
 * The funnel sweep. Drives the automation off payment truth (cold-DB safe, idempotent):
 *  - expire stale ₹300 entitlements;
 *  - booked-but-payment-not-done past the abandonment window → issue ₹300 + a Sales recovery task;
 *  - identified app user with NO booking → App-Inbound Sales lead;
 *  - payment since captured → cancel any active ₹300 (belt-and-braces with the payment webhook hook).
 */
export async function runAppFunnelSweep(db: Db, input: { asOf?: number; abandonMinutes?: number } = {}) {
  await ensureFunnelTables(db).catch(() => {});
  await ensureLeadWorkItemsTable(db).catch(() => {});
  const at = input.asOf ?? Date.now(), abandonBefore = at - Math.max(1, Number(input.abandonMinutes) || DEFAULT_ABANDON_MINUTES) * 60_000;
  const expiry = await runRecoveryExpirySweep(db, { asOf: at });

  // payment-abandoned bookings (payment not captured, past the window, booking not cancelled)
  let recoveriesIssued = 0, recoveryTasks = 0;
  const pending = await db.prepare("SELECT bp.customer_id cust,bp.booking_id booking,b.service_code svc FROM booking_payments bp JOIN canonical_bookings b ON b.id=bp.booking_id WHERE bp.status IN ('created','failed','awaiting_payment') AND bp.created_at<=? AND b.status<>'cancelled' AND NOT EXISTS (SELECT 1 FROM booking_payments c WHERE c.booking_id=bp.booking_id AND c.status='captured') LIMIT 2000").bind(abandonBefore).all<Row>().catch(empty);
  for (const r of pending.results) {
    const issued = await issueRecoveryEntitlement(db, { customerId: String(r.cust), bookingId: String(r.booking), at }).catch(() => null);
    if (issued && !issued.duplicatePrevented) recoveriesIssued++;
    const task = await ensureRecoveryTask(db, { customerId: String(r.cust), bookingId: String(r.booking), service: String(r.svc || "general"), at }).catch(() => null);
    if (task) recoveryTasks++;
  }

  // identified app users with NO booking → App-Inbound Sales lead
  let appInboundLeads = 0;
  const noBooking = await db.prepare("SELECT DISTINCT l.customer_id cust FROM install_identity_links l WHERE NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.customer_id=l.customer_id AND b.status<>'cancelled') LIMIT 2000").bind().all<Row>().catch(empty);
  for (const r of noBooking.results) { const lead = await ensureAppInboundLead(db, String(r.cust), at).catch(() => null); if (lead) appInboundLeads++; }

  // customers who have since paid → cancel any lingering active ₹300
  let cancelled = 0;
  const paid = await db.prepare("SELECT DISTINCT e.customer_id cust FROM payment_recovery_entitlements e WHERE e.status='active' AND EXISTS (SELECT 1 FROM booking_payments bp JOIN canonical_bookings b ON b.id=bp.booking_id WHERE b.customer_id=e.customer_id AND bp.status='captured') LIMIT 2000").all<Row>().catch(empty);
  for (const r of paid.results) { const c = await cancelRecoveryEntitlements(db, { customerId: String(r.cust), reason: "payment_succeeded", at }).catch(() => ({ cancelled: 0 })); cancelled += c.cancelled; }

  return { sweep: "app_to_revenue_funnel", asOf: at, expiredEntitlements: expiry.expired, recoveriesIssued, recoveryTasks, appInboundLeads, cancelledOnPayment: cancelled };
}

/** The four management reports (App Acquisition Funnel + Payment Recovery + Inbound Sales + Paid Lifecycle). */
export async function acquisitionFunnelReport(db: Db) {
  await ensureFunnelTables(db);
  const dl = await db.prepare("SELECT COUNT(*) c FROM app_installs").first<Row>().catch(() => null);
  const id = await db.prepare("SELECT COUNT(*) c FROM install_identity_links").first<Row>().catch(() => null);
  const downloads = Number(dl?.c || 0), identified = Number(id?.c || 0);
  const agg = await db.prepare("SELECT SUM(CASE WHEN captured>0 THEN 1 ELSE 0 END) converted,SUM(CASE WHEN captured=0 AND booked>0 THEN 1 ELSE 0 END) payment_pending,SUM(CASE WHEN booked=0 THEN 1 ELSE 0 END) no_booking FROM (SELECT l.customer_id,(SELECT COUNT(*) FROM booking_payments bp JOIN canonical_bookings b ON b.id=bp.booking_id WHERE b.customer_id=l.customer_id AND bp.status='captured') captured,(SELECT COUNT(*) FROM canonical_bookings b WHERE b.customer_id=l.customer_id AND b.status<>'cancelled') booked FROM install_identity_links l)").first<Row>().catch(() => null);
  const converted = Number(agg?.converted || 0), paymentPending = Number(agg?.payment_pending || 0), noBooking = Number(agg?.no_booking || 0);
  return {
    appAcquisitionFunnel: { downloads, identified, anonymous: Math.max(0, downloads - identified), converted, paymentPending, noBooking, conversionRateFromIdentified: identified ? Math.round((converted / identified) * 1000) / 10 : 0, conversionRateFromDownloads: downloads ? Math.round((converted / downloads) * 1000) / 10 : 0 },
  };
}

/** Inbound-sales view of what the funnel fed to Sales (App-Inbound + Payment-Recovery leads). */
export async function inboundSalesFunnel(db: Db) {
  await ensureFunnelTables(db).catch(() => {});
  await ensureLeadWorkItemsTable(db).catch(() => {});
  const rows = await db.prepare("SELECT source,status,COUNT(*) c FROM lead_work_items WHERE source IN ('App Inbound','Payment Recovery') GROUP BY source,status").all<Row>().catch(empty);
  const bySource: Record<string, Record<string, number>> = {};
  for (const r of rows.results) { const s = String(r.source); (bySource[s] ||= {})[String(r.status)] = Number(r.c); }
  return { appInbound: bySource["App Inbound"] || {}, paymentRecovery: bySource["Payment Recovery"] || {} };
}
