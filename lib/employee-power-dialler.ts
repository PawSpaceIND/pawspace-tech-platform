import { ensureLeadScoringMergeTables, scoreLead } from "./crm-lead-scoring-merge";
import { ensureCrmPipelineTables } from "./crm-pipeline-forecast";
import { canonicalDialNumber, normalisedDialKey } from "./voice-call-gate";
import { normaliseTelephonyEvent, sha256Hex, verifyVoiceWebhookSignature } from "./voice-telephony-provider";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;

const text = (value: unknown) => String(value ?? "").trim();
const rows = <T = Row>(result: { results?: unknown[] }) => (result.results ?? []) as T[];
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const IST_OFFSET_MINUTES = 330;
const EXOTEL_TIMEOUT_MS = 12_000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

export const DIALLER_DISPOSITIONS = [
  "Interested",
  "Booked",
  "Callback Scheduled",
  "No Answer",
  "Not Interested",
  "Wrong Number",
  "DND / Suppress",
] as const;
export type DiallerDisposition = typeof DIALLER_DISPOSITIONS[number];
export type DiallerCallClass = "promotional" | "service";
export type DiallerCallState = "connecting_agent" | "dialling_customer" | "in_call" | "call_ended";

export class DiallerPolicyError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
    this.name = "DiallerPolicyError";
  }
}

const envValue = (env: Env, key: string) => text(env?.[key]);
const envTrue = (env: Env, key: string) => envValue(env, key).toLowerCase() === "true";

async function tableExists(db: Db, table: string) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first<Row>());
}

export function diallerWindow(asOf = Date.now()) {
  const local = new Date(asOf + IST_OFFSET_MINUTES * 60_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const open = minutes >= 9 * 60 && minutes < 21 * 60;
  return { open, localHour: local.getUTCHours(), localMinute: local.getUTCMinutes(), start: "09:00", end: "21:00", timezone: "Asia/Kolkata" };
}

function diallerMode(env: Env) {
  const mode = envValue(env, "PAWSPACE_DIALLER_ENV").toLowerCase();
  return mode === "live" ? "live" : mode === "uat" ? "uat" : "disabled";
}

function digits(value: unknown) { return text(value).replace(/[^0-9]/g, ""); }

function validCallerSeries(value: string, callClass: DiallerCallClass) {
  const number = digits(value);
  if (callClass === "promotional") return number.startsWith("140");
  return number.startsWith("160");
}

function callerIdForClass(env: Env, callClass: DiallerCallClass) {
  const key = callClass === "promotional" ? "EXOTEL_PROMO_CALLER_ID" : "EXOTEL_SERVICE_CALLER_ID";
  const callerId = envValue(env, key);
  if (!callerId) throw new DiallerPolicyError("caller_id_not_configured", `${key} is required before ${callClass} calls can be placed`, 503);
  if (!validCallerSeries(callerId, callClass)) {
    throw new DiallerPolicyError("caller_id_series_mismatch", `${key} must be an Exotel-provisioned ${callClass === "promotional" ? "140" : "160"}-series caller ID`, 503);
  }
  return callerId;
}

function parseJsonObject(raw: string, label: string) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new DiallerPolicyError("dialler_configuration_invalid", `${label} must be valid JSON`, 503);
  }
}

function agentPhoneForActor(env: Env, actorEmail: string) {
  const raw = envValue(env, "PAWSPACE_DIALLER_AGENT_MAP_JSON");
  if (!raw) throw new DiallerPolicyError("agent_map_not_configured", "PAWSPACE_DIALLER_AGENT_MAP_JSON is required", 503);
  const map = parseJsonObject(raw, "PAWSPACE_DIALLER_AGENT_MAP_JSON");
  const wanted = actorEmail.trim().toLowerCase();
  const entry = Object.entries(map).find(([key]) => key.trim().toLowerCase() === wanted)?.[1];
  const phone = canonicalDialNumber(env, entry);
  if (!phone) throw new DiallerPolicyError("operator_phone_not_configured", "No valid server-side dialler phone is mapped to this operator", 403);
  return phone;
}

function uatAllowlist(env: Env) {
  return envValue(env, "PAWSPACE_DIALLER_UAT_CUSTOMER_ALLOWLIST")
    .split(/[,;\n]+/)
    .map(entry => normalisedDialKey(entry))
    .filter(Boolean);
}

function requireDiallerGate(env: Env, actorEmail: string, customerPhone: string, callClass: DiallerCallClass) {
  const mode = diallerMode(env);
  if (mode === "disabled") throw new DiallerPolicyError("dialler_disabled", "Employee dialler is disabled for this environment", 503);
  if (!envTrue(env, "PAWSPACE_DIALLER_UAT_APPROVED")) throw new DiallerPolicyError("dialler_not_approved", "Employee dialler UAT approval is not enabled", 503);
  if (mode === "live" && !envTrue(env, "PAWSPACE_DIALLER_LIVE_APPROVED")) throw new DiallerPolicyError("live_dialler_not_approved", "Live employee dialling is not approved", 503);
  const required = ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_WEBHOOK_SECRET", "PAWSPACE_DIALLER_STATUS_CALLBACK_URL"];
  const missing = required.filter(name => !envValue(env, name));
  if (missing.length) throw new DiallerPolicyError("exotel_not_configured", `Employee dialler is missing required provider configuration: ${missing.join(", ")}`, 503);
  const callback = envValue(env, "PAWSPACE_DIALLER_STATUS_CALLBACK_URL");
  try { if (new URL(callback).protocol !== "https:") throw new Error("not https"); }
  catch { throw new DiallerPolicyError("callback_not_https", "PAWSPACE_DIALLER_STATUS_CALLBACK_URL must be HTTPS", 503); }
  const agentPhone = agentPhoneForActor(env, actorEmail);
  const callerId = callerIdForClass(env, callClass);
  if (mode === "uat") {
    const allow = uatAllowlist(env);
    if (!allow.length) throw new DiallerPolicyError("uat_allowlist_empty", "UAT employee dialling requires an explicit customer allowlist", 503);
    if (!allow.includes(normalisedDialKey(customerPhone))) throw new DiallerPolicyError("uat_recipient_not_allowlisted", "This customer number is not allowlisted for UAT dialling", 403);
  }
  return { mode, agentPhone, callerId, callback };
}

export function diallerReadiness(env: Env, asOf = Date.now()) {
  const mode = diallerMode(env);
  const callback = envValue(env, "PAWSPACE_DIALLER_STATUS_CALLBACK_URL");
  const missing = ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_WEBHOOK_SECRET", "PAWSPACE_DIALLER_AGENT_MAP_JSON", "EXOTEL_PROMO_CALLER_ID", "EXOTEL_SERVICE_CALLER_ID", "PAWSPACE_DIALLER_STATUS_CALLBACK_URL"].filter(name => !envValue(env, name));
  let callbackHttps = false;
  try { callbackHttps = Boolean(callback) && new URL(callback).protocol === "https:"; } catch {}
  return {
    mode,
    window: diallerWindow(asOf),
    uatApproved: envTrue(env, "PAWSPACE_DIALLER_UAT_APPROVED"),
    liveApproved: envTrue(env, "PAWSPACE_DIALLER_LIVE_APPROVED"),
    promotionalCallerIdValid: validCallerSeries(envValue(env, "EXOTEL_PROMO_CALLER_ID"), "promotional"),
    serviceCallerIdValid: validCallerSeries(envValue(env, "EXOTEL_SERVICE_CALLER_ID"), "service"),
    callbackHttps,
    uatAllowlistSize: uatAllowlist(env).length,
    missingConfiguration: missing,
    enabled: mode !== "disabled" && envTrue(env, "PAWSPACE_DIALLER_UAT_APPROVED") && (mode !== "live" || envTrue(env, "PAWSPACE_DIALLER_LIVE_APPROVED")) && callbackHttps && missing.length === 0,
  };
}

export async function ensureEmployeeDiallerTables(db: Db) {
  await Promise.all([ensureLeadScoringMergeTables(db), ensureCrmPipelineTables(db)]);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS employee_dialler_compliance (phone_key TEXT PRIMARY KEY,internal_dnd INTEGER NOT NULL DEFAULT 0,ncpr_dnd INTEGER NOT NULL DEFAULT 0,hard_suppressed INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL,reason TEXT,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS employee_dialler_consents (id TEXT PRIMARY KEY,phone_key TEXT NOT NULL,purpose TEXT NOT NULL,granted INTEGER NOT NULL,verified INTEGER NOT NULL,source TEXT NOT NULL,evidence_ref TEXT NOT NULL,captured_at INTEGER NOT NULL,expires_at INTEGER,revoked_at INTEGER,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS employee_dialler_consents_phone_idx ON employee_dialler_consents(phone_key,purpose,captured_at DESC)"),
    db.prepare("CREATE TABLE IF NOT EXISTS employee_dialler_calls (id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,customer_id TEXT NOT NULL,operator_email TEXT NOT NULL,agent_phone_last4 TEXT NOT NULL,customer_phone_last4 TEXT NOT NULL,call_class TEXT NOT NULL,caller_id_last4 TEXT NOT NULL,provider TEXT NOT NULL DEFAULT 'exotel',provider_call_id TEXT,state TEXT NOT NULL,provider_status TEXT,outcome TEXT,duration_seconds INTEGER,recording_url TEXT,policy_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,dialed_at INTEGER,connected_at INTEGER,ended_at INTEGER,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS employee_dialler_calls_lead_idx ON employee_dialler_calls(lead_id,created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS employee_dialler_calls_provider_idx ON employee_dialler_calls(provider_call_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS employee_dialler_events (id TEXT PRIMARY KEY,call_id TEXT NOT NULL,provider_event_id TEXT NOT NULL UNIQUE,event_kind TEXT NOT NULL,provider_status TEXT,payload_sha256 TEXT NOT NULL,duration_seconds INTEGER,recording_url TEXT,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS employee_dialler_dispositions (id TEXT PRIMARY KEY,call_id TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL,customer_id TEXT NOT NULL,disposition TEXT NOT NULL,callback_at INTEGER,note TEXT,actor_email TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS employee_dialler_lead_state (lead_id TEXT PRIMARY KEY,active_call_id TEXT,last_disposition TEXT,next_eligible_at INTEGER,terminal INTEGER NOT NULL DEFAULT 0,suppressed INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS employee_dialler_lead_state_queue_idx ON employee_dialler_lead_state(terminal,suppressed,next_eligible_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS employee_dialler_queue_skips (id TEXT PRIMARY KEY,lead_id TEXT,customer_id TEXT,reason_code TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  ]);
}

export async function upsertDiallerCompliance(db: Db, input: { phone: string; internalDnd?: boolean; ncprDnd?: boolean; hardSuppressed?: boolean; source: string; reason?: string | null; asOf?: number }) {
  await ensureEmployeeDiallerTables(db);
  const key = normalisedDialKey(input.phone);
  if (!key) throw new Error("A valid phone number is required");
  const now = input.asOf ?? Date.now();
  await db.prepare("INSERT INTO employee_dialler_compliance (phone_key,internal_dnd,ncpr_dnd,hard_suppressed,source,reason,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(phone_key) DO UPDATE SET internal_dnd=excluded.internal_dnd,ncpr_dnd=excluded.ncpr_dnd,hard_suppressed=excluded.hard_suppressed,source=excluded.source,reason=excluded.reason,updated_at=excluded.updated_at")
    .bind(key, input.internalDnd ? 1 : 0, input.ncprDnd ? 1 : 0, input.hardSuppressed ? 1 : 0, text(input.source) || "compliance_sync", text(input.reason) || null, now).run();
  return { phoneKey: key };
}

export async function recordDiallerConsent(db: Db, input: { phone: string; purpose?: string; source: string; evidenceRef: string; granted: boolean; verified: boolean; capturedAt: number; expiresAt?: number | null }) {
  await ensureEmployeeDiallerTables(db);
  const key = normalisedDialKey(input.phone);
  if (!key) throw new Error("A valid phone number is required");
  if (!Number.isFinite(input.capturedAt) || input.capturedAt <= 0) throw new Error("Consent requires a real capture timestamp");
  if (text(input.source).length < 3 || text(input.evidenceRef).length < 3) throw new Error("Consent requires a digital source and evidence reference");
  const id = uid("DCONSENT"), now = Date.now();
  await db.prepare("INSERT INTO employee_dialler_consents (id,phone_key,purpose,granted,verified,source,evidence_ref,captured_at,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, key, text(input.purpose) || "voice_marketing", input.granted ? 1 : 0, input.verified ? 1 : 0, text(input.source), text(input.evidenceRef), input.capturedAt, input.expiresAt ?? null, input.granted ? null : input.capturedAt, now).run();
  return { id, phoneKey: key, granted: input.granted, verified: input.verified };
}

async function complianceDecision(db: Db, input: { phone: string; leadOptOut: boolean; leadUpdatedAt: number; asOf: number }) {
  const phoneKey = normalisedDialKey(input.phone);
  const compliance = await db.prepare("SELECT * FROM employee_dialler_compliance WHERE phone_key=?").bind(phoneKey).first<Row>();
  const consent = await db.prepare("SELECT * FROM employee_dialler_consents WHERE phone_key=? AND purpose='voice_marketing' AND granted=1 AND verified=1 AND revoked_at IS NULL AND captured_at<=? AND (expires_at IS NULL OR expires_at>?) ORDER BY captured_at DESC LIMIT 1")
    .bind(phoneKey, input.asOf, input.asOf).first<Row>();
  const internalDnd = Number(compliance?.internal_dnd || 0) === 1;
  const ncprDnd = Number(compliance?.ncpr_dnd || 0) === 1;
  const hard = Number(compliance?.hard_suppressed || 0) === 1;
  const suppressionAt = Math.max(Number(compliance?.updated_at || 0), input.leadOptOut ? input.leadUpdatedAt : 0);
  const consentAt = Number(consent?.captured_at || 0);
  const freshConsent = Boolean(consent) && consentAt > suppressionAt;
  if (hard) return { allowed: false, phoneKey, code: "hard_suppressed", detail: "Number is permanently suppressed", consentAt };
  if ((internalDnd || ncprDnd || input.leadOptOut) && !freshConsent) {
    return { allowed: false, phoneKey, code: ncprDnd ? "ncpr_dnd" : internalDnd ? "internal_dnd" : "lead_opt_out", detail: "DND/opt-out requires newer verified digital consent", consentAt };
  }
  return { allowed: true, phoneKey, code: freshConsent ? "dnd_overridden_by_fresh_consent" : "clear", detail: freshConsent ? "Fresh verified digital consent is newer than suppression state" : "No active DND suppression", consentAt };
}

async function queueSkip(db: Db, leadId: string | null, customerId: string | null, reasonCode: string, detail: string, asOf: number) {
  await db.prepare("INSERT INTO employee_dialler_queue_skips (id,lead_id,customer_id,reason_code,detail,created_at) VALUES (?,?,?,?,?,?)")
    .bind(uid("DSKIP"), leadId, customerId, reasonCode, detail.slice(0, 240), asOf).run();
}

function candidateQuery() {
  return `SELECT l.id lead_id,l.customer_id,l.service,l.owner,l.status,l.opt_out,l.updated_at lead_updated_at,
    s.total_score,s.value_score,s.recency_score,s.factors_json,
    c.name,c.primary_phone,c.email,c.city_id,
    cc.pet_names,cc.pet_summary,cc.lifetime_value,cc.next_action contact_next_action,
    o.id opportunity_id,o.stage opportunity_stage,o.next_best_action,o.next_action_at,
    (SELECT r.suggested_offer FROM revenue_opportunities r WHERE r.lead_id=l.id AND r.status='ready' ORDER BY r.rank ASC,r.updated_at DESC LIMIT 1) suggested_offer
    FROM lead_work_items l
    JOIN lead_scores s ON s.lead_id=l.id
    JOIN canonical_customers c ON c.id=l.customer_id
    LEFT JOIN crm_contacts cc ON cc.id=l.customer_id
    LEFT JOIN crm_opportunities o ON o.lead_id=l.id AND o.status='open'
    LEFT JOIN employee_dialler_lead_state ds ON ds.lead_id=l.id
    WHERE s.total_score>=80 AND l.status NOT IN ('closed','merged')
      AND (ds.lead_id IS NULL OR (ds.terminal=0 AND ds.suppressed=0 AND ds.active_call_id IS NULL AND (ds.next_eligible_at IS NULL OR ds.next_eligible_at<=?)))
      AND NOT EXISTS (SELECT 1 FROM employee_dialler_calls ac WHERE ac.lead_id=l.id AND ac.state IN ('connecting_agent','dialling_customer','in_call'))
    ORDER BY s.total_score DESC,s.value_score DESC,s.recency_score DESC,l.updated_at DESC LIMIT 50`;
}

async function claimCandidate(db: Db, callId: string, asOf: number) {
  const candidates = rows(await db.prepare(candidateQuery()).bind(asOf).all<Row>());
  for (const candidate of candidates) {
    const leadId = text(candidate.lead_id), customerId = text(candidate.customer_id);
    const phone = canonicalDialNumber({}, candidate.primary_phone);
    if (!phone) { await queueSkip(db, leadId, customerId, "invalid_phone", "Customer primary phone cannot be normalised", asOf); continue; }
    const compliance = await complianceDecision(db, { phone, leadOptOut: Number(candidate.opt_out || 0) === 1, leadUpdatedAt: Number(candidate.lead_updated_at || 0), asOf });
    if (!compliance.allowed) { await queueSkip(db, leadId, customerId, compliance.code, compliance.detail, asOf); continue; }
    const claim = await db.prepare("INSERT INTO employee_dialler_lead_state (lead_id,active_call_id,last_disposition,next_eligible_at,terminal,suppressed,updated_at) VALUES (?,? ,NULL,NULL,0,0,?) ON CONFLICT(lead_id) DO UPDATE SET active_call_id=excluded.active_call_id,updated_at=excluded.updated_at WHERE employee_dialler_lead_state.active_call_id IS NULL AND employee_dialler_lead_state.terminal=0 AND employee_dialler_lead_state.suppressed=0 AND (employee_dialler_lead_state.next_eligible_at IS NULL OR employee_dialler_lead_state.next_eligible_at<=excluded.updated_at)")
      .bind(leadId, callId, asOf).run();
    if (Number(claim.meta?.changes || 0) !== 1) continue;
    return { candidate, phone, compliance };
  }
  return null;
}

function parsePayloadText(payload: unknown) {
  try {
    const parsed = typeof payload === "string" ? JSON.parse(payload) as Record<string, unknown> : payload as Record<string, unknown>;
    for (const key of ["text", "message", "body", "content", "reply"]) {
      const value = parsed?.[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
      if (value && typeof value === "object" && typeof (value as Record<string, unknown>).body === "string") return text((value as Record<string, unknown>).body).slice(0, 300);
    }
  } catch {}
  return "";
}

function ageFromSummary(summary: string) {
  const match = summary.match(/\b(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mos?)\b/i);
  return match ? `${match[1]} ${match[2]}` : null;
}

async function buildCustomerHud(db: Db, candidate: Row) {
  const customerId = text(candidate.customer_id);
  const pets = (await tableExists(db, "canonical_pets"))
    ? rows(await db.prepare("SELECT id,name,species,breed FROM canonical_pets WHERE customer_id=? ORDER BY created_at").bind(customerId).all<Row>())
    : [];
  const petSummary = text(candidate.pet_summary);
  const inferredAge = pets.length === 1 ? ageFromSummary(petSummary) : null;
  const bookingRows = (await tableExists(db, "canonical_bookings"))
    ? rows(await db.prepare("SELECT service_code,scheduled_start,status,total_amount,created_at FROM canonical_bookings WHERE customer_id=? AND status NOT IN ('cancelled','draft') ORDER BY scheduled_start DESC LIMIT 20").bind(customerId).all<Row>())
    : [];
  const times = bookingRows.map(row => Date.parse(text(row.scheduled_start)) || Number(row.created_at || 0)).filter(value => value > 0).sort((a, b) => b - a);
  let averageGapDays: number | null = null;
  if (times.length > 1) {
    let total = 0;
    for (let index = 0; index < times.length - 1; index++) total += Math.abs(times[index] - times[index + 1]) / 86_400_000;
    averageGapDays = Math.round((total / (times.length - 1)) * 10) / 10;
  }
  let aiContext: { direction: string; channel: string; text: string; at: number }[] = [];
  if (await tableExists(db, "communication_messages")) {
    const messages = rows(await db.prepare("SELECT direction,channel,payload_json,created_at FROM communication_messages WHERE customer_id=? ORDER BY created_at DESC LIMIT 6").bind(customerId).all<Row>());
    aiContext = messages.map(message => ({ direction: text(message.direction), channel: text(message.channel), text: parsePayloadText(message.payload_json), at: Number(message.created_at || 0) })).filter(message => message.text);
  }
  const factors = (() => { try { return JSON.parse(text(candidate.factors_json) || "{}"); } catch { return {}; } })();
  const nextBestAction = text(candidate.next_best_action) || text(candidate.contact_next_action) || "Review the customer's latest requirement";
  const pitch = text(candidate.suggested_offer) || nextBestAction;
  return {
    customerId,
    name: text(candidate.name) || "Customer",
    phoneLast4: normalisedDialKey(candidate.primary_phone).slice(-4),
    pets: pets.map((pet, index) => ({ id: text(pet.id), name: text(pet.name), species: text(pet.species), breed: text(pet.breed) || "Not captured", age: index === 0 ? inferredAge : null })),
    petSummary: petSummary || text(candidate.pet_names) || null,
    bookingCadence: { bookingCount: bookingRows.length, lastServiceAt: times[0] || null, averageGapDays, recentServices: bookingRows.slice(0, 5).map(row => text(row.service_code)).filter(Boolean) },
    lifetimeValue: Number(candidate.lifetime_value || (factors as Record<string, unknown>).historicalValue || 0),
    lead: { id: text(candidate.lead_id), service: text(candidate.service), owner: text(candidate.owner), score: Number(candidate.total_score || 0), valueScore: Number(candidate.value_score || 0), recencyScore: Number(candidate.recency_score || 0), opportunityStage: text(candidate.opportunity_stage) || null },
    aiContext,
    nextBestAction,
    recommendedPitch: pitch,
  };
}

async function readProviderText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > MAX_PROVIDER_RESPONSE_BYTES) throw new DiallerPolicyError("provider_response_too_large", "Exotel returned an oversized response", 502);
    chunks.push(value);
  }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

function exotelResponse(raw: string) {
  let providerCallId = "", providerStatus = "";
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const call = (json.Call || json.call || json) as Record<string, unknown>;
    providerCallId = text(call?.Sid || call?.sid || call?.CallSid || call?.call_sid);
    providerStatus = text(call?.Status || call?.status || call?.CallStatus || call?.call_status);
  } catch {
    providerCallId = raw.match(/<(?:Sid|CallSid)>([^<]+)<\/(?:Sid|CallSid)>/i)?.[1] || "";
    providerStatus = raw.match(/<(?:Status|CallStatus)>([^<]+)<\/(?:Status|CallStatus)>/i)?.[1] || "";
  }
  return { providerCallId, providerStatus };
}

async function connectExotel(env: Env, input: { agentPhone: string; customerPhone: string; callerId: string; callbackUrl: string; callId: string; fetcher?: Fetcher }) {
  const sid = envValue(env, "EXOTEL_SID"), key = envValue(env, "EXOTEL_API_KEY"), token = envValue(env, "EXOTEL_API_TOKEN");
  const subdomain = envValue(env, "EXOTEL_SUBDOMAIN") || "api.in.exotel.com";
  const endpoint = `https://${subdomain}/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect`;
  const body = new URLSearchParams({
    From: input.agentPhone,
    To: input.customerPhone,
    CallerId: input.callerId,
    StatusCallback: input.callbackUrl,
    "StatusCallbackEvents[0]": "terminal",
    "StatusCallbackEvents[1]": "answered",
    "StatusCallbackEvents[2]": "ringing",
    CustomField: input.callId,
  });
  if (envTrue(env, "PAWSPACE_VOICE_RECORDING_APPROVED")) body.set("Record", "true");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXOTEL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetcher || fetch)(endpoint, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${key}:${token}`)}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    throw new DiallerPolicyError("exotel_unreachable", error instanceof Error && error.name === "AbortError" ? "Exotel connect request timed out" : "Exotel connect request failed", 502);
  } finally { clearTimeout(timer); }
  const raw = await readProviderText(response);
  const parsed = exotelResponse(raw);
  if (!response.ok || !parsed.providerCallId) throw new DiallerPolicyError("exotel_rejected", `Exotel rejected the connect request with HTTP ${response.status}`, 502);
  return parsed;
}

export async function startNextDiallerCall(db: Db, env: Env, input: { actorEmail: string; asOf?: number; fetcher?: Fetcher }) {
  await ensureEmployeeDiallerTables(db);
  const now = input.asOf ?? Date.now();
  const window = diallerWindow(now);
  if (!window.open) throw new DiallerPolicyError("outside_calling_window", "Outbound employee calls are permitted only from 09:00 to 21:00 IST", 409);
  const callId = uid("DCALL");
  const claimed = await claimCandidate(db, callId, now);
  if (!claimed) return { queueEmpty: true, call: null, customer: null };
  const { candidate, phone: customerPhone, compliance } = claimed;
  const callClass: DiallerCallClass = "promotional";
  let gate: ReturnType<typeof requireDiallerGate>;
  try { gate = requireDiallerGate(env, input.actorEmail, customerPhone, callClass); }
  catch (error) {
    await db.prepare("UPDATE employee_dialler_lead_state SET active_call_id=NULL,updated_at=? WHERE lead_id=? AND active_call_id=?").bind(now, candidate.lead_id, callId).run();
    throw error;
  }
  const policy = { window, complianceCode: compliance.code, consentCapturedAt: compliance.consentAt || null, callClass, callerSeries: callClass === "promotional" ? "140" : "160" };
  await db.prepare("INSERT INTO employee_dialler_calls (id,lead_id,customer_id,operator_email,agent_phone_last4,customer_phone_last4,call_class,caller_id_last4,provider,state,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'exotel','connecting_agent',?,?,?)")
    .bind(callId, candidate.lead_id, candidate.customer_id, input.actorEmail, normalisedDialKey(gate.agentPhone).slice(-4), normalisedDialKey(customerPhone).slice(-4), callClass, digits(gate.callerId).slice(-4), JSON.stringify(policy), now, now).run();
  try {
    const provider = await connectExotel(env, { agentPhone: gate.agentPhone, customerPhone, callerId: gate.callerId, callbackUrl: gate.callback, callId, fetcher: input.fetcher });
    await db.prepare("UPDATE employee_dialler_calls SET provider_call_id=?,provider_status=?,dialed_at=?,updated_at=? WHERE id=?")
      .bind(provider.providerCallId, provider.providerStatus || "initiated", now, now, callId).run();
  } catch (error) {
    await db.batch([
      db.prepare("UPDATE employee_dialler_calls SET state='call_ended',outcome='failed',provider_status='connect_failed',ended_at=?,updated_at=? WHERE id=?").bind(now, now, callId),
      db.prepare("UPDATE employee_dialler_lead_state SET active_call_id=NULL,next_eligible_at=?,updated_at=? WHERE lead_id=? AND active_call_id=?").bind(now + 15 * 60_000, now, candidate.lead_id, callId),
    ]);
    throw error;
  }
  const call = await getDiallerCall(db, callId);
  return { queueEmpty: false, call: call.call, customer: await buildCustomerHud(db, candidate) };
}

function callSummary(row: Row) {
  return {
    id: text(row.id), leadId: text(row.lead_id), customerId: text(row.customer_id), operatorEmail: text(row.operator_email),
    state: text(row.state) as DiallerCallState, providerCallId: row.provider_call_id ? text(row.provider_call_id) : null,
    providerStatus: row.provider_status ? text(row.provider_status) : null, outcome: row.outcome ? text(row.outcome) : null,
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds), recordingUrl: row.recording_url ? text(row.recording_url) : null,
    callClass: text(row.call_class), customerPhoneLast4: text(row.customer_phone_last4), createdAt: Number(row.created_at || 0), dialedAt: row.dialed_at == null ? null : Number(row.dialed_at), connectedAt: row.connected_at == null ? null : Number(row.connected_at), endedAt: row.ended_at == null ? null : Number(row.ended_at),
  };
}

export async function getDiallerCall(db: Db, callId: string) {
  await ensureEmployeeDiallerTables(db);
  const row = await db.prepare("SELECT * FROM employee_dialler_calls WHERE id=?").bind(callId).first<Row>();
  if (!row) throw new DiallerPolicyError("call_not_found", "Dialler call was not found", 404);
  return { call: callSummary(row) };
}

export async function applyDiallerCallback(db: Db, env: Env, input: { rawBody: string; headers: Headers; asOf?: number }) {
  await ensureEmployeeDiallerTables(db);
  const secret = envValue(env, "EXOTEL_WEBHOOK_SECRET"), now = input.asOf ?? Date.now();
  const verification = await verifyVoiceWebhookSignature(secret, input.rawBody, input.headers, now);
  if (!verification.verified) throw new DiallerPolicyError("invalid_exotel_callback", "Exotel callback authentication failed", 401);
  const event = normaliseTelephonyEvent(input.rawBody, "exotel");
  const payloadHash = await sha256Hex(input.rawBody);
  let call = event.callRef ? await db.prepare("SELECT * FROM employee_dialler_calls WHERE id=?").bind(event.callRef).first<Row>() : null;
  if (!call && event.providerCallId) call = await db.prepare("SELECT * FROM employee_dialler_calls WHERE provider_call_id=? ORDER BY created_at DESC LIMIT 1").bind(event.providerCallId).first<Row>();
  if (!call) throw new DiallerPolicyError("callback_call_not_found", "Exotel callback does not match a dialler call", 404);
  const eventId = `${event.providerEventId}:${payloadHash.slice(0, 16)}`;
  const inserted = await db.prepare("INSERT OR IGNORE INTO employee_dialler_events (id,call_id,provider_event_id,event_kind,provider_status,payload_sha256,duration_seconds,recording_url,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(uid("DEVT"), call.id, eventId, event.kind, event.providerStatus || null, payloadHash, event.durationSeconds, event.recordingRef, now).run();
  if (Number(inserted.meta?.changes || 0) === 0) return { duplicate: true, call: callSummary(call) };
  let state = text(call.state) as DiallerCallState;
  let outcome = call.outcome ? text(call.outcome) : null;
  let connectedAt = call.connected_at == null ? null : Number(call.connected_at);
  let endedAt = call.ended_at == null ? null : Number(call.ended_at);
  if (event.kind === "connected") {
    const connected = await db.prepare("SELECT COUNT(*) n FROM employee_dialler_events WHERE call_id=? AND event_kind='connected'").bind(call.id).first<Row>();
    const count = Number(connected?.n || 0);
    state = count >= 2 ? "in_call" : "dialling_customer";
    if (count >= 2 && connectedAt == null) connectedAt = now;
  } else if (["completed", "busy", "no_answer", "failed"].includes(event.kind)) {
    state = "call_ended";
    outcome = event.kind === "no_answer" ? "no-answer" : event.kind;
    endedAt = now;
  }
  await db.prepare("UPDATE employee_dialler_calls SET provider_call_id=COALESCE(provider_call_id,?),state=?,provider_status=?,outcome=?,duration_seconds=COALESCE(?,duration_seconds),recording_url=COALESCE(?,recording_url),connected_at=?,ended_at=?,updated_at=? WHERE id=?")
    .bind(event.providerCallId, state, event.providerStatus || event.kind, outcome, event.durationSeconds, event.recordingRef, connectedAt, endedAt, now, call.id).run();
  if (state === "call_ended") {
    await db.prepare("UPDATE employee_dialler_lead_state SET active_call_id=NULL,updated_at=? WHERE lead_id=? AND active_call_id=?").bind(now, call.lead_id, call.id).run();
  }
  const updated = await db.prepare("SELECT * FROM employee_dialler_calls WHERE id=?").bind(call.id).first<Row>();
  return { duplicate: false, call: callSummary(updated || call) };
}

function dispositionPlan(disposition: DiallerDisposition, now: number, callbackAt?: number | null) {
  if (disposition === "Callback Scheduled") {
    if (!callbackAt || callbackAt <= now) throw new DiallerPolicyError("callback_time_invalid", "Callback Scheduled requires a future callback time", 400);
    return { terminal: false, nextEligibleAt: callbackAt, nextAction: `Call back at ${new Date(callbackAt).toISOString()}`, createTask: true };
  }
  if (disposition === "No Answer") return { terminal: false, nextEligibleAt: now + 4 * 60 * 60_000, nextAction: "Retry employee call after no-answer cooldown", createTask: false };
  if (disposition === "Interested") return { terminal: true, nextEligibleAt: null, nextAction: "Human follow-up: interested customer", createTask: true };
  if (disposition === "Booked") return { terminal: true, nextEligibleAt: null, nextAction: "Verify and attach canonical booking before marking opportunity won", createTask: true };
  if (disposition === "Not Interested") return { terminal: true, nextEligibleAt: null, nextAction: "Do not continue this sales sequence", createTask: false };
  if (disposition === "Wrong Number") return { terminal: true, nextEligibleAt: null, nextAction: "Correct customer phone before any future outreach", createTask: true };
  return { terminal: true, nextEligibleAt: null, nextAction: "Suppressed from employee outbound dialling", createTask: false };
}

export async function submitDiallerDisposition(db: Db, input: { callId: string; actorEmail: string; disposition: DiallerDisposition; callbackAt?: number | null; note?: string | null; asOf?: number }) {
  await ensureEmployeeDiallerTables(db);
  if (!DIALLER_DISPOSITIONS.includes(input.disposition)) throw new DiallerPolicyError("invalid_disposition", "Unsupported dialler disposition", 400);
  const now = input.asOf ?? Date.now();
  const call = await db.prepare("SELECT * FROM employee_dialler_calls WHERE id=?").bind(input.callId).first<Row>();
  if (!call) throw new DiallerPolicyError("call_not_found", "Dialler call was not found", 404);
  if (text(call.operator_email).toLowerCase() !== input.actorEmail.toLowerCase()) throw new DiallerPolicyError("operator_mismatch", "Only the operator who placed this call may disposition it", 403);
  if (text(call.state) !== "call_ended") throw new DiallerPolicyError("call_not_ended", "The call must end before a disposition is submitted", 409);
  const existing = await db.prepare("SELECT id FROM employee_dialler_dispositions WHERE call_id=?").bind(input.callId).first<Row>();
  if (existing) throw new DiallerPolicyError("already_dispositioned", "This call already has a disposition", 409);
  const plan = dispositionPlan(input.disposition, now, input.callbackAt);
  const leadId = text(call.lead_id), customerId = text(call.customer_id);
  const lead = await db.prepare("SELECT call_attempts FROM lead_work_items WHERE id=?").bind(leadId).first<Row>();
  const sequence = Number(lead?.call_attempts || 0) + 1;
  await db.batch([
    db.prepare("INSERT INTO employee_dialler_dispositions (id,call_id,lead_id,customer_id,disposition,callback_at,note,actor_email,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(uid("DDISP"), input.callId, leadId, customerId, input.disposition, input.callbackAt ?? null, text(input.note) || null, input.actorEmail, now),
    db.prepare("UPDATE employee_dialler_lead_state SET active_call_id=NULL,last_disposition=?,next_eligible_at=?,terminal=?,suppressed=?,updated_at=? WHERE lead_id=?").bind(input.disposition, plan.nextEligibleAt, plan.terminal ? 1 : 0, input.disposition === "DND / Suppress" || input.disposition === "Wrong Number" ? 1 : 0, now, leadId),
    db.prepare("UPDATE lead_work_items SET last_outcome=?,call_attempts=COALESCE(call_attempts,0)+1,next_action_at=?,updated_at=? WHERE id=?").bind(input.disposition, plan.nextEligibleAt, now, leadId),
    db.prepare("INSERT INTO lead_attempts (id,lead_id,channel,sequence_number,outcome,note,provider_status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(uid("LATT"), leadId, "employee_dialler", sequence, input.disposition, text(input.note) || null, text(call.provider_status) || text(call.outcome) || "completed", input.actorEmail, now),
  ]);
  if (await tableExists(db, "crm_contacts")) {
    await db.prepare("UPDATE crm_contacts SET next_action=?,updated_at=? WHERE id=?").bind(plan.nextAction, now, customerId).run();
  }
  if (await tableExists(db, "crm_opportunities")) {
    await db.prepare("UPDATE crm_opportunities SET next_best_action=?,next_action_at=?,updated_at=? WHERE lead_id=? AND status='open'").bind(plan.nextAction, plan.nextEligibleAt, now, leadId).run();
  }
  if (await tableExists(db, "crm_activities")) {
    await db.prepare("INSERT INTO crm_activities (id,contact_id,type,title,detail,created_at) VALUES (?,?,?,?,?,?)")
      .bind(uid("ACT"), customerId, "call", `Employee dialler: ${input.disposition}`, text(input.note) || `Call ${input.callId}`, now).run();
  }
  if (plan.createTask && await tableExists(db, "crm_tasks")) {
    await db.prepare("INSERT INTO crm_tasks (id,contact_id,title,owner,due_at,priority,status,created_at) VALUES (?,?,?,?,?,'High','Open',?)")
      .bind(uid("TASK"), customerId, plan.nextAction, input.actorEmail, plan.nextEligibleAt ?? now, now).run();
  }
  const customer = await db.prepare("SELECT primary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();
  if (input.disposition === "DND / Suppress" && customer?.primary_phone) {
    await upsertDiallerCompliance(db, { phone: text(customer.primary_phone), internalDnd: true, ncprDnd: false, hardSuppressed: false, source: "employee_disposition", reason: "Customer requested DND / suppress", asOf: now });
  }
  if (input.disposition === "Wrong Number" && customer?.primary_phone) {
    await upsertDiallerCompliance(db, { phone: text(customer.primary_phone), internalDnd: true, ncprDnd: false, hardSuppressed: true, source: "employee_disposition", reason: "Wrong number", asOf: now });
  }
  const score = await scoreLead(db, leadId);
  return { disposition: input.disposition, nextEligibleAt: plan.nextEligibleAt, terminal: plan.terminal, nextBestAction: plan.nextAction, leadScore: score };
}
