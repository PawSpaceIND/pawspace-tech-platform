import { authFailure, requireCustomerOwnership, requireProviderOwnership, type AuthenticatedActor } from "./server-auth";
import { callRecordingApproved, canonicalDialNumber, isVoiceAllowlisted, resolveVoiceCallGate } from "./voice-call-gate";
import { ProviderResponseTooLarge, readBoundedText } from "./provider-response-bounds";
import { normaliseTelephonyEvent, sha256Hex, verifyVoiceWebhookSignature } from "./voice-telephony-provider";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;

export type VoiceBridgeSessionStatus = "initiated" | "bridged" | "completed" | "failed";
export const ACTIVE_VOICE_SERVICE_STATES = ["assigned", "en_route", "in_progress"] as const;

const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const EXOTEL_TIMEOUT_MS = 12_000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

function bridgeCallbackUrl(env: Env) {
  const raw = text(env.PAWSPACE_VOICE_BRIDGE_STATUS_CALLBACK_URL);
  if (!raw) return null;
  try { return new URL(raw).protocol === "https:" ? raw : null; } catch { return null; }
}

function safeFailureDetail(error: unknown) {
  const message = text((error as { message?: unknown })?.message || error);
  return message.replace(/\+?\d[\d\s().-]{7,}/g, "[redacted-phone]").slice(0, 240) || "Voice bridge failed";
}

export async function ensureVoiceBridgeTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_sessions (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,initiated_by_type TEXT NOT NULL,initiated_by_key TEXT NOT NULL,service_status TEXT NOT NULL,status TEXT NOT NULL,provider TEXT NOT NULL DEFAULT 'exotel',exotel_call_id TEXT,customer_phone_hash TEXT NOT NULL,customer_phone_last4 TEXT NOT NULL,provider_phone_hash TEXT NOT NULL,provider_phone_last4 TEXT NOT NULL,recording_ref TEXT,failure_code TEXT,failure_detail TEXT,initiated_at INTEGER NOT NULL,bridged_at INTEGER,completed_at INTEGER,failed_at INTEGER,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_call_sessions_booking ON voice_call_sessions(booking_id,initiated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_call_sessions_exotel ON voice_call_sessions(exotel_call_id)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS ux_voice_call_sessions_active_booking ON voice_call_sessions(booking_id) WHERE status IN ('initiated','bridged')"),
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_session_events (id TEXT PRIMARY KEY,session_id TEXT,provider_event_id TEXT NOT NULL UNIQUE,event_kind TEXT NOT NULL,provider_status TEXT,payload_sha256 TEXT NOT NULL,recording_ref TEXT,duration_seconds INTEGER,applied INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_call_session_events_session ON voice_call_session_events(session_id,created_at)"),
  ]);
}

async function resolveBridgeBooking(db: Db, bookingId: string) {
  const row = await db.prepare(`SELECT b.id,b.customer_id,b.provider_id,b.status AS booking_status,
    w.status AS work_order_status,w.provider_id AS work_order_provider_id,
    c.primary_phone AS customer_phone,p.phone AS provider_phone
    FROM canonical_bookings b
    JOIN canonical_customers c ON c.id=b.customer_id
    JOIN provider_work_orders w ON w.booking_id=b.id
    LEFT JOIN canonical_providers p ON p.id=b.provider_id
    WHERE b.id=? LIMIT 1`).bind(bookingId).first<Row>();
  if (!row) throw authFailure("Booking is unavailable for masked calling", 404);
  if (text(row.provider_id) !== text(row.work_order_provider_id)) throw authFailure("Booking provider assignment is inconsistent", 409);
  const serviceStatus = text(row.work_order_status || row.booking_status).toLowerCase();
  if (!(ACTIVE_VOICE_SERVICE_STATES as readonly string[]).includes(serviceStatus)) {
    throw authFailure("Masked calling is available only during an active service window", 409);
  }
  if (!text(row.customer_phone)) throw authFailure("Customer phone is unavailable for masked calling", 409);
  if (!text(row.provider_phone)) throw authFailure("Provider phone is unavailable for masked calling", 409);
  return { ...row, serviceStatus };
}

function initiatorType(actor: AuthenticatedActor): "customer" | "provider" {
  if (actor.roleCode === "customer") return "customer";
  if (actor.roleCode === "service_provider") return "provider";
  throw authFailure("Only the assigned provider or pet parent may initiate a masked service call", 403);
}

async function dialExotelBridge(env: Env, input: { sessionId: string; from: string; to: string }) {
  const gate = resolveVoiceCallGate(env);
  if (!gate.ok) throw authFailure(gate.reason, gate.status);
  const callback = bridgeCallbackUrl(env);
  if (!callback) throw authFailure("A https Exotel bridge callback URL is not configured", 503);
  const from = canonicalDialNumber(env, input.from), to = canonicalDialNumber(env, input.to);
  if (!from || !to) throw authFailure("Masked-call phone data could not be canonicalised", 409);
  if (gate.mode === "uat" && (!isVoiceAllowlisted(env, from) || !isVoiceAllowlisted(env, to))) {
    throw authFailure("Both masked-call legs must be explicitly allowlisted in UAT", 403);
  }
  const sid = text(env.EXOTEL_SID), key = text(env.EXOTEL_API_KEY), token = text(env.EXOTEL_API_TOKEN);
  const callerId = text(env.EXOTEL_CALLER_ID), subdomain = text(env.EXOTEL_SUBDOMAIN) || "api.exotel.com";
  const body = new URLSearchParams({
    From: from,
    To: to,
    CallerId: callerId,
    CallType: "trans",
    StatusCallback: callback,
    CustomField: input.sessionId,
    TimeOut: "45",
    Record: callRecordingApproved(env) ? "true" : "false",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXOTEL_TIMEOUT_MS);
  try {
    let response: Response, raw: string;
    try {
      response = await fetch(`https://${subdomain}/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect.json`, {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Basic ${btoa(`${key}:${token}`)}`, "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      raw = await readBoundedText(response, MAX_PROVIDER_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ProviderResponseTooLarge) throw new Error("Exotel bridge response exceeded the size limit");
      throw new Error(controller.signal.aborted ? `Exotel bridge did not respond within ${EXOTEL_TIMEOUT_MS}ms` : `Exotel bridge request failed: ${safeFailureDetail(error)}`);
    }
    if (!response.ok) throw new Error(`Exotel rejected the bridge request (${response.status})`);
    let parsed: { Call?: { Sid?: string; Status?: string } } = {};
    try { parsed = JSON.parse(raw) as { Call?: { Sid?: string; Status?: string } }; } catch { throw new Error("Exotel returned a malformed bridge response"); }
    const providerCallId = text(parsed.Call?.Sid);
    if (!providerCallId) throw new Error("Exotel returned no bridge call identifier");
    return { providerCallId, providerStatus: text(parsed.Call?.Status) || "queued" };
  } finally { clearTimeout(timer); }
}

export async function requestVoiceBridge(db: Db, env: Env, actor: AuthenticatedActor, input: { bookingId: string; idempotencyKey: string }) {
  await ensureVoiceBridgeTables(db);
  const bookingId = text(input.bookingId), idempotencyKey = text(input.idempotencyKey);
  if (!bookingId || !idempotencyKey) throw authFailure("Booking ID and idempotency key are required", 400);
  const who = initiatorType(actor);
  const prior = await db.prepare("SELECT id,booking_id,initiated_by_type,status,provider,exotel_call_id FROM voice_call_sessions WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) {
    if (text(prior.booking_id) !== bookingId || text(prior.initiated_by_type) !== who) throw authFailure("Idempotency key is already bound to another masked-call request", 409);
    return { sessionId: text(prior.id), bookingId, status: text(prior.status) as VoiceBridgeSessionStatus, provider: text(prior.provider), providerCallId: text(prior.exotel_call_id) || null, replayed: true, initiatorType: who };
  }
  const booking = await resolveBridgeBooking(db, bookingId);
  if (who === "customer") await requireCustomerOwnership(db, actor, text(booking.customer_id));
  else await requireProviderOwnership(db, actor, text(booking.provider_id));

  const customerDial = canonicalDialNumber(env, booking.customer_phone), providerDial = canonicalDialNumber(env, booking.provider_phone);
  if (!customerDial || !providerDial) throw authFailure("Masked-call phone data could not be canonicalised", 409);
  const sessionId = uid("VBRIDGE"), now = Date.now();
  try {
    await db.prepare("INSERT INTO voice_call_sessions (id,idempotency_key,booking_id,customer_id,provider_id,initiated_by_type,initiated_by_key,service_status,status,provider,customer_phone_hash,customer_phone_last4,provider_phone_hash,provider_phone_last4,initiated_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'exotel',?,?,?,?,?,?)")
      .bind(sessionId,idempotencyKey,bookingId,text(booking.customer_id),text(booking.provider_id),who,actor.principalKey,booking.serviceStatus,"initiated",await sha256Hex(customerDial),customerDial.slice(-4),await sha256Hex(providerDial),providerDial.slice(-4),now,now).run();
  } catch (error) {
    if (/unique|constraint/i.test(safeFailureDetail(error))) throw authFailure("An active masked call already exists for this booking", 409);
    throw error;
  }

  try {
    const first = who === "customer" ? customerDial : providerDial;
    const second = who === "customer" ? providerDial : customerDial;
    const handle = await dialExotelBridge(env, { sessionId, from: first, to: second });
    await db.prepare("UPDATE voice_call_sessions SET exotel_call_id=?,updated_at=? WHERE id=? AND status='initiated'").bind(handle.providerCallId,Date.now(),sessionId).run();
    return { sessionId, bookingId, status: "initiated" as const, provider: "exotel", providerCallId: handle.providerCallId, providerStatus: handle.providerStatus, replayed: false, initiatorType: who };
  } catch (error) {
    const failedAt = Date.now(), detail = safeFailureDetail(error);
    await db.prepare("UPDATE voice_call_sessions SET status='failed',failure_code='provider_request_failed',failure_detail=?,failed_at=?,updated_at=? WHERE id=? AND status='initiated'").bind(detail,failedAt,failedAt,sessionId).run();
    if (error instanceof Response) throw error;
    throw authFailure("Unable to establish the masked call", 502);
  }
}

function eventTargetState(kind: string): VoiceBridgeSessionStatus | null {
  if (kind === "connected") return "bridged";
  if (kind === "completed") return "completed";
  if (["failed", "busy", "no_answer"].includes(kind)) return "failed";
  return null;
}

export async function recordVoiceBridgeEvent(db: Db, env: Env, input: { rawBody: string; headers: Headers }) {
  await ensureVoiceBridgeTables(db);
  const secret = text(env.EXOTEL_WEBHOOK_SECRET);
  const verification = await verifyVoiceWebhookSignature(secret, input.rawBody, input.headers);
  if (!verification.verified) return { accepted: false as const, status: 401, reason: verification.reason || "Webhook verification failed" };
  let event;
  try { event = normaliseTelephonyEvent(input.rawBody, "exotel"); }
  catch { return { accepted: false as const, status: 400, reason: "Exotel call event is malformed" }; }
  const existing = await db.prepare("SELECT id,session_id,applied FROM voice_call_session_events WHERE provider_event_id=?").bind(event.providerEventId).first<Row>();
  if (existing) return { accepted: true as const, status: 200, duplicate: true, applied: Boolean(existing.applied), sessionId: text(existing.session_id) || null };

  let session: Row | null = null;
  if (event.callRef) session = await db.prepare("SELECT * FROM voice_call_sessions WHERE id=?").bind(event.callRef).first<Row>();
  if (!session && event.providerCallId) session = await db.prepare("SELECT * FROM voice_call_sessions WHERE exotel_call_id=? ORDER BY initiated_at DESC LIMIT 1").bind(event.providerCallId).first<Row>();
  if (!session) return { accepted: false as const, status: 404, reason: "Masked-call session was not found" };

  const now = Date.now(), payloadHash = await sha256Hex(input.rawBody);
  const recordingRef = event.recordingRef && callRecordingApproved(env) ? event.recordingRef : null;
  const target = eventTargetState(event.kind), current = text(session.status) as VoiceBridgeSessionStatus;
  let applied = false;
  const statements = [
    db.prepare("INSERT INTO voice_call_session_events (id,session_id,provider_event_id,event_kind,provider_status,payload_sha256,recording_ref,duration_seconds,applied,created_at) VALUES (?,?,?,?,?,?,?,?,0,?)")
      .bind(uid("VBEVT"),text(session.id),event.providerEventId,event.kind,event.providerStatus,payloadHash,recordingRef,event.durationSeconds,now),
  ];
  if (recordingRef) statements.push(db.prepare("UPDATE voice_call_sessions SET recording_ref=?,updated_at=? WHERE id=?").bind(recordingRef,now,text(session.id)));
  if (target === "bridged" && current === "initiated") {
    statements.push(db.prepare("UPDATE voice_call_sessions SET status='bridged',bridged_at=?,updated_at=? WHERE id=? AND status='initiated'").bind(now,now,text(session.id)));
    applied = true;
  } else if (target === "completed" && current === "initiated") {
    // Exotel may send only a terminal callback. Preserve the legal state path by recording both timestamps.
    statements.push(db.prepare("UPDATE voice_call_sessions SET status='completed',bridged_at=COALESCE(bridged_at,?),completed_at=?,updated_at=? WHERE id=? AND status='initiated'").bind(now,now,now,text(session.id)));
    applied = true;
  } else if (target === "completed" && current === "bridged") {
    statements.push(db.prepare("UPDATE voice_call_sessions SET status='completed',completed_at=?,updated_at=? WHERE id=? AND status='bridged'").bind(now,now,text(session.id)));
    applied = true;
  } else if (target === "failed" && (current === "initiated" || current === "bridged")) {
    statements.push(db.prepare("UPDATE voice_call_sessions SET status='failed',failure_code=?,failure_detail=?,failed_at=?,updated_at=? WHERE id=? AND status=?").bind(`exotel_${event.kind}`,text(event.providerStatus).slice(0,120)||event.kind,now,now,text(session.id),current));
    applied = true;
  }
  await db.batch(statements);
  if (applied) await db.prepare("UPDATE voice_call_session_events SET applied=1 WHERE provider_event_id=?").bind(event.providerEventId).run();
  return { accepted: true as const, status: 200, duplicate: false, applied, sessionId: text(session.id), from: current, to: target, eventKind: event.kind, recordingStored: Boolean(recordingRef) };
}
