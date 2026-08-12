/**
 * Haptik voice/chat integration layer - the APIs Haptik's Voice AI agents call (per the engagement:
 * Capture Details, Capture Callback, Fetch Time Slots, Book Appointment). Design principle: the voice
 * bot CAPTURES and REQUESTS; humans/governed flows still own confirmation, provider assignment and
 * payment. So a Haptik "booking" is a governed booking REQUEST, never an auto-paid canonical booking.
 *
 * Every write is idempotent (Haptik retries on the same call/session id), leads land in the real CRM
 * (crm_contacts + lead_work_items) so they flow into assignment/SLA, and callbacks land in the real
 * lead_callbacks ledger. The whole layer is fail-closed at the route: it does nothing until
 * HAPTIK_API_KEY is configured, and it never moves money.
 */

import { loadGovernedProviders } from "./provider-capacity-governance";
import { scheduleLeadCallback } from "./lead-callback-governance";

type Db = D1Database;
type Row = Record<string, unknown>;
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const digits = (s: string) => String(s || "").replace(/[^0-9]/g, "");
const text = (v: unknown) => String(v ?? "").trim();

export async function ensureHaptikTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lead_callbacks (id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,requested_at INTEGER NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',completed_at INTEGER,completed_outcome TEXT,missed_at INTEGER,scheduled_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS haptik_lead_captures (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL,contact_id TEXT NOT NULL,phone TEXT NOT NULL,name TEXT,service TEXT,city TEXT,source TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS haptik_callback_requests (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,callback_id TEXT NOT NULL,lead_id TEXT NOT NULL,phone TEXT NOT NULL,preferred_at INTEGER,reason TEXT,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS haptik_booking_requests (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL,contact_id TEXT NOT NULL,phone TEXT NOT NULL,service TEXT NOT NULL,city TEXT,zone TEXT,preferred_slot TEXT,pet_name TEXT,status TEXT NOT NULL DEFAULT 'booking_requested',detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  ]);
}

/** Find-or-create a real CRM lead (contact + governed work item) keyed by phone. */
async function ensureLead(db: Db, input: { phone: string; name?: string; service?: string; city?: string; source?: string; actorId: string }) {
  const phone = digits(input.phone);
  if (phone.length < 8) throw new Error("A valid phone number is required");
  // Match an existing CRM contact by phone FIRST. Keying purely on the bot-specific
  // `HAPTIK-<phone>` id forked a second contact for a customer the CRM already knew (from the
  // website form, an app signup or a rep), so the bot's leads never joined that customer's history.
  const existingContact = await db.prepare("SELECT id FROM crm_contacts WHERE replace(replace(replace(primary_phone,' ',''),'-',''),'+','') LIKE ? ORDER BY updated_at DESC LIMIT 1").bind(`%${phone.slice(-10)}`).first<Row>();
  const contactId = existingContact ? text(existingContact.id) : `HAPTIK-${phone}`, now = Date.now(), service = text(input.service) || "grooming", source = text(input.source) || "haptik_voice";
  await db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,area,stage,owner,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=COALESCE(NULLIF(excluded.name,''),crm_contacts.name),area=COALESCE(NULLIF(excluded.area,''),crm_contacts.area),updated_at=excluded.updated_at")
    .bind(contactId, text(input.name) || `Lead ${phone.slice(-4)}`, input.phone, text(input.city) || null, "New lead", "Unassigned", source, now, now).run();
  const existingLead = await db.prepare("SELECT id FROM lead_work_items WHERE customer_id=? AND status IN ('active','sla_breached','qualified') ORDER BY created_at DESC LIMIT 1").bind(contactId).first<Row>();
  if (existingLead) return { contactId, leadId: String(existingLead.id) };
  const leadId = uid("LWI");
  await db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,?,?)")
    .bind(leadId, contactId, source, service, "Unassigned", "Unassigned", now, now + 30 * 60_000, now + 60 * 60_000, now, now).run();
  return { contactId, leadId };
}

/** Haptik "Capture Details" - store a captured/qualified lead into the CRM. Idempotent. */
export async function captureHaptikLead(db: Db, input: { idempotencyKey: string; phone: string; name?: string; service?: string; city?: string; source?: string; qualification?: Record<string, unknown>; actorId: string }) {
  await ensureHaptikTables(db);
  if (!text(input.idempotencyKey)) throw new Error("An idempotency key is required");
  const prior = await db.prepare("SELECT id,lead_id,contact_id FROM haptik_lead_captures WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
  if (prior) return { duplicatePrevented: true, leadId: String(prior.lead_id), contactId: String(prior.contact_id) };
  const { contactId, leadId } = await ensureLead(db, input);
  await db.prepare("INSERT INTO haptik_lead_captures (id,idempotency_key,lead_id,contact_id,phone,name,service,city,source,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(uid("HLC"), input.idempotencyKey, leadId, contactId, input.phone, text(input.name) || null, text(input.service) || null, text(input.city) || null, text(input.source) || "haptik_voice", JSON.stringify(input.qualification || {}), Date.now()).run();
  return { duplicatePrevented: false, leadId, contactId };
}

/** Haptik "Capture Callback Request" - schedule a real, governed callback. Idempotent. */
export async function captureHaptikCallback(db: Db, input: { idempotencyKey: string; phone: string; name?: string; leadId?: string; preferredAt?: number; reason?: string; actorId: string }) {
  await ensureHaptikTables(db);
  if (!text(input.idempotencyKey)) throw new Error("An idempotency key is required");
  const prior = await db.prepare("SELECT id,callback_id,lead_id FROM haptik_callback_requests WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
  if (prior) return { duplicatePrevented: true, callbackId: String(prior.callback_id), leadId: String(prior.lead_id) };
  const leadId = text(input.leadId) || (await ensureLead(db, { phone: input.phone, name: input.name, source: "haptik_voice", actorId: input.actorId })).leadId;
  const now = Date.now(), reason = text(input.reason) || "Customer requested a callback (Haptik voice)";
  // Go through the governed callback ledger rather than writing lead_callbacks directly: that path
  // supersedes any still-open promise to the same customer, keeps lead_work_items.next_action_at in
  // agreement with the callback queue, emits the audit event, and refuses a placeholder past time.
  // A bot asking for "now" (no preferred time) is normalised to the soonest real slot, 15 minutes out.
  const preferred = Number(input.preferredAt);
  const requestedAt = Number.isFinite(preferred) && preferred > now ? preferred : now + 15 * 60_000;
  const scheduled = await scheduleLeadCallback(db, { leadId, requestedAt, reason, actorId: input.actorId, idempotencyKey: `haptik-callback:${input.idempotencyKey}` });
  const callbackId = scheduled.id;
  await db.prepare("INSERT INTO haptik_callback_requests (id,idempotency_key,callback_id,lead_id,phone,preferred_at,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(uid("HCB"), input.idempotencyKey, callbackId, leadId, input.phone, requestedAt, reason, now).run();
  return { duplicatePrevented: false, callbackId, leadId, requestedAt };
}

/** Haptik "Fetch Time Slots" - offerable windows for a service/area. Availability reflects whether a
 * governed provider serves that area; the exact reservation is made later by the governed scheduler. */
export async function fetchHaptikTimeSlots(db: Db, input: { serviceCode: string; cityId: string; zoneId?: string; fromDate?: string; days?: number }) {
  const serviceCode = text(input.serviceCode), cityId = text(input.cityId) || "blr", zoneId = text(input.zoneId) || `${cityId}-east`;
  if (!serviceCode) throw new Error("A service is required");
  const days = Math.max(1, Math.min(Number(input.days) || 5, 14));
  let serviceable = true;
  try { serviceable = (await loadGovernedProviders(db, cityId, zoneId, serviceCode, new Date())).length > 0; } catch { serviceable = false; }
  const base = input.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(input.fromDate) ? Date.parse(input.fromDate + "T00:00:00Z") : Date.now();
  const windows = [{ label: "Morning", time: "10:00" }, { label: "Afternoon", time: "14:00" }, { label: "Evening", time: "18:00" }];
  const slots = [];
  for (let d = 1; d <= days; d++) {
    const date = new Date(base + d * 86_400_000).toISOString().slice(0, 10);
    for (const w of windows) slots.push({ date, window: w.label, time: w.time, available: serviceable, status: serviceable ? "offerable" : "on_request" });
  }
  return { serviceCode, cityId, zoneId, serviceable, slots };
}

/** Haptik "Book Appointment" - a GOVERNED booking request (not an auto-paid booking). Ops/scheduling
 * completes provider assignment and payment through the normal governed flow. Idempotent. */
export async function requestHaptikBooking(db: Db, input: { idempotencyKey: string; phone: string; name?: string; leadId?: string; serviceCode: string; cityId?: string; zoneId?: string; preferredSlot?: string; petName?: string; notes?: string; actorId: string }) {
  await ensureHaptikTables(db);
  if (!text(input.idempotencyKey)) throw new Error("An idempotency key is required");
  if (!text(input.serviceCode)) throw new Error("A service is required");
  const prior = await db.prepare("SELECT id,lead_id,status FROM haptik_booking_requests WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
  if (prior) return { duplicatePrevented: true, requestId: String(prior.id), leadId: String(prior.lead_id), status: String(prior.status) };
  // When the bot passes a leadId, read that lead's REAL contact instead of assuming the bot-specific
  // id convention - otherwise a booking request could be filed against a contact id that does not
  // exist, or worse, a different customer's.
  let contactId: string, leadId: string;
  if (text(input.leadId)) {
    const lead = await db.prepare("SELECT id,customer_id FROM lead_work_items WHERE id=?").bind(text(input.leadId)).first<Row>();
    if (!lead) throw new Error("Lead not found for this booking request");
    leadId = text(lead.id); contactId = text(lead.customer_id);
  } else {
    ({ contactId, leadId } = await ensureLead(db, { phone: input.phone, name: input.name, service: input.serviceCode, city: input.cityId, source: "haptik_voice", actorId: input.actorId }));
  }
  const now = Date.now(), requestId = uid("HBR");
  await db.prepare("INSERT INTO haptik_booking_requests (id,idempotency_key,lead_id,contact_id,phone,service,city,zone,preferred_slot,pet_name,status,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'booking_requested',?,?,?)")
    .bind(requestId, input.idempotencyKey, leadId, contactId, input.phone, text(input.serviceCode), text(input.cityId) || null, text(input.zoneId) || null, text(input.preferredSlot) || null, text(input.petName) || null, JSON.stringify({ notes: text(input.notes) || null, source: "haptik_voice" }), now, now).run();
  // move the lead forward so it enters the governed scheduling/ops queue
  await db.prepare("UPDATE lead_work_items SET status='qualified',last_outcome='haptik_booking_requested',next_action_at=?,updated_at=? WHERE id=? AND status IN ('active','sla_breached','qualified')").bind(now, now, leadId).run();
  return { duplicatePrevented: false, requestId, leadId, contactId, status: "booking_requested", note: "Governed request created; provider assignment and payment are completed by the scheduler/ops - no money moved." };
}

/** Ops view of Haptik booking requests awaiting governed conversion. */
export async function listHaptikBookingRequests(db: Db, input: { status?: string } = {}) {
  await ensureHaptikTables(db);
  const status = text(input.status) || "booking_requested";
  const rows = await db.prepare("SELECT id,lead_id,contact_id,phone,service,city,zone,preferred_slot,pet_name,status,created_at FROM haptik_booking_requests WHERE (?='all' OR status=?) ORDER BY created_at DESC LIMIT 200").bind(status, status).all<Row>();
  return rows.results.map((r: Row) => ({ requestId: String(r.id), leadId: String(r.lead_id), phone: String(r.phone), service: String(r.service), city: r.city ? String(r.city) : null, zone: r.zone ? String(r.zone) : null, preferredSlot: r.preferred_slot ? String(r.preferred_slot) : null, petName: r.pet_name ? String(r.pet_name) : null, status: String(r.status), createdAt: Number(r.created_at) }));
}
