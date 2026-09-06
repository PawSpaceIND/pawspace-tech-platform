import { ensureCommunicationTables } from "./communication-engine";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;

export const TRUST_SAFETY_REDACTION = "[REDACTED FOR SAFETY]";
export const BLOCKLIST_REASONS = ["mistreatment", "non_payment", "circumvention"] as const;
export type BlocklistReason = (typeof BLOCKLIST_REASONS)[number];
export type TrustActorType = "provider" | "customer" | "external" | "staff";

const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const DAY = 24 * 60 * 60_000;
const encoder = new TextEncoder();

async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function tableExists(db: Db, name: string) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());
}

async function columnNames(db: Db, table: string) {
  if (!await tableExists(db, table)) return new Set<string>();
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all<Row>();
  return new Set(rows.results.map(row => text(row.name)));
}

async function ensureProviderTrustColumns(db: Db) {
  if (!await tableExists(db, "provider_capacity_profiles")) return;
  const columns = await columnNames(db, "provider_capacity_profiles");
  if (!columns.has("trust_score")) await db.exec("ALTER TABLE provider_capacity_profiles ADD COLUMN trust_score INTEGER NOT NULL DEFAULT 100");
  if (!columns.has("trust_strike_count")) await db.exec("ALTER TABLE provider_capacity_profiles ADD COLUMN trust_strike_count INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("suspended_until")) await db.exec("ALTER TABLE provider_capacity_profiles ADD COLUMN suspended_until INTEGER");
}

export function normaliseTrustSafetyPhone(value: unknown): { e164: string; key: string } | null {
  const raw = text(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]/.test(digits)) return { e164: `+91${digits}`, key: digits };
  if (digits.length === 11 && digits.startsWith("0") && /^[6-9]/.test(digits.slice(1))) return { e164: `+91${digits.slice(1)}`, key: digits.slice(1) };
  if (digits.length === 12 && digits.startsWith("91") && /^[6-9]/.test(digits.slice(2))) return { e164: `+${digits}`, key: digits.slice(-10) };
  if (/^\+[1-9]\d{7,14}$/.test(raw.replace(/[\s().-]/g, ""))) {
    const e164 = raw.replace(/[\s().-]/g, "");
    return { e164, key: e164.replace(/\D/g, "").slice(-10) };
  }
  return null;
}

const INDIAN_PHONE = /(?<!\d)(?:\+?91[\s().-]*)?[6-9](?:[\s().-]*\d){9}(?!\d)/g;
const GENERIC_E164 = /(?<!\w)\+[1-9](?:[\s().-]*\d){7,14}(?!\d)/g;
const UPI_VPA = /\b[a-z0-9._-]{2,128}@(ybl|ibl|axl|upi|paytm|okaxis|okhdfcbank|okicici|oksbi|apl|icici|sbi|kotak)\b/gi;
const SOCIAL_HANDLE = /(^|[\s([{:;,])@[a-z0-9._]{2,30}\b/gi;
const PAYMENT_KEYWORDS = /\b(?:upi|paytm|g\s*pay|google\s*pay|phonepe|cash|direct(?:ly)?|outside|off[ -]?platform)\b/gi;

export type TrustSafetyDetection = "phone_number" | "upi_vpa" | "social_handle" | "payment_keyword";

export function redactTrustSafetyText(value: string) {
  const detections = new Set<TrustSafetyDetection>();
  let redacted = value;
  const replace = (pattern: RegExp, kind: TrustSafetyDetection) => {
    pattern.lastIndex = 0;
    if (pattern.test(redacted)) detections.add(kind);
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, match => {
      if (kind === "social_handle") {
        const prefix = /^[\s([{:;,]/.test(match[0] || "") ? match[0] : "";
        return `${prefix}${TRUST_SAFETY_REDACTION}`;
      }
      return TRUST_SAFETY_REDACTION;
    });
  };
  replace(UPI_VPA, "upi_vpa");
  replace(INDIAN_PHONE, "phone_number");
  replace(GENERIC_E164, "phone_number");
  replace(SOCIAL_HANDLE, "social_handle");
  replace(PAYMENT_KEYWORDS, "payment_keyword");
  return { redacted, detected: detections.size > 0, detections: Array.from(detections) };
}

export async function ensureTrustSafetyTables(db: Db) {
  await ensureCommunicationTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS trust_safety_events (id TEXT PRIMARY KEY,event_type TEXT NOT NULL,actor_type TEXT NOT NULL,actor_id TEXT,provider_id TEXT,customer_id TEXT,thread_id TEXT,message_id TEXT,channel TEXT NOT NULL,detection_types_json TEXT NOT NULL DEFAULT '[]',content_sha256 TEXT NOT NULL,source_reference TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',strike_applied INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(event_type,source_reference))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_trust_safety_events_provider ON trust_safety_events(provider_id,strike_applied,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_trust_state (provider_id TEXT PRIMARY KEY,trust_score INTEGER NOT NULL DEFAULT 100,strike_count INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',suspended_until INTEGER,last_event_id TEXT,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_trust_strikes (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,event_id TEXT NOT NULL UNIQUE,strike_number INTEGER NOT NULL,action TEXT NOT NULL,trust_score_before INTEGER NOT NULL,trust_score_after INTEGER NOT NULL,suspended_until INTEGER,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_trust_strikes_provider ON provider_trust_strikes(provider_id,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_chat_activity (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,thread_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_chat_activity_provider ON provider_chat_activity(provider_id,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS trust_safety_provider_notifications (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,strike_id TEXT NOT NULL UNIQUE,strike_number INTEGER NOT NULL,channel TEXT NOT NULL DEFAULT 'whatsapp',template_key TEXT NOT NULL DEFAULT 'provider_trust_warning_v1',status TEXT NOT NULL DEFAULT 'queued',attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,last_error TEXT,provider_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_trust_safety_provider_notifications_due ON trust_safety_provider_notifications(status,next_attempt_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS global_blocklist (phone_e164 TEXT PRIMARY KEY,phone_key TEXT NOT NULL,customer_id TEXT,reason_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',flagged_by TEXT NOT NULL,flagged_by_type TEXT NOT NULL,booking_id TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,cleared_at INTEGER)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_global_blocklist_e164_status ON global_blocklist(phone_e164,status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_global_blocklist_phone_key ON global_blocklist(phone_key,status)"),
    db.prepare("CREATE TABLE IF NOT EXISTS global_blocklist_customer_links (customer_id TEXT PRIMARY KEY,phone_e164 TEXT NOT NULL,linked_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_global_blocklist_links_phone ON global_blocklist_customer_links(phone_e164,customer_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS trust_safety_sweep_runs (slot_key TEXT PRIMARY KEY,started_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL,result_json TEXT NOT NULL DEFAULT '{}')"),
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_opt_outs (phone_key TEXT PRIMARY KEY,source TEXT NOT NULL,reason TEXT,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL)"),
  ]);
  await ensureProviderTrustColumns(db);
  await ensureBlocklistTriggers(db);
}

async function ensureBlocklistTriggers(db: Db) {
  if (await tableExists(db, "canonical_bookings")) {
    await db.exec(`CREATE TRIGGER IF NOT EXISTS trg_global_blocklist_booking_insert
      BEFORE INSERT ON canonical_bookings
      WHEN EXISTS (
        SELECT 1 FROM global_blocklist_customer_links l
        JOIN global_blocklist g ON g.phone_e164=l.phone_e164 AND g.status='active'
        WHERE l.customer_id=NEW.customer_id
      )
      BEGIN
        SELECT RAISE(ABORT,'global_customer_blocked');
      END;`);
  }
}

function trustScoreAfterStrike(strike: number) {
  if (strike <= 1) return 80;
  if (strike === 2) return 45;
  return 0;
}

function suspensionWeeks(score: number) {
  if (score >= 70) return 1;
  if (score >= 45) return 2;
  if (score >= 25) return 3;
  return 4;
}

async function applyProviderStrikeForEvent(db: Db, event: Row, asOf = Date.now()) {
  const providerId = text(event.provider_id);
  if (!providerId) return null;
  const existing = await db.prepare("SELECT * FROM provider_trust_strikes WHERE event_id=?").bind(text(event.id)).first<Row>();
  if (existing) return existing;
  const state = await db.prepare("SELECT * FROM provider_trust_state WHERE provider_id=?").bind(providerId).first<Row>();
  const priorCount = Number(state?.strike_count || 0);
  if (priorCount >= 3) {
    await db.prepare("UPDATE trust_safety_events SET strike_applied=1 WHERE id=?").bind(text(event.id)).run();
    return { providerId, strikeNumber: 3, action: "banned_permanent", trustScoreBefore: Number(state?.trust_score ?? 0), trustScoreAfter: 0, suspendedUntil: null, alreadyPermanent: true };
  }
  const strikeNumber = priorCount + 1;
  const before = Number(state?.trust_score ?? 100);
  const after = Math.min(before, trustScoreAfterStrike(strikeNumber));
  const until = strikeNumber === 2 ? asOf + suspensionWeeks(after) * 7 * DAY : null;
  const action = strikeNumber === 1 ? "warning" : strikeNumber === 2 ? "suspended" : "banned_permanent";
  const strikeId = uid("TSTRIKE");

  await db.batch([
    db.prepare("INSERT INTO provider_trust_strikes (id,provider_id,event_id,strike_number,action,trust_score_before,trust_score_after,suspended_until,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(strikeId, providerId, text(event.id), strikeNumber, action, before, after, until, asOf),
    db.prepare("INSERT INTO provider_trust_state (provider_id,trust_score,strike_count,status,suspended_until,last_event_id,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider_id) DO UPDATE SET trust_score=excluded.trust_score,strike_count=MAX(provider_trust_state.strike_count,excluded.strike_count),status=excluded.status,suspended_until=excluded.suspended_until,last_event_id=excluded.last_event_id,updated_at=excluded.updated_at")
      .bind(providerId, after, strikeNumber, action === "warning" ? "active" : action, until, text(event.id), asOf),
    db.prepare("UPDATE trust_safety_events SET strike_applied=1 WHERE id=?").bind(text(event.id)),
    db.prepare("INSERT OR IGNORE INTO trust_safety_provider_notifications (id,provider_id,strike_id,strike_number,channel,template_key,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?, 'whatsapp','provider_trust_warning_v1','queued',0,?,?,?)")
      .bind(uid("TSNOTIFY"), providerId, strikeId, strikeNumber, asOf, asOf, asOf),
  ]);

  if (await tableExists(db, "provider_capacity_profiles")) {
    if (strikeNumber === 1) {
      await db.prepare("UPDATE provider_capacity_profiles SET trust_score=?,trust_strike_count=MAX(COALESCE(trust_strike_count,0),1),updated_at=? WHERE id=?")
        .bind(after, asOf, providerId).run();
    } else if (strikeNumber === 2) {
      await db.prepare("UPDATE provider_capacity_profiles SET trust_score=?,trust_strike_count=MAX(COALESCE(trust_strike_count,0),2),status='suspended',live=0,suspended_until=?,updated_at=? WHERE id=? AND status!='banned_permanent'")
        .bind(after, until, asOf, providerId).run();
    } else {
      await db.prepare("UPDATE provider_capacity_profiles SET trust_score=0,trust_strike_count=3,status='banned_permanent',live=0,suspended_until=NULL,updated_at=? WHERE id=?")
        .bind(asOf, providerId).run();
    }
  }
  return { id: strikeId, providerId, strikeNumber, action, trustScoreBefore: before, trustScoreAfter: after, suspendedUntil: until };
}

export async function inspectTrustSafetyText(db: Db, input: {
  text: string;
  channel: string;
  sourceReference: string;
  actorType: TrustActorType;
  actorId?: string | null;
  providerId?: string | null;
  customerId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  detail?: Record<string, unknown>;
  asOf?: number;
  applyProviderStrikeImmediately?: boolean;
}) {
  await ensureTrustSafetyTables(db);
  const source = text(input.sourceReference);
  if (!source) throw new Error("Trust & Safety source reference is required");
  const inspected = redactTrustSafetyText(text(input.text));
  if (!inspected.detected) return { ...inspected, eventId: null, strike: null };
  const now = input.asOf ?? Date.now();
  const eventId = uid("TSEVT");
  const hash = await sha256(text(input.text));
  await db.prepare("INSERT OR IGNORE INTO trust_safety_events (id,event_type,actor_type,actor_id,provider_id,customer_id,thread_id,message_id,channel,detection_types_json,content_sha256,source_reference,detail_json,strike_applied,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)")
    .bind(eventId, "pilferage_attempt", input.actorType, text(input.actorId) || null, text(input.providerId) || null, text(input.customerId) || null, text(input.threadId) || null, text(input.messageId) || null, text(input.channel), JSON.stringify(inspected.detections), hash, source, JSON.stringify(input.detail || {}), now).run();
  const stored = await db.prepare("SELECT * FROM trust_safety_events WHERE event_type='pilferage_attempt' AND source_reference=?").bind(source).first<Row>();
  const strike = stored && input.actorType === "provider" && input.providerId && input.applyProviderStrikeImmediately !== false
    ? await applyProviderStrikeForEvent(db, stored, now)
    : null;
  return { ...inspected, eventId: text(stored?.id) || eventId, strike };
}

export async function scrubPersistedInboundMessage(db: Db, input: {
  messageId: string;
  text: string;
  channel: string;
  sourceReference: string;
  actorType?: TrustActorType;
  customerId?: string | null;
  providerId?: string | null;
  asOf?: number;
}) {
  const inspected = await inspectTrustSafetyText(db, {
    text: input.text,
    channel: input.channel,
    sourceReference: input.sourceReference,
    actorType: input.actorType || "external",
    customerId: input.customerId,
    providerId: input.providerId,
    messageId: input.messageId,
    asOf: input.asOf,
  });
  if (!inspected.detected) return inspected;
  const row = await db.prepare("SELECT payload_json FROM communication_messages WHERE id=?").bind(input.messageId).first<Row>();
  if (!row) return inspected;
  let payload: Row = {};
  try { payload = JSON.parse(text(row.payload_json) || "{}") as Row; } catch { payload = {}; }
  payload.text = inspected.redacted;
  delete payload.customerPhone;
  delete payload.providerPhone;
  await db.prepare("UPDATE communication_messages SET payload_json=?,updated_at=? WHERE id=?")
    .bind(JSON.stringify(payload), input.asOf ?? Date.now(), input.messageId).run();
  return inspected;
}

export async function recordProviderChatMessage(db: Db, input: {
  providerId: string;
  threadId: string;
  actorId: string;
  message: string;
  idempotencyKey: string;
  asOf?: number;
}) {
  await ensureTrustSafetyTables(db);
  const providerId = text(input.providerId), threadId = text(input.threadId), idempotencyKey = text(input.idempotencyKey), message = text(input.message);
  if (!providerId || !threadId || !idempotencyKey || !message) throw new Response("Provider, thread, idempotency key and message are required", { status: 400 });
  const prior = await db.prepare("SELECT id,thread_id,payload_json FROM communication_messages WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) {
    if (text(prior.thread_id) !== threadId) throw new Response("Idempotency key is already bound to another conversation", { status: 409 });
    return { duplicatePrevented: true, messageId: text(prior.id), threadId, payload: JSON.parse(text(prior.payload_json) || "{}") };
  }
  const thread = await db.prepare("SELECT customer_id,booking_id,status FROM communication_threads WHERE id=?").bind(threadId).first<Row>();
  if (!thread || text(thread.status) !== "open") throw new Response("Open conversation thread not found", { status: 404 });
  if (!text(thread.booking_id)) throw new Response("Provider chat is available only for a booked service", { status: 409 });
  let assigned = await db.prepare("SELECT provider_id FROM provider_work_orders WHERE booking_id=? LIMIT 1").bind(text(thread.booking_id)).first<Row>().catch(() => null);
  if (!assigned) assigned = await db.prepare("SELECT provider_id FROM canonical_bookings WHERE id=? LIMIT 1").bind(text(thread.booking_id)).first<Row>().catch(() => null);
  if (!assigned || text(assigned.provider_id) !== providerId) throw new Response("Provider is not assigned to this conversation", { status: 403 });
  const trust = await db.prepare("SELECT status,suspended_until FROM provider_trust_state WHERE provider_id=?").bind(providerId).first<Row>();
  if (trust && ["suspended", "banned_permanent"].includes(text(trust.status))) throw new Response("Provider messaging is suspended by Trust & Safety", { status: 403 });
  const now = input.asOf ?? Date.now(), messageId = uid("MSG-PCHAT");
  const inspected = await inspectTrustSafetyText(db, {
    text: message,
    channel: "chat",
    sourceReference: `provider-chat:${idempotencyKey}`,
    actorType: "provider",
    actorId: input.actorId,
    providerId,
    customerId: text(thread.customer_id),
    threadId,
    messageId,
    asOf: now,
    applyProviderStrikeImmediately: true,
  });
  await db.batch([
    db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'outbound','chat','transactional','provider_in_app_chat',?,'sent','pawspace_in_app',NULL,?,?,?, ?,?)")
      .bind(messageId, threadId, text(thread.customer_id), text(thread.booking_id), JSON.stringify({ text: inspected.redacted, safetyRedacted: inspected.detected }), idempotencyKey, JSON.stringify({ providerOwned: true, assignedBookingVerified: true, externalDelivery: false, trustSafetyInspected: true }), input.actorId, now, now),
    db.prepare("INSERT OR IGNORE INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'provider',?)")
      .bind(uid("PART"), threadId, "provider", providerId, providerId, now),
    db.prepare("INSERT OR IGNORE INTO provider_chat_activity (id,provider_id,thread_id,message_id,created_at) VALUES (?,?,?,?,?)")
      .bind(uid("PCHAT"), providerId, threadId, messageId, now),
    db.prepare("UPDATE communication_threads SET updated_at=? WHERE id=?").bind(now, threadId),
  ]);
  return { duplicatePrevented: false, messageId, threadId, redacted: inspected.detected, detections: inspected.detections, strike: inspected.strike };
}

async function linkExistingCustomers(db: Db, phone: { e164: string; key: string }, asOf: number) {
  if (!await tableExists(db, "canonical_customers")) return [] as string[];
  const columns = await columnNames(db, "canonical_customers");
  if (!columns.has("primary_phone")) return [] as string[];
  const select = columns.has("secondary_phone") ? "SELECT id,primary_phone,secondary_phone FROM canonical_customers" : "SELECT id,primary_phone,NULL AS secondary_phone FROM canonical_customers";
  const rows = await db.prepare(select).all<Row>();
  const ids = rows.results.filter(row => [row.primary_phone, row.secondary_phone].some(value => normaliseTrustSafetyPhone(value)?.key === phone.key)).map(row => text(row.id)).filter(Boolean);
  for (const customerId of ids) {
    await db.prepare("INSERT INTO global_blocklist_customer_links (customer_id,phone_e164,linked_at) VALUES (?,?,?) ON CONFLICT(customer_id) DO UPDATE SET phone_e164=excluded.phone_e164,linked_at=excluded.linked_at")
      .bind(customerId, phone.e164, asOf).run();
  }
  return ids;
}

async function suppressCustomerCommunication(db: Db, customerIds: string[], actorId: string, asOf: number) {
  for (const customerId of customerIds) {
    await db.prepare("INSERT INTO communication_preferences (customer_id,sms,email,whatsapp,push,marketing,service_updates,quiet_start,quiet_end,updated_by,updated_at) VALUES (?,0,0,0,0,0,0,'00:00','23:59',?,?) ON CONFLICT(customer_id) DO UPDATE SET sms=0,email=0,whatsapp=0,push=0,marketing=0,service_updates=0,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
      .bind(customerId, actorId, asOf).run();
    if (await tableExists(db, "customer_contact_preferences")) {
      await db.prepare("UPDATE customer_contact_preferences SET marketing_consent=0,service_consent=0,whatsapp_consent=0,sms_consent=0,email_consent=0,opt_out=1,source='global_blocklist',updated_by=?,updated_at=? WHERE customer_id=?")
        .bind(actorId, asOf, customerId).run();
    }
    await db.prepare("UPDATE communication_outbox SET status='suppressed',last_error='global_blocklist',locked_at=NULL,updated_at=? WHERE message_id IN (SELECT id FROM communication_messages WHERE customer_id=?) AND status IN ('queued','retry_pending','scheduled','dispatching')")
      .bind(asOf, customerId).run();
    await db.prepare("UPDATE communication_messages SET status='suppressed',updated_at=? WHERE customer_id=? AND status IN ('queued','retry_pending','scheduled')")
      .bind(asOf, customerId).run();
    if (await tableExists(db, "lead_work_items")) {
      const leadColumns = await columnNames(db, "lead_work_items");
      if (leadColumns.has("opt_out")) await db.prepare("UPDATE lead_work_items SET opt_out=1,updated_at=? WHERE customer_id=?").bind(asOf, customerId).run();
    }
  }
}

export async function flagCustomerOnGlobalBlocklist(db: Db, input: {
  phone: string;
  reasonCode: BlocklistReason;
  actorId: string;
  actorType: "provider" | "staff";
  customerId?: string | null;
  bookingId?: string | null;
  detail?: Record<string, unknown>;
  asOf?: number;
}) {
  await ensureTrustSafetyTables(db);
  if (!BLOCKLIST_REASONS.includes(input.reasonCode)) throw new Response("Unsupported blocklist reason", { status: 400 });
  const phone = normaliseTrustSafetyPhone(input.phone);
  if (!phone) throw new Response("A valid E.164 customer phone is required", { status: 400 });
  const now = input.asOf ?? Date.now();
  await db.prepare("INSERT INTO global_blocklist (phone_e164,phone_key,customer_id,reason_code,status,flagged_by,flagged_by_type,booking_id,detail_json,created_at,updated_at,cleared_at) VALUES (?,?,?,?,'active',?,?,?,?,?,?,NULL) ON CONFLICT(phone_e164) DO UPDATE SET customer_id=COALESCE(excluded.customer_id,global_blocklist.customer_id),reason_code=excluded.reason_code,status='active',flagged_by=excluded.flagged_by,flagged_by_type=excluded.flagged_by_type,booking_id=COALESCE(excluded.booking_id,global_blocklist.booking_id),detail_json=excluded.detail_json,updated_at=excluded.updated_at,cleared_at=NULL")
    .bind(phone.e164, phone.key, text(input.customerId) || null, input.reasonCode, input.actorId, input.actorType, text(input.bookingId) || null, JSON.stringify(input.detail || {}), now, now).run();
  const customerIds = await linkExistingCustomers(db, phone, now);
  if (input.customerId && !customerIds.includes(input.customerId)) {
    await db.prepare("INSERT INTO global_blocklist_customer_links (customer_id,phone_e164,linked_at) VALUES (?,?,?) ON CONFLICT(customer_id) DO UPDATE SET phone_e164=excluded.phone_e164,linked_at=excluded.linked_at")
      .bind(input.customerId, phone.e164, now).run();
    customerIds.push(input.customerId);
  }
  await suppressCustomerCommunication(db, customerIds, input.actorId, now);
  await db.prepare("INSERT INTO voice_call_opt_outs (phone_key,source,reason,recorded_by,recorded_at) VALUES (?,'global_blocklist',?,?,?) ON CONFLICT(phone_key) DO UPDATE SET source='global_blocklist',reason=excluded.reason,recorded_by=excluded.recorded_by,recorded_at=excluded.recorded_at")
    .bind(phone.key, input.reasonCode, input.actorId, now).run();
  return { blocked: true, phoneE164: phone.e164, reasonCode: input.reasonCode, linkedCustomerIds: customerIds };
}

export async function clearCustomerGlobalBlock(db: Db, input: { phone: string; actorId: string; asOf?: number }) {
  await ensureTrustSafetyTables(db);
  const phone = normaliseTrustSafetyPhone(input.phone);
  if (!phone) throw new Response("A valid E.164 customer phone is required", { status: 400 });
  const now = input.asOf ?? Date.now();
  await db.batch([
    db.prepare("UPDATE global_blocklist SET status='cleared',cleared_at=?,updated_at=? WHERE phone_e164=? AND status='active'").bind(now, now, phone.e164),
    db.prepare("DELETE FROM global_blocklist_customer_links WHERE phone_e164=?").bind(phone.e164),
    db.prepare("DELETE FROM voice_call_opt_outs WHERE phone_key=? AND source='global_blocklist'").bind(phone.key),
  ]);
  return { blocked: false, phoneE164: phone.e164 };
}

export async function isGloballyBlockedPhone(db: Db, value: string) {
  await ensureTrustSafetyTables(db);
  const phone = normaliseTrustSafetyPhone(value);
  if (!phone) return { blocked: false, phoneE164: null, reasonCode: null };
  const row = await db.prepare("SELECT reason_code FROM global_blocklist WHERE (phone_e164=? OR phone_key=?) AND status='active' LIMIT 1").bind(phone.e164, phone.key).first<Row>();
  return { blocked: Boolean(row), phoneE164: phone.e164, reasonCode: row ? text(row.reason_code) : null };
}

export async function assertCustomerNotGloballyBlocked(db: Db, customerId: string) {
  await ensureTrustSafetyTables(db);
  const row = await db.prepare("SELECT g.reason_code FROM global_blocklist_customer_links l JOIN global_blocklist g ON g.phone_e164=l.phone_e164 AND g.status='active' WHERE l.customer_id=? LIMIT 1").bind(customerId).first<Row>();
  if (row) throw new Response("Account Suspended", { status: 403 });
  return true;
}

async function releaseExpiredSuspensions(db: Db, asOf: number) {
  const due = await db.prepare("SELECT provider_id FROM provider_trust_state WHERE status='suspended' AND suspended_until IS NOT NULL AND suspended_until<=? AND strike_count=2").bind(asOf).all<Row>();
  let released = 0;
  for (const row of due.results) {
    const providerId = text(row.provider_id);
    const changed = await db.prepare("UPDATE provider_trust_state SET status='active',suspended_until=NULL,updated_at=? WHERE provider_id=? AND status='suspended' AND strike_count=2 AND suspended_until<=?").bind(asOf, providerId, asOf).run();
    if (!Number(changed.meta?.changes || 0)) continue;
    released++;
    if (await tableExists(db, "provider_capacity_profiles")) {
      await db.prepare("UPDATE provider_capacity_profiles SET status='active',live=1,suspended_until=NULL,updated_at=? WHERE id=? AND status='suspended' AND COALESCE(trust_strike_count,0)=2")
        .bind(asOf, providerId).run();
    }
  }
  return released;
}

async function applyUnprocessedEvents(db: Db, asOf: number) {
  const rows = await db.prepare("SELECT * FROM trust_safety_events WHERE provider_id IS NOT NULL AND strike_applied=0 AND event_type IN ('pilferage_attempt','ghosting_behavior') ORDER BY created_at ASC LIMIT 100").all<Row>();
  let applied = 0;
  for (const row of rows.results) if (await applyProviderStrikeForEvent(db, row, asOf)) applied++;
  return applied;
}

async function evaluateGhosting(db: Db, asOf: number) {
  if (!await tableExists(db, "provider_chat_activity") || !await tableExists(db, "provider_work_orders")) return { evaluated: 0, flagged: 0 };
  const since = asOf - 7 * DAY;
  const rows = await db.prepare("SELECT provider_id,COUNT(*) AS chat_count FROM provider_chat_activity WHERE created_at>=? GROUP BY provider_id HAVING COUNT(*)>=20").bind(since).all<Row>();
  let flagged = 0;
  for (const row of rows.results) {
    const providerId = text(row.provider_id);
    const conversions = await db.prepare("SELECT COUNT(*) AS count FROM provider_work_orders WHERE provider_id=? AND status IN ('accepted','in_progress','completed')").bind(providerId).first<Row>();
    if (Number(conversions?.count || 0) > 0) continue;
    const bucket = Math.floor(asOf / (7 * DAY));
    const source = `ghosting:${providerId}:${bucket}`;
    const eventId = uid("TSEVT");
    const inserted = await db.prepare("INSERT OR IGNORE INTO trust_safety_events (id,event_type,actor_type,actor_id,provider_id,customer_id,thread_id,message_id,channel,detection_types_json,content_sha256,source_reference,detail_json,strike_applied,created_at) VALUES (?,'ghosting_behavior','provider',?,?,NULL,NULL,NULL,'chat','[]',?,?,?,0,?)")
      .bind(eventId, providerId, providerId, await sha256(source), source, JSON.stringify({ sevenDayChatCount: Number(row.chat_count || 0), bookingConversions: 0 }), asOf).run();
    if (Number(inserted.meta?.changes || 0)) flagged++;
  }
  return { evaluated: rows.results.length, flagged };
}

async function dispatchProviderWarning(db: Db, env: Env, notification: Row) {
  const providerId = text(notification.provider_id);
  if (!providerId || !await tableExists(db, "canonical_providers")) return { sent: false, reason: "provider_directory_unavailable" };
  const provider = await db.prepare("SELECT phone FROM canonical_providers WHERE id=?").bind(providerId).first<Row>().catch(() => null);
  const dial = normaliseTrustSafetyPhone(provider?.phone);
  if (!dial) return { sent: false, reason: "provider_phone_unavailable" };
  const production = text(env.PAWSPACE_DEPLOYMENT_ENV).toLowerCase() === "production" && text(env.PAWSPACE_COMMUNICATION_ENV).toLowerCase() === "live";
  const apiKey = text(env.INTERAKT_API_KEY), template = text(env.PAWSPACE_TRUST_SAFETY_WARNING_TEMPLATE);
  if (!production || !apiKey || !template) return { sent: false, reason: "whatsapp_warning_not_live_configured" };
  const body = JSON.stringify({
    countryCode: "+91",
    phoneNumber: dial.key,
    callbackData: `trust-safety:${text(notification.id)}`,
    type: "Template",
    template: { name: template, languageCode: "en", bodyValues: [String(notification.strike_number), text(notification.strike_number) === "1" ? "Policy warning" : text(notification.strike_number) === "2" ? "Temporary suspension" : "Permanent platform ban"] },
  });
  const response = await fetch("https://api.interakt.ai/v1/public/message/", { method: "POST", redirect: "error", headers: { authorization: `Basic ${apiKey}`, "content-type": "application/json", "x-pawspace-idempotency-key": text(notification.id) }, body });
  const raw = await response.text().catch(() => "");
  let parsed: Row = {}; try { parsed = raw ? JSON.parse(raw) as Row : {}; } catch { parsed = {}; }
  if (!response.ok || parsed.result === false) return { sent: false, reason: `interakt_http_${response.status}` };
  return { sent: true, providerReference: text(parsed.id) || null };
}

async function dispatchProviderWarnings(db: Db, env: Env, asOf: number) {
  const rows = await db.prepare("SELECT * FROM trust_safety_provider_notifications WHERE status IN ('queued','retry_pending') AND next_attempt_at<=? ORDER BY next_attempt_at ASC LIMIT 25").bind(asOf).all<Row>();
  let sent = 0, held = 0, failed = 0;
  for (const row of rows.results) {
    try {
      const result = await dispatchProviderWarning(db, env, row);
      if (result.sent) {
        sent++;
        await db.prepare("UPDATE trust_safety_provider_notifications SET status='sent',provider_reference=?,attempt_count=attempt_count+1,last_error=NULL,updated_at=? WHERE id=?")
          .bind(result.providerReference, asOf, row.id).run();
      } else if (result.reason === "whatsapp_warning_not_live_configured") {
        held++;
        await db.prepare("UPDATE trust_safety_provider_notifications SET status='queued',last_error=?,next_attempt_at=?,updated_at=? WHERE id=?")
          .bind(result.reason, asOf + 6 * 60 * 60_000, asOf, row.id).run();
      } else {
        failed++;
        const attempts = Number(row.attempt_count || 0) + 1;
        await db.prepare("UPDATE trust_safety_provider_notifications SET status=?,attempt_count=?,last_error=?,next_attempt_at=?,updated_at=? WHERE id=?")
          .bind(attempts >= 5 ? "dead_letter" : "retry_pending", attempts, result.reason, asOf + Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** attempts), asOf, row.id).run();
      }
    } catch (error) {
      failed++;
      const attempts = Number(row.attempt_count || 0) + 1;
      await db.prepare("UPDATE trust_safety_provider_notifications SET status=?,attempt_count=?,last_error=?,next_attempt_at=?,updated_at=? WHERE id=?")
        .bind(attempts >= 5 ? "dead_letter" : "retry_pending", attempts, error instanceof Error ? error.message.slice(0, 160) : "warning_dispatch_failed", asOf + Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** attempts), asOf, row.id).run();
    }
  }
  return { processed: rows.results.length, sent, held, failed };
}

export async function runTrustSafetySweep(db: Db, env: Env = {}, input: { asOf?: number } = {}) {
  await ensureTrustSafetyTables(db);
  const asOf = input.asOf ?? Date.now(), slot = Math.floor(asOf / 300_000) * 300_000, slotKey = `trust-safety:${slot}`;
  const prior = await db.prepare("SELECT status,result_json FROM trust_safety_sweep_runs WHERE slot_key=?").bind(slotKey).first<Row>();
  if (text(prior?.status) === "completed") return { ...(JSON.parse(text(prior?.result_json) || "{}") as Row), duplicatePrevented: true };
  await db.prepare("INSERT INTO trust_safety_sweep_runs (slot_key,started_at,status,result_json) VALUES (?,?,'running','{}') ON CONFLICT(slot_key) DO UPDATE SET started_at=excluded.started_at,status='running'").bind(slotKey, Date.now()).run();
  try {
    const released = await releaseExpiredSuspensions(db, asOf);
    const ghosting = await evaluateGhosting(db, asOf);
    const strikesApplied = await applyUnprocessedEvents(db, asOf);
    const warnings = await dispatchProviderWarnings(db, env, asOf);
    const result = { asOf, releasedSuspensions: released, ghosting, strikesApplied, warnings, duplicatePrevented: false };
    await db.prepare("UPDATE trust_safety_sweep_runs SET status='completed',finished_at=?,result_json=? WHERE slot_key=?").bind(Date.now(), JSON.stringify(result), slotKey).run();
    return result;
  } catch (error) {
    await db.prepare("UPDATE trust_safety_sweep_runs SET status='failed',finished_at=?,result_json=? WHERE slot_key=?").bind(Date.now(), JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), slotKey).run();
    throw error;
  }
}
