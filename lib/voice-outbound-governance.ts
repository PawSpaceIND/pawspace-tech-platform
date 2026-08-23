/**
 * Outbound voice calling: the pre-dial policy gate, the call ledger, and the provider-event receiver.
 *
 * Nothing in this codebase could place a call before this module. `VoiceTransportProvider` was a union
 * of two strings; `startAiVoiceUatCall` took `consent: boolean` straight from the request body and
 * wrote 'verified' into the row. So the only consent record was the caller asserting it, there was no
 * opt-out check, no quiet-hours check, no frequency cap, no allow-list, no environment gate and no
 * provider. This module is the missing half: what must be TRUE before a number is dialled, proved
 * against stored records rather than asserted by the caller, and written down whether it passed or not.
 *
 * Design rules it holds to:
 *   - Voice is off unless the ENVIRONMENT says otherwise (lib/voice-call-gate.ts). No request field of
 *     any kind can enable it.
 *   - Every refusal is a row. A blocked call is as auditable as a completed one, and it is terminal:
 *     the state machine makes blocked_* unreachable from anywhere except policy_check, so a blocked
 *     call in the ledger is proof the gate ran before any dial.
 *   - The conversation itself stays on the existing governed AI layer (lib/ai-conversation-orchestrator
 *     via lib/ai-voice-uat.ts). This module starts and ends calls; it is not a second agent, and it
 *     cannot move money, change a price or confirm a refund - it has no such operation.
 *   - Provider callbacks are signature-verified and deduplicated, and only curated fields are stored.
 *     The raw body is kept as a SHA-256 hash, never as content.
 */

import { createUnifiedCase } from "./unified-case-center";
import { ensureCommunicationTables, seedCommunicationPolicy, type CommunicationPurpose } from "./communication-engine";
import { canonicalDialNumber, normalisedDialKey, resolveVoiceCallGate, salesOutboundApproved, callRecordingApproved, statusCallbackUrl, voiceCallReadiness, voiceMode } from "./voice-call-gate";
import { assertVoiceCallTransition, canVoiceCallTransition, isVoiceCallState, voiceFailureReasonClass, VOICE_RETRYABLE_STATES, type VoiceCallState } from "./voice-call-state";
import { selectTelephonyProvider, sha256Hex, telephonyProviderStatus, TelephonyProviderUnavailable, type TelephonyEventKind, type TelephonyProvider } from "./voice-telephony-provider";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const IST_OFFSET_MINUTES = 330;

// --- use-case catalogue ----------------------------------------------------------------------------

export type VoiceUseCaseDefinition = {
  code: string;
  label: string;
  /** Reuses the platform's existing consent/quiet-hours vocabulary rather than inventing a second one. */
  purpose: CommunicationPurpose;
  requiresBooking: boolean;
  /** Outbound sales/pitching is a separate business approval, off by default. */
  requiresSalesApproval: boolean;
  maxAttempts: number;
};

/**
 * The only use cases an automated call may be placed for. There is deliberately no "other": an
 * unrecognised use case is refused, so a new outbound campaign is a reviewed change here rather than
 * a free-text string somebody puts in a request body.
 *
 * No use case is exempt from quiet hours. A genuinely urgent situation is a human picking up a phone,
 * not a bot dialling at 02:00.
 */
export const VOICE_USE_CASES: VoiceUseCaseDefinition[] = [
  { code: "booking_confirmation", label: "Confirm a booking the customer already made", purpose: "transactional", requiresBooking: true, requiresSalesApproval: false, maxAttempts: 2 },
  { code: "service_reminder", label: "Remind about an upcoming confirmed service", purpose: "transactional", requiresBooking: true, requiresSalesApproval: false, maxAttempts: 2 },
  { code: "service_recovery", label: "Follow up on a service failure or complaint", purpose: "service_recovery", requiresBooking: true, requiresSalesApproval: false, maxAttempts: 3 },
  { code: "payment_recovery", label: "Follow up on an unpaid confirmed booking", purpose: "service_recovery", requiresBooking: true, requiresSalesApproval: false, maxAttempts: 3 },
  { code: "feedback_request", label: "Ask for feedback after a completed service", purpose: "lifecycle", requiresBooking: true, requiresSalesApproval: false, maxAttempts: 1 },
  { code: "lead_qualification", label: "Qualify an inbound enquiry", purpose: "marketing", requiresBooking: false, requiresSalesApproval: true, maxAttempts: 2 },
  { code: "sales_pitch", label: "Outbound sales / pitching call", purpose: "marketing", requiresBooking: false, requiresSalesApproval: true, maxAttempts: 1 },
];

export const voiceUseCase = (code: unknown) => VOICE_USE_CASES.find(entry => entry.code === text(code)) || null;

/**
 * Claim words a script may not contain unless a human has explicitly approved that script's claims.
 * A bot promising a discount, a refund or a guarantee is a commitment nobody authorised, and it is the
 * exact failure mode "no autonomous payment/refund/price commitment" is about.
 */
const RESTRICTED_SCRIPT_CLAIMS = ["free", "refund", "guarantee", "guaranteed", "cashback", "discount", "offer", "lowest price", "money back", "%", "₹", "rs.", "inr"];

// --- schema ---------------------------------------------------------------------------------------

export async function ensureVoiceCallTables(db: Db) {
  await ensureCommunicationTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_orders (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,direction TEXT NOT NULL,use_case TEXT NOT NULL,purpose TEXT NOT NULL,campaign_id TEXT,customer_id TEXT,lead_id TEXT,booking_id TEXT,city_id TEXT NOT NULL,phone_key TEXT NOT NULL,phone_last4 TEXT NOT NULL,dial_number TEXT NOT NULL,mode TEXT NOT NULL,provider TEXT NOT NULL,production_call INTEGER NOT NULL DEFAULT 0,provider_call_id TEXT,ai_call_id TEXT,state TEXT NOT NULL,previous_state TEXT,failure_reason_class TEXT,failure_detail TEXT,consent_decision TEXT NOT NULL DEFAULT 'unknown',opt_out_decision TEXT NOT NULL DEFAULT 'unknown',quiet_hours_decision TEXT NOT NULL DEFAULT 'unknown',frequency_attempts_24h INTEGER NOT NULL DEFAULT 0,recording_allowed INTEGER NOT NULL DEFAULT 0,retry_of TEXT,retry_attempt INTEGER NOT NULL DEFAULT 0,handoff_case_id TEXT,transcript_ref TEXT,recording_ref TEXT,requested_by TEXT NOT NULL,requested_at INTEGER NOT NULL,dialed_at INTEGER,connected_at INTEGER,ended_at INTEGER,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_call_orders_phone ON voice_call_orders(phone_key,requested_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_call_orders_state ON voice_call_orders(state,requested_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_call_orders_retry ON voice_call_orders(retry_of)"),
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_state_transitions (id TEXT PRIMARY KEY,call_id TEXT NOT NULL,sequence INTEGER NOT NULL,from_state TEXT,to_state TEXT NOT NULL,reason TEXT,reason_class TEXT,detail_json TEXT NOT NULL DEFAULT '{}',actor TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(call_id,sequence))"),
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_policy_decisions (id TEXT PRIMARY KEY,call_id TEXT NOT NULL,check_code TEXT NOT NULL,passed INTEGER NOT NULL,detail TEXT,created_at INTEGER NOT NULL,UNIQUE(call_id,check_code))"),
    // curated_json holds only the fields lib/voice-telephony-provider.ts normalises. payload_sha256 is
    // the whole provider body reduced to a digest, so a callback can be proved without storing it.
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_provider_events (id TEXT PRIMARY KEY,call_id TEXT,provider TEXT NOT NULL,provider_event_id TEXT NOT NULL,event_kind TEXT NOT NULL,provider_status TEXT,signature_mechanism TEXT,payload_sha256 TEXT NOT NULL,curated_json TEXT NOT NULL DEFAULT '{}',applied INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(provider,provider_event_id))"),
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_consents (phone_key TEXT PRIMARY KEY,subject_type TEXT NOT NULL,subject_id TEXT,granted INTEGER NOT NULL,source TEXT NOT NULL,captured_by TEXT NOT NULL,captured_at INTEGER NOT NULL,revoked_at INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_opt_outs (phone_key TEXT PRIMARY KEY,source TEXT NOT NULL,reason TEXT,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL)"),
    // The frequency cap's ENFORCEMENT point, separate from the ledger so it can be claimed atomically
    // before the provider is contacted. The count in evaluateVoiceCallPolicy is the advisory read that
    // produces a good audit message; this table is what actually bounds concurrent dials.
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_dial_reservations (call_id TEXT PRIMARY KEY,phone_key TEXT NOT NULL,reserved_at INTEGER NOT NULL,released_at INTEGER)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_dial_reservations_phone ON voice_call_dial_reservations(phone_key,released_at,reserved_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS voice_call_scripts (use_case TEXT PRIMARY KEY,opening_disclosure TEXT NOT NULL,body_json TEXT NOT NULL DEFAULT '[]',claims_approved INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  ]);
}

/**
 * The opening the customer hears, as DATA. It identifies PawSpace by name, says plainly that this is an
 * automated assistant, offers a human, and offers an opt-out - and it lives in a table an operator can
 * change under review rather than in a string literal inside the dialler.
 */
export async function seedVoiceCallScripts(db: Db, actorId = "voice_seed") {
  await ensureVoiceCallTables(db);
  const now = Date.now();
  for (const useCase of VOICE_USE_CASES) {
    const disclosure = `Hello, this is PawSpace's automated voice assistant calling about your ${useCase.code.replace(/_/g, " ")}. This call may be handled by an automated system. Say "agent" at any time to speak to a PawSpace team member, or say "do not call" and we will stop calling this number.`;
    await db.prepare("INSERT OR IGNORE INTO voice_call_scripts (use_case,opening_disclosure,body_json,claims_approved,active,version,updated_by,updated_at) VALUES (?,?,?,0,1,1,?,?)")
      .bind(useCase.code, disclosure, "[]", actorId, now).run();
  }
}

/** Every script is validated the same way, whether seeded or supplied by an operator. */
export function validateVoiceScript(input: { openingDisclosure: string; body?: string[]; claimsApproved?: boolean }) {
  const disclosure = text(input.openingDisclosure);
  if (disclosure.length < 40) throw new Error("The opening disclosure must actually introduce the call");
  if (!/pawspace/i.test(disclosure)) throw new Error("The opening disclosure must identify PawSpace by name");
  if (!/automated|recorded|assistant|bot/i.test(disclosure)) throw new Error("The opening disclosure must state that the call is automated");
  if (!/agent|human|team member/i.test(disclosure)) throw new Error("The opening disclosure must offer a route to a human");
  if (!/do not call|opt out|stop calling|unsubscribe/i.test(disclosure)) throw new Error("The opening disclosure must offer an opt-out");
  const combined = [disclosure, ...(input.body || [])].join(" \n ").toLowerCase();
  if (!input.claimsApproved) {
    const found = RESTRICTED_SCRIPT_CLAIMS.filter(claim => combined.includes(claim));
    if (found.length) throw new Error(`Script makes price/refund/offer claims that need explicit approval: ${found.join(", ")}`);
  }
  return { openingDisclosure: disclosure, body: input.body || [], claimsApproved: Boolean(input.claimsApproved) };
}

export async function setVoiceCallScript(db: Db, input: { useCase: string; openingDisclosure: string; body?: string[]; claimsApproved?: boolean; active?: boolean; actorId: string }) {
  await ensureVoiceCallTables(db);
  if (!voiceUseCase(input.useCase)) throw new Error(`Unsupported voice use case: ${text(input.useCase)}`);
  const script = validateVoiceScript(input);
  const now = Date.now();
  const prior = await db.prepare("SELECT version FROM voice_call_scripts WHERE use_case=?").bind(input.useCase).first<Row>();
  await db.prepare("INSERT INTO voice_call_scripts (use_case,opening_disclosure,body_json,claims_approved,active,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(use_case) DO UPDATE SET opening_disclosure=excluded.opening_disclosure,body_json=excluded.body_json,claims_approved=excluded.claims_approved,active=excluded.active,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(input.useCase, script.openingDisclosure, JSON.stringify(script.body), script.claimsApproved ? 1 : 0, input.active === false ? 0 : 1, Number(prior?.version || 0) + 1, input.actorId, now).run();
  return { useCase: input.useCase, version: Number(prior?.version || 0) + 1, active: input.active !== false };
}

// --- consent / opt-out records --------------------------------------------------------------------

export async function recordVoiceConsent(db: Db, input: { phone: string; subjectType: "customer" | "lead"; subjectId?: string | null; granted: boolean; source: string; actorId: string; asOf?: number }) {
  await ensureVoiceCallTables(db);
  const phoneKey = normalisedDialKey(input.phone);
  if (!phoneKey) throw new Error("A real phone number is required to record voice consent");
  if (text(input.source).length < 4) throw new Error("Voice consent needs a real source (where the customer gave it)");
  const now = input.asOf ?? Date.now();
  await db.prepare("INSERT INTO voice_call_consents (phone_key,subject_type,subject_id,granted,source,captured_by,captured_at,revoked_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(phone_key) DO UPDATE SET subject_type=excluded.subject_type,subject_id=excluded.subject_id,granted=excluded.granted,source=excluded.source,captured_by=excluded.captured_by,captured_at=excluded.captured_at,revoked_at=excluded.revoked_at")
    .bind(phoneKey, input.subjectType, text(input.subjectId) || null, input.granted ? 1 : 0, text(input.source), input.actorId, now, input.granted ? null : now).run();
  return { phoneKey, granted: input.granted };
}

/**
 * An opt-out is immediate and permanent for that number, and it also revokes consent - so a later
 * consent row cannot quietly reopen a number somebody asked us to stop calling without a new,
 * explicitly captured consent.
 */
export async function recordVoiceOptOut(db: Db, input: { phone: string; source: string; reason?: string | null; actorId: string; asOf?: number }) {
  await ensureVoiceCallTables(db);
  const phoneKey = normalisedDialKey(input.phone);
  if (!phoneKey) throw new Error("A real phone number is required to record a voice opt-out");
  const now = input.asOf ?? Date.now();
  await db.batch([
    db.prepare("INSERT INTO voice_call_opt_outs (phone_key,source,reason,recorded_by,recorded_at) VALUES (?,?,?,?,?) ON CONFLICT(phone_key) DO UPDATE SET source=excluded.source,reason=excluded.reason,recorded_by=excluded.recorded_by,recorded_at=excluded.recorded_at")
      .bind(phoneKey, text(input.source) || "voice_call", text(input.reason) || null, input.actorId, now),
    db.prepare("UPDATE voice_call_consents SET granted=0,revoked_at=? WHERE phone_key=?").bind(now, phoneKey),
  ]);
  return { phoneKey, optedOut: true };
}

// --- policy gate ----------------------------------------------------------------------------------

export type VoicePolicyCheck = { code: string; passed: boolean; blockedState: VoiceCallState; detail: string };

export type VoiceCallRequest = {
  idempotencyKey: string;
  useCase: string;
  phone: string;
  cityId: string;
  customerId?: string | null;
  leadId?: string | null;
  bookingId?: string | null;
  campaignId?: string | null;
  actorId: string;
  actorPermissions: string[];
  simulatedOutcome?: TelephonyEventKind | null;
  statusCallbackUrl?: string | null;
  retryOf?: string | null;
  retryAttempt?: number;
  asOf?: number;
};

function inQuietHours(hour: number, start: number, end: number) { return start > end ? hour >= start || hour < end : hour >= start && hour < end; }

async function quietHoursPolicy(db: Db, cityId: string) {
  await seedCommunicationPolicy(db);
  const date = new Date().toISOString().slice(0, 10);
  const row = await db.prepare("SELECT quiet_start_hour,quiet_end_hour,promotional_cap_7d,max_attempts FROM communication_policies WHERE city_id=? AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY version DESC LIMIT 1").bind(cityId, date, date).first<Row>();
  // No policy row for this city means we do NOT know this city's rules, so the conservative default
  // applies rather than "no restriction".
  return row
    ? { quietStart: Number(row.quiet_start_hour), quietEnd: Number(row.quiet_end_hour), promotionalCap7d: Number(row.promotional_cap_7d), maxAttempts: Number(row.max_attempts), source: "city_policy" }
    : { quietStart: 21, quietEnd: 8, promotionalCap7d: 1, maxAttempts: 1, source: "conservative_default" };
}

/**
 * Everything that must be true before a number is dialled, evaluated against stored records. Every
 * check runs even after one has failed, so the audit shows the whole picture; the state the call lands
 * in comes from the FIRST failure in this order.
 */
export async function evaluateVoiceCallPolicy(db: Db, env: Env, input: VoiceCallRequest) {
  await ensureVoiceCallTables(db);
  await seedVoiceCallScripts(db);
  const now = input.asOf ?? Date.now();
  const checks: VoicePolicyCheck[] = [];
  const add = (code: string, passed: boolean, blockedState: VoiceCallState, detail: string) => { checks.push({ code, passed, blockedState, detail }); return passed; };

  const gate = resolveVoiceCallGate(env);
  add("voice_enabled", gate.ok, "blocked_disabled", gate.ok ? `Voice enabled in ${gate.mode} mode` : gate.reason);

  // The route enforces this too; recording it here means the ledger shows WHY a call was refused even
  // when the refusal came from authority rather than from the recipient's preferences.
  const permitted = input.actorPermissions.includes("*") || (input.actorPermissions.includes("communications.call") && input.actorPermissions.includes("customers.manage"));
  add("caller_authority", permitted, "blocked_permission", permitted ? "Caller holds communications.call and customers.manage" : "Caller may not launch automated voice calls");

  const useCase = voiceUseCase(input.useCase);
  const useCaseOk = Boolean(useCase) && (!useCase!.requiresSalesApproval || salesOutboundApproved(env)) && (!useCase!.requiresBooking || Boolean(text(input.bookingId)));
  add("use_case_approved", useCaseOk, "blocked_use_case",
    !useCase ? `Unsupported voice use case: ${text(input.useCase)}`
      : useCase.requiresSalesApproval && !salesOutboundApproved(env) ? `Outbound sales calling is not approved (PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED)`
        : useCase.requiresBooking && !text(input.bookingId) ? `${useCase.code} may only be placed about a specific booking`
          : `${useCase.code} approved`);

  const script = useCase ? await db.prepare("SELECT opening_disclosure,body_json,claims_approved,active FROM voice_call_scripts WHERE use_case=? AND active=1").bind(useCase.code).first<Row>() : null;
  let scriptOk = false;
  if (script) {
    try { validateVoiceScript({ openingDisclosure: text(script.opening_disclosure), body: JSON.parse(text(script.body_json) || "[]") as string[], claimsApproved: Number(script.claims_approved) === 1 }); scriptOk = true; }
    catch (error) { scriptOk = false; add("script_ready", false, "blocked_use_case", `Active script is not compliant: ${String((error as Error).message)}`); }
  }
  if (script && scriptOk) add("script_ready", true, "blocked_use_case", "Active, compliant script configured");
  if (!script) add("script_ready", false, "blocked_use_case", "No active governed script for this use case");

  const phoneKey = normalisedDialKey(input.phone);
  const allowlisted = gate.ok && gate.mode === "live" ? true : gate.ok && gate.allowlist.includes(phoneKey);
  add("uat_allowlist", Boolean(phoneKey) && allowlisted, "blocked_not_allowlisted", allowlisted ? "Recipient is on the approved allow-list" : "Recipient is not on the approved UAT allow-list");

  const consent = phoneKey ? await db.prepare("SELECT granted,revoked_at,source FROM voice_call_consents WHERE phone_key=?").bind(phoneKey).first<Row>() : null;
  const consentGranted = Boolean(consent) && Number(consent!.granted) === 1 && consent!.revoked_at == null;
  add("voice_consent", consentGranted, "blocked_consent", consentGranted ? `Voice consent on record (${text(consent!.source)})` : consent ? "Voice consent was revoked" : "No voice consent on record for this number");

  const optOut = phoneKey ? await db.prepare("SELECT recorded_at,source FROM voice_call_opt_outs WHERE phone_key=?").bind(phoneKey).first<Row>() : null;
  let leadOptOut = false;
  if (text(input.leadId)) {
    const lead = await db.prepare("SELECT opt_out FROM lead_work_items WHERE id=?").bind(text(input.leadId)).first<Row>().catch(() => null);
    leadOptOut = Boolean(lead) && Number(lead!.opt_out) === 1;
  }
  add("opt_out_clear", !optOut && !leadOptOut, "blocked_opt_out", optOut ? `Number opted out via ${text(optOut.source)}` : leadOptOut ? "Lead is marked opt-out in the CRM" : "No opt-out on record");

  const policy = await quietHoursPolicy(db, text(input.cityId) || "blr");
  const localHour = new Date(now + IST_OFFSET_MINUTES * 60_000).getUTCHours();
  const quiet = inQuietHours(localHour, policy.quietStart, policy.quietEnd);
  add("quiet_hours", !quiet, "blocked_quiet_hours", quiet ? `Local hour ${localHour} is inside quiet hours ${policy.quietStart}-${policy.quietEnd} (${policy.source})` : `Local hour ${localHour} is outside quiet hours (${policy.source})`);

  // Only calls that actually dialled count towards the cap. A call the gate refused never reached the
  // recipient, so counting it would let one blocked attempt suppress a legitimate later one.
  const attempts = phoneKey ? await db.prepare("SELECT COUNT(*) n FROM voice_call_orders WHERE phone_key=? AND dialed_at IS NOT NULL AND dialed_at>=?").bind(phoneKey, now - 86_400_000).first<Row>() : null;
  const attempts24h = Number(attempts?.n || 0);
  const weekly = phoneKey && useCase?.purpose === "marketing" ? await db.prepare("SELECT COUNT(*) n FROM voice_call_orders WHERE phone_key=? AND purpose='marketing' AND dialed_at IS NOT NULL AND dialed_at>=?").bind(phoneKey, now - 7 * 86_400_000).first<Row>() : null;
  const dailyCap = Math.min(useCase?.maxAttempts ?? 1, policy.maxAttempts);
  const capOk = attempts24h < dailyCap && (!weekly || Number(weekly.n || 0) < policy.promotionalCap7d);
  add("frequency_cap", capOk, "blocked_frequency_cap", capOk ? `${attempts24h} of ${dailyCap} attempts used in the last 24h` : `Frequency cap reached (${attempts24h}/${dailyCap} in 24h${weekly ? `, ${Number(weekly.n || 0)}/${policy.promotionalCap7d} marketing in 7d` : ""})`);

  const provider = selectTelephonyProvider(env);
  const providerOk = provider.status === "connected" || provider.status === "simulated";
  add("provider_configured", providerOk, "provider_unavailable", providerOk ? `Transport ${provider.provider} (${provider.status})` : "No telephony provider is connected");

  const firstFailure = checks.find(check => !check.passed) || null;
  return {
    allowed: !firstFailure,
    blockedState: firstFailure?.blockedState ?? null,
    blockedBy: firstFailure?.code ?? null,
    blockedDetail: firstFailure?.detail ?? null,
    checks,
    phoneKey,
    useCase,
    provider,
    mode: voiceMode(env),
    attempts24h,
    consentDecision: consentGranted ? "granted" : consent ? "revoked" : "missing",
    optOutDecision: optOut || leadOptOut ? "opted_out" : "clear",
    quietHoursDecision: quiet ? "inside" : "outside",
    recordingAllowed: callRecordingApproved(env),
    scriptDisclosure: script && scriptOk ? text(script.opening_disclosure) : null,
    // Handed to the atomic claim below so enforcement and the audit message agree on the numbers.
    dailyCap, capWindowStart: now - 86_400_000,
  };
}

/**
 * Claim one dial slot for this recipient, atomically.
 *
 * evaluateVoiceCallPolicy reads the attempt count and then the caller dials, which is a
 * check-then-act: two concurrent requests for the same number could both read "1 of 2 used" and both
 * dial. SQLite evaluates INSERT ... SELECT ... WHERE as one statement, so exactly one of them inserts
 * and the loser sees changes = 0 and is refused.
 *
 * A reservation is released when the provider refuses the dial, because a call that never reached the
 * recipient must not consume their allowance - the same rule the advisory count already applied by
 * only counting rows with dialed_at set.
 */
async function claimDialSlot(db: Db, input: { callId: string; phoneKey: string; cap: number; windowStart: number; now: number }) {
  const claim = await db.prepare(
    "INSERT INTO voice_call_dial_reservations (call_id,phone_key,reserved_at,released_at) SELECT ?,?,?,NULL WHERE (SELECT COUNT(*) FROM voice_call_dial_reservations WHERE phone_key=? AND released_at IS NULL AND reserved_at>=?) < ?"
  ).bind(input.callId, input.phoneKey, input.now, input.phoneKey, input.windowStart, Math.max(0, input.cap)).run();
  return Number(claim.meta.changes) > 0;
}

async function releaseDialSlot(db: Db, callId: string, now: number) {
  await db.prepare("UPDATE voice_call_dial_reservations SET released_at=? WHERE call_id=? AND released_at IS NULL").bind(now, callId).run();
}

/**
 * Consent and opt-out, re-read immediately before the provider is contacted.
 *
 * The gate's decision is a snapshot; a customer can opt out in the gap between it and the dial. This
 * does not make the sequence atomic - D1 has no cross-statement transaction here - but it shrinks the
 * window from "the whole policy evaluation plus the queue transition" to "two indexed point reads", and
 * it means a refusal recorded seconds earlier is honoured rather than ignored.
 */
async function consentStillHolds(db: Db, phoneKey: string, leadId: string) {
  const consent = await db.prepare("SELECT granted,revoked_at FROM voice_call_consents WHERE phone_key=?").bind(phoneKey).first<Row>();
  if (!consent || Number(consent.granted) !== 1 || consent.revoked_at != null) return { ok: false, state: "blocked_consent" as VoiceCallState, reason: "Voice consent was withdrawn before the dial" };
  const optOut = await db.prepare("SELECT recorded_at FROM voice_call_opt_outs WHERE phone_key=?").bind(phoneKey).first<Row>();
  if (optOut) return { ok: false, state: "blocked_opt_out" as VoiceCallState, reason: "Recipient opted out before the dial" };
  if (leadId) {
    const lead = await db.prepare("SELECT opt_out FROM lead_work_items WHERE id=?").bind(leadId).first<Row>().catch(() => null);
    if (lead && Number(lead.opt_out) === 1) return { ok: false, state: "blocked_opt_out" as VoiceCallState, reason: "Lead was marked opt-out before the dial" };
  }
  return { ok: true as const, state: null, reason: null };
}

// --- state transitions ----------------------------------------------------------------------------

const STAMPS: Partial<Record<VoiceCallState, "dialed_at" | "connected_at" | "ended_at">> = {
  dialing: "dialed_at", connected: "connected_at", ended: "ended_at",
};

async function applyTransition(db: Db, input: { callId: string; to: VoiceCallState; reason: string; actor: string; detail?: unknown; asOf?: number }) {
  const row = await db.prepare("SELECT state FROM voice_call_orders WHERE id=?").bind(input.callId).first<Row>();
  if (!row) throw new Error("Voice call not found");
  const { from, to } = assertVoiceCallTransition(text(row.state), input.to);
  const now = input.asOf ?? Date.now();
  const stamp = STAMPS[to];
  const reasonClass = voiceFailureReasonClass(to);
  // Conditional on the state we just read: two concurrent transitions cannot both apply, and the loser
  // is told rather than silently overwriting the winner.
  const claim = await db.prepare(`UPDATE voice_call_orders SET previous_state=state,state=?,failure_reason_class=COALESCE(?,failure_reason_class),failure_detail=COALESCE(?,failure_detail),${stamp ? `${stamp}=COALESCE(${stamp},?),` : ""}updated_at=? WHERE id=? AND state=?`)
    .bind(...[to, reasonClass, reasonClass ? text(input.reason) || null : null, ...(stamp ? [now] : []), now, input.callId, from]).run();
  if (!Number(claim.meta.changes)) throw new Error(`Voice call ${input.callId} moved on before ${from} -> ${to} could be applied`);
  const seq = await db.prepare("SELECT COALESCE(MAX(sequence),0) n FROM voice_call_state_transitions WHERE call_id=?").bind(input.callId).first<Row>();
  await db.prepare("INSERT INTO voice_call_state_transitions (id,call_id,sequence,from_state,to_state,reason,reason_class,detail_json,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(uid("VCT"), input.callId, Number(seq?.n || 0) + 1, from, to, text(input.reason) || null, reasonClass, JSON.stringify(input.detail ?? {}), input.actor, now).run();
  return { from, to };
}

/** Exported so the state machine can be driven from tests and from the provider-event receiver. */
export const transitionVoiceCall = applyTransition;

// --- request a call -------------------------------------------------------------------------------

async function recordPolicyDecisions(db: Db, callId: string, checks: VoicePolicyCheck[], now: number) {
  for (const check of checks) {
    await db.prepare("INSERT OR IGNORE INTO voice_call_policy_decisions (id,call_id,check_code,passed,detail,created_at) VALUES (?,?,?,?,?,?)")
      .bind(uid("VCP"), callId, check.code, check.passed ? 1 : 0, check.detail.slice(0, 400), now).run();
  }
}

function summarise(row: Row) {
  return {
    callId: text(row.id), state: text(row.state) as VoiceCallState, useCase: text(row.use_case), purpose: text(row.purpose),
    provider: text(row.provider), providerCallId: row.provider_call_id ? text(row.provider_call_id) : null,
    productionCall: Number(row.production_call) === 1, mode: text(row.mode),
    consentDecision: text(row.consent_decision), optOutDecision: text(row.opt_out_decision), quietHoursDecision: text(row.quiet_hours_decision),
    failureReasonClass: row.failure_reason_class ? text(row.failure_reason_class) : null,
    retryOf: row.retry_of ? text(row.retry_of) : null, retryAttempt: Number(row.retry_attempt || 0),
    handoffCaseId: row.handoff_case_id ? text(row.handoff_case_id) : null,
    transcriptRef: row.transcript_ref ? text(row.transcript_ref) : null,
    phoneLast4: text(row.phone_last4), dialed: row.dialed_at != null,
  };
}

/**
 * The single entry point for placing an automated call. Creates the ledger row in `requested`, moves it
 * to `policy_check`, evaluates the gate, and either refuses (terminal blocked_* state, no provider
 * contact of any kind) or queues and dials.
 *
 * Idempotent per idempotencyKey: a retried request returns the existing call rather than dialling twice.
 */
export async function requestOutboundVoiceCall(db: Db, env: Env, input: VoiceCallRequest) {
  await ensureVoiceCallTables(db);
  const now = input.asOf ?? Date.now();
  const idempotencyKey = text(input.idempotencyKey);
  if (!idempotencyKey) throw new Error("An idempotency key is required to place a voice call");
  const phoneKey = normalisedDialKey(input.phone);
  if (!phoneKey) throw new Error("A real recipient phone number is required");
  // One canonical number, derived once, used for the dial and carried through every retry.
  const dialNumber = canonicalDialNumber(env, input.phone);
  if (!dialNumber) throw new Error("Recipient number could not be read as a dialable number");
  if (!text(input.customerId) && !text(input.leadId)) throw new Error("A voice call must name the customer or lead it is about");
  const prior = await db.prepare("SELECT * FROM voice_call_orders WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) return { duplicatePrevented: true, ...summarise(prior) };

  const policy = await evaluateVoiceCallPolicy(db, env, input);
  const useCase = policy.useCase;
  const id = uid("VCALL");
  try {
    await db.prepare("INSERT INTO voice_call_orders (id,idempotency_key,direction,use_case,purpose,campaign_id,customer_id,lead_id,booking_id,city_id,phone_key,phone_last4,dial_number,mode,provider,production_call,state,consent_decision,opt_out_decision,quiet_hours_decision,frequency_attempts_24h,recording_allowed,retry_of,retry_attempt,requested_by,requested_at,updated_at) VALUES (?,?,'outbound',?,?,?,?,?,?,?,?,?,?,?,?,?, 'requested',?,?,?,?,?,?,?,?,?,?)")
      .bind(id, idempotencyKey, text(input.useCase), useCase?.purpose || "unknown", text(input.campaignId) || null, text(input.customerId) || null, text(input.leadId) || null, text(input.bookingId) || null, text(input.cityId) || "blr", phoneKey, phoneKey.slice(-4), dialNumber, policy.mode, policy.provider.provider, policy.provider.productionCapable ? 1 : 0, policy.consentDecision, policy.optOutDecision, policy.quietHoursDecision, policy.attempts24h, policy.recordingAllowed ? 1 : 0, text(input.retryOf) || null, Number(input.retryAttempt || 0), input.actorId, now, now).run();
  } catch (error) {
    // The prior-row read above and this insert are not one transaction, so two concurrent requests with
    // the same key can both pass the read. The UNIQUE index on idempotency_key is what actually
    // guarantees one call; translate losing that race into the documented duplicate result instead of a
    // raw SQL error. Same pattern as lib/communication-engine.ts enqueueCommunication.
    const raced = await db.prepare("SELECT * FROM voice_call_orders WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
    if (raced) return { duplicatePrevented: true, ...summarise(raced) };
    throw error;
  }
  await recordPolicyDecisions(db, id, policy.checks, now);
  await applyTransition(db, { callId: id, to: "policy_check", reason: "Pre-dial policy evaluation", actor: input.actorId, detail: { checks: policy.checks.length }, asOf: now });

  if (!policy.allowed) {
    await applyTransition(db, { callId: id, to: policy.blockedState!, reason: policy.blockedDetail || "Refused by policy", actor: input.actorId, detail: { blockedBy: policy.blockedBy }, asOf: now });
    const row = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(id).first<Row>();
    return { duplicatePrevented: false, dialled: false, blockedBy: policy.blockedBy, blockedDetail: policy.blockedDetail, policyChecks: policy.checks, ...summarise(row!) };
  }

  // The last two checks are still part of the GATE, so they run while the call is in policy_check and
  // land in the same terminal blocked_* states as every other refusal. Doing them after the queued
  // transition would have needed blocked_* to be reachable from queued, which would destroy the
  // property that makes the ledger trustworthy: a blocked call is proof the gate ran before any dial.
  //
  // 1. Consent and opt-out re-read. The gate's decision is a snapshot; a customer can withdraw in the
  //    gap before the dial, and a refusal recorded seconds ago must win over a slightly older approval.
  const still = await consentStillHolds(db, phoneKey, text(input.leadId));
  if (!still.ok) {
    await applyTransition(db, { callId: id, to: still.state!, reason: still.reason!, actor: input.actorId, detail: { revalidatedBeforeDial: true }, asOf: now });
    const row = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(id).first<Row>();
    return { duplicatePrevented: false, dialled: false, blockedBy: still.state === "blocked_consent" ? "voice_consent" : "opt_out_clear", blockedDetail: still.reason, policyChecks: policy.checks, ...summarise(row!) };
  }
  // 2. The frequency cap, claimed atomically. The count the gate read is advisory - it produces a good
  //    audit message - but this single statement is what actually bounds concurrent dials.
  if (!(await claimDialSlot(db, { callId: id, phoneKey, cap: policy.dailyCap, windowStart: policy.capWindowStart, now }))) {
    const reason = `Frequency cap for this recipient was reached by a concurrent request (limit ${policy.dailyCap} in 24h)`;
    await applyTransition(db, { callId: id, to: "blocked_frequency_cap", reason, actor: input.actorId, detail: { concurrentClaim: true }, asOf: now });
    const row = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(id).first<Row>();
    return { duplicatePrevented: false, dialled: false, blockedBy: "frequency_cap", blockedDetail: reason, policyChecks: policy.checks, ...summarise(row!) };
  }

  await applyTransition(db, { callId: id, to: "queued", reason: "Policy passed; queued for dial", actor: input.actorId, asOf: now });
  const callbackUrl = text(input.statusCallbackUrl) || statusCallbackUrl(env) || "";
  try {
    const handle = await policy.provider.createCall({
      callRef: id, toNumber: dialNumber, statusCallbackUrl: callbackUrl,
      recordingAllowed: policy.recordingAllowed, simulatedOutcome: input.simulatedOutcome ?? null,
    });
    await db.prepare("UPDATE voice_call_orders SET provider_call_id=?,production_call=?,updated_at=? WHERE id=?").bind(handle.providerCallId, handle.productionCall ? 1 : 0, now, id).run();
    await applyTransition(db, { callId: id, to: "dialing", reason: `Provider accepted the call (${handle.providerStatus})`, actor: input.actorId, detail: { providerStatus: handle.providerStatus, productionCall: handle.productionCall }, asOf: now });
  } catch (error) {
    const unavailable = error instanceof TelephonyProviderUnavailable;
    // The recipient was never reached, so the slot goes back rather than silently consuming their
    // allowance for the day.
    await releaseDialSlot(db, id, now);
    await applyTransition(db, { callId: id, to: unavailable ? "provider_unavailable" : "provider_error", reason: String((error as Error).message).slice(0, 200), actor: input.actorId, asOf: now });
    const row = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(id).first<Row>();
    return { duplicatePrevented: false, dialled: false, blockedBy: null, blockedDetail: String((error as Error).message).slice(0, 200), policyChecks: policy.checks, ...summarise(row!) };
  }
  const row = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(id).first<Row>();
  return { duplicatePrevented: false, dialled: true, blockedBy: null, blockedDetail: null, policyChecks: policy.checks, openingDisclosure: policy.scriptDisclosure, ...summarise(row!) };
}

/**
 * A retry is a NEW call that re-proves the whole policy gate, correlated to the original through
 * retry_of. Retrying without re-checking consent, opt-out and quiet hours would let one approved dial
 * license a second one hours later, after the customer opted out or after quiet hours began.
 */
export async function retryVoiceCall(db: Db, env: Env, input: { callId: string; actorId: string; actorPermissions: string[]; idempotencyKey?: string; asOf?: number }) {
  await ensureVoiceCallTables(db);
  const original = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(input.callId).first<Row>();
  if (!original) throw new Error("Voice call not found");
  const state = text(original.state);
  if (!isVoiceCallState(state) || !VOICE_RETRYABLE_STATES.includes(state)) throw new Error(`A call in state ${state} may not be retried`);
  const useCase = voiceUseCase(text(original.use_case));
  const root = text(original.retry_of) || text(original.id);
  const attempts = await db.prepare("SELECT COUNT(*) n FROM voice_call_orders WHERE retry_of=?").bind(root).first<Row>();
  const attempt = Number(attempts?.n || 0) + 1;
  if (useCase && attempt >= useCase.maxAttempts) throw new Error(`${useCase.code} allows ${useCase.maxAttempts} attempt(s); no retry remains`);
  return requestOutboundVoiceCall(db, env, {
    idempotencyKey: text(input.idempotencyKey) || `voice-retry:${root}:${attempt}`,
    // The stored canonical number, not the 10-digit audit key - a retry must dial exactly what the
    // original dialled.
    useCase: text(original.use_case), phone: text(original.dial_number) || text(original.phone_key), cityId: text(original.city_id),
    customerId: text(original.customer_id) || null, leadId: text(original.lead_id) || null, bookingId: text(original.booking_id) || null,
    campaignId: text(original.campaign_id) || null, actorId: input.actorId, actorPermissions: input.actorPermissions,
    retryOf: root, retryAttempt: attempt, asOf: input.asOf,
  });
}

export async function cancelVoiceCall(db: Db, input: { callId: string; reason: string; actorId: string; asOf?: number }) {
  await ensureVoiceCallTables(db);
  return applyTransition(db, { callId: input.callId, to: "cancelled", reason: text(input.reason) || "Cancelled by operator", actor: input.actorId, asOf: input.asOf });
}

// --- speech-stack failures, handoff, opt-out during a call ---------------------------------------

export async function recordVoiceSpeechFailure(db: Db, input: { callId: string; kind: "stt" | "tts"; reason: string; actorId: string; asOf?: number }) {
  await ensureVoiceCallTables(db);
  return applyTransition(db, { callId: input.callId, to: input.kind === "stt" ? "stt_failed" : "tts_failed", reason: text(input.reason) || `${input.kind} provider failure`, actor: input.actorId, asOf: input.asOf });
}

/**
 * Handoff is two steps on purpose. `handoff_requested` records that the bot decided a human is needed
 * (AI timeout, low confidence, the customer asked, a speech failure); `ai_handoff` records that a real
 * case exists in the queue Ops works. If case creation fails the call stays in handoff_requested rather
 * than reporting a handoff that nobody will ever see.
 */
export async function requestVoiceHumanHandoff(db: Db, input: { callId: string; reason: string; actorId: string; customerId?: string | null; asOf?: number }) {
  await ensureVoiceCallTables(db);
  const call = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(input.callId).first<Row>();
  if (!call) throw new Error("Voice call not found");
  const now = input.asOf ?? Date.now();
  await applyTransition(db, { callId: input.callId, to: "handoff_requested", reason: text(input.reason) || "Human handoff requested", actor: input.actorId, asOf: now });
  const created = await createUnifiedCase(db, {
    idempotencyKey: `voice-handoff:${input.callId}`,
    caseType: "lead_escalation", severity: "high",
    title: `Voice call needs a human: ${text(call.use_case)}`,
    description: `${text(input.reason) || "Handoff requested"} - automated voice call ${input.callId} on number ending ${text(call.phone_last4)}.`,
    customerId: text(input.customerId) || text(call.customer_id) || undefined,
    sourceType: "voice_call", sourceId: input.callId,
    ownerTeam: "customer_experience", actorId: input.actorId,
  }).catch(() => null) as { case?: Row } | null;
  const caseId = created?.case?.id ? String(created.case.id) : null;
  if (!caseId) return { callId: input.callId, state: "handoff_requested" as VoiceCallState, caseId: null, handedOff: false, reason: "Handoff case could not be created; call remains awaiting a human" };
  await db.prepare("UPDATE voice_call_orders SET handoff_case_id=?,updated_at=? WHERE id=?").bind(caseId, now, input.callId).run();
  await applyTransition(db, { callId: input.callId, to: "ai_handoff", reason: `Handed to a human (case ${caseId})`, actor: input.actorId, asOf: now });
  return { callId: input.callId, state: "ai_handoff" as VoiceCallState, caseId, handedOff: true, reason: null };
}

/** The customer said "do not call" while we had them on the line. Honoured immediately, then the call ends. */
export async function recordVoiceOptOutDuringCall(db: Db, input: { callId: string; actorId: string; reason?: string | null; asOf?: number }) {
  await ensureVoiceCallTables(db);
  const call = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(input.callId).first<Row>();
  if (!call) throw new Error("Voice call not found");
  const now = input.asOf ?? Date.now();
  await recordVoiceOptOut(db, { phone: text(call.phone_key), source: "voice_call_in_conversation", reason: text(input.reason) || "Customer asked not to be called again", actorId: input.actorId, asOf: now });
  await applyTransition(db, { callId: input.callId, to: "completed", reason: "Customer opted out during the call", actor: input.actorId, detail: { optOutRecorded: true }, asOf: now });
  await applyTransition(db, { callId: input.callId, to: "ended", reason: "Call ended after opt-out", actor: input.actorId, asOf: now });
  return { callId: input.callId, optedOut: true, state: "ended" as VoiceCallState };
}

export async function attachVoiceTranscript(db: Db, input: { callId: string; transcriptRef: string; aiCallId?: string | null; asOf?: number }) {
  await ensureVoiceCallTables(db);
  const ref = text(input.transcriptRef);
  if (!ref) throw new Error("A transcript reference is required");
  const claim = await db.prepare("UPDATE voice_call_orders SET transcript_ref=?,ai_call_id=COALESCE(?,ai_call_id),updated_at=? WHERE id=?").bind(ref, text(input.aiCallId) || null, input.asOf ?? Date.now(), input.callId).run();
  if (!Number(claim.meta.changes)) throw new Error("Voice call not found");
  return { callId: input.callId, transcriptRef: ref };
}

export async function completeVoiceCall(db: Db, input: { callId: string; reason: string; actorId: string; asOf?: number }) {
  await ensureVoiceCallTables(db);
  const now = input.asOf ?? Date.now();
  await applyTransition(db, { callId: input.callId, to: "completed", reason: text(input.reason) || "Call completed", actor: input.actorId, asOf: now });
  await applyTransition(db, { callId: input.callId, to: "ended", reason: "Call closed out", actor: input.actorId, asOf: now });
  return { callId: input.callId, state: "ended" as VoiceCallState };
}

// --- provider events ------------------------------------------------------------------------------

/**
 * The single intermediate state that makes an out-of-order provider event legal, if exactly one exists.
 *
 * This is not a convenience. A carrier's StatusCallback commonly fires ONCE, at the end of the call,
 * with CallStatus=completed - so the most likely real sequence is a lone `completed` arriving while the
 * ledger still says `dialing`. Refusing it left an answered-and-ended call stuck in `dialing` forever,
 * because the event is then deduplicated and never reconsidered.
 *
 * The graph stays strict: rather than adding dialing -> completed as a shortcut, the missing hop is
 * applied first and marked inferred, so the audit says what was observed and what was deduced. A
 * carrier reports `completed` only for a call that was actually answered (an unanswered one is
 * no-answer/busy/failed), so inferring `connected` states something true.
 *
 * Only ever ONE hop, only from this small set, and only when the choice is unambiguous - two candidate
 * paths mean we do not know which happened, and the event stays unapplied.
 */
const INFERABLE_STATES: VoiceCallState[] = ["dialing", "ringing", "connected"];

/** Event kinds that can occur more than once in one call, so identity needs a payload discriminant. */
const REPEATABLE_EVENT_KINDS = new Set<TelephonyEventKind>(["dtmf", "recording_available"]);

export function inferredBridgeState(from: VoiceCallState, to: VoiceCallState): VoiceCallState | null {
  if (canVoiceCallTransition(from, to)) return null;
  const candidates = INFERABLE_STATES.filter(mid => mid !== from && mid !== to && canVoiceCallTransition(from, mid) && canVoiceCallTransition(mid, to));
  return candidates.length === 1 ? candidates[0] : null;
}

const EVENT_STATES: Record<TelephonyEventKind, VoiceCallState | null> = {
  dialing: "dialing", ringing: "ringing", connected: "connected",
  dtmf: null, recording_available: null,
  no_answer: "no_answer", busy: "busy", failed: "provider_error", completed: "completed",
};

/**
 * The provider callback receiver. Verify, then deduplicate, then apply - in that order, so an unsigned
 * payload never reaches the ledger and a redelivered one never moves the state machine twice.
 *
 * Providers redeliver aggressively on any non-2xx, so a duplicate is a normal event, not an error: it
 * is answered 200 with duplicate:true and changes nothing.
 */
export async function recordVoiceProviderEvent(db: Db, env: Env, input: { rawBody: string; headers: Headers; provider?: TelephonyProvider; asOf?: number }) {
  await ensureVoiceCallTables(db);
  const provider = input.provider || selectTelephonyProvider(env);
  const verification = await provider.verifyWebhook({ rawBody: input.rawBody, headers: input.headers });
  if (!verification.verified) return { accepted: false, status: 401, reason: verification.reason || "Webhook verification failed", duplicate: false };
  let event;
  try { event = provider.parseEvent(input.rawBody); }
  catch (error) { return { accepted: false, status: 400, reason: String((error as Error).message).slice(0, 200), duplicate: false }; }
  const now = input.asOf ?? Date.now();
  const digest = await sha256Hex(input.rawBody);
  const curated = { kind: event.kind, providerStatus: event.providerStatus, dtmfDigits: event.dtmfDigits, durationSeconds: event.durationSeconds, hasRecording: Boolean(event.recordingRef) };
  // A carrier's event id for a status callback is the CALL id, which is constant for the whole call - so
  // two DTMF presses on one call produced the identical identity and the second was silently dropped as
  // a duplicate. For kinds that legitimately repeat, the body digest joins the identity: two genuinely
  // different payloads are now distinct, while an exact redelivery still deduplicates (it is
  // indistinguishable from a repeat by definition). Status events keep a stable identity so a
  // redelivered 'completed' cannot advance the state machine twice.
  const eventKey = REPEATABLE_EVENT_KINDS.has(event.kind) ? `${event.providerEventId}:${digest.slice(0, 16)}` : event.providerEventId;
  const insert = await db.prepare("INSERT OR IGNORE INTO voice_call_provider_events (id,call_id,provider,provider_event_id,event_kind,provider_status,signature_mechanism,payload_sha256,curated_json,applied,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)")
    .bind(uid("VPE"), event.callRef || null, provider.provider, eventKey, event.kind, event.providerStatus, verification.mechanism, digest, JSON.stringify(curated), now).run();
  if (!Number(insert.meta.changes)) return { accepted: true, status: 200, duplicate: true, applied: false, reason: "Provider event already processed", eventId: eventKey };

  const callId = text(event.callRef);
  if (!callId) return { accepted: true, status: 202, duplicate: false, applied: false, reason: "Event carries no call reference", eventId: eventKey };
  const call = await db.prepare("SELECT id,state,recording_allowed FROM voice_call_orders WHERE id=?").bind(callId).first<Row>();
  if (!call) return { accepted: true, status: 202, duplicate: false, applied: false, reason: "Event references an unknown call", eventId: eventKey };

  // A recording reference is only stored when recording was approved for this call. An unapproved
  // recording URL is discarded rather than quietly retained.
  if (event.recordingRef && Number(call.recording_allowed) === 1) {
    await db.prepare("UPDATE voice_call_orders SET recording_ref=?,updated_at=? WHERE id=?").bind(event.recordingRef.slice(0, 500), now, callId).run();
  }
  const target = EVENT_STATES[event.kind];
  if (!target) {
    await db.prepare("UPDATE voice_call_provider_events SET applied=1 WHERE provider=? AND provider_event_id=?").bind(provider.provider, eventKey).run();
    return { accepted: true, status: 200, duplicate: false, applied: true, stateChanged: false, eventKind: event.kind, eventId: eventKey };
  }
  try {
    const current = text(call.state) as VoiceCallState;
    const bridge = inferredBridgeState(current, target);
    if (bridge) {
      await applyTransition(db, { callId, to: bridge, reason: `Inferred ${bridge} from provider event ${event.kind}${event.providerStatus ? ` (${event.providerStatus})` : ""}`, actor: `provider:${provider.provider}`, detail: { ...curated, inferred: true }, asOf: now });
    }
    const applied = await applyTransition(db, { callId, to: target, reason: `Provider event ${event.kind}${event.providerStatus ? ` (${event.providerStatus})` : ""}`, actor: `provider:${provider.provider}`, detail: curated, asOf: now });
    await db.prepare("UPDATE voice_call_provider_events SET applied=1 WHERE provider=? AND provider_event_id=?").bind(provider.provider, eventKey).run();
    return { accepted: true, status: 200, duplicate: false, applied: true, stateChanged: true, from: bridge ? current : applied.from, to: applied.to, inferred: bridge, eventKind: event.kind, eventId: eventKey };
  } catch (error) {
    // Genuinely unreachable from here - a terminal outcome the provider is trying to overwrite, or an
    // ambiguous gap. The event stays recorded and unapplied rather than forcing an impossible history,
    // and voiceOutboundReadiness surfaces the count so a stuck call is visible rather than silent.
    return { accepted: true, status: 200, duplicate: false, applied: false, stateChanged: false, reason: String((error as Error).message).slice(0, 200), eventKind: event.kind, eventId: eventKey };
  }
}

// --- audit read ------------------------------------------------------------------------------------

/** Everything recorded about one call: the decision trail, the state trail, and the curated events. */
export async function voiceCallAudit(db: Db, callId: string) {
  await ensureVoiceCallTables(db);
  const call = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(callId).first<Row>();
  if (!call) throw new Error("Voice call not found");
  const [transitions, decisions, events] = await Promise.all([
    db.prepare("SELECT sequence,from_state,to_state,reason,reason_class,actor,created_at FROM voice_call_state_transitions WHERE call_id=? ORDER BY sequence").bind(callId).all<Row>(),
    db.prepare("SELECT check_code,passed,detail,created_at FROM voice_call_policy_decisions WHERE call_id=? ORDER BY check_code").bind(callId).all<Row>(),
    db.prepare("SELECT provider,provider_event_id,event_kind,provider_status,signature_mechanism,payload_sha256,curated_json,applied,created_at FROM voice_call_provider_events WHERE call_id=? ORDER BY created_at").bind(callId).all<Row>(),
  ]);
  return {
    call: summarise(call),
    transitions: transitions.results,
    policyDecisions: decisions.results.map(row => ({ checkCode: text(row.check_code), passed: Number(row.passed) === 1, detail: text(row.detail), at: Number(row.created_at) })),
    providerEvents: events.results,
    truth: { rawProviderPayloadsStored: false, productionCallExecuted: Number(call.production_call) === 1 && call.dialed_at != null },
  };
}

export async function voiceCallLedger(db: Db, input: { limit?: number; state?: string } = {}) {
  await ensureVoiceCallTables(db);
  const limit = Math.max(1, Math.min(Number(input.limit || 50), 200));
  const rows = input.state
    ? await db.prepare("SELECT * FROM voice_call_orders WHERE state=? ORDER BY requested_at DESC LIMIT ?").bind(input.state, limit).all<Row>()
    : await db.prepare("SELECT * FROM voice_call_orders ORDER BY requested_at DESC LIMIT ?").bind(limit).all<Row>();
  return rows.results.map(summarise);
}

/** Operator-facing readiness. Reports configuration and approval state; never a secret, never a number. */
export async function voiceOutboundReadiness(db: Db, env: Env) {
  await seedVoiceCallScripts(db);
  const scripts = await db.prepare("SELECT use_case,active,claims_approved,version FROM voice_call_scripts ORDER BY use_case").all<Row>();
  const placed = await db.prepare("SELECT COUNT(*) n FROM voice_call_orders WHERE dialed_at IS NOT NULL AND production_call=1").first<Row>();
  // A provider event that could not be applied means a call may be stuck mid-lifecycle. Surfaced rather
  // than left to be discovered by reading the events table.
  const unapplied = await db.prepare("SELECT COUNT(*) n FROM voice_call_provider_events WHERE applied=0").first<Row>();
  const stuck = await db.prepare("SELECT COUNT(*) n FROM voice_call_orders WHERE state IN ('dialing','ringing','connected','speaking','listening','handoff_requested') AND requested_at<?").bind(Date.now() - 3_600_000).first<Row>();
  return {
    gate: voiceCallReadiness(env),
    transport: telephonyProviderStatus(env),
    useCases: VOICE_USE_CASES.map(useCase => ({ ...useCase, availableNow: !useCase.requiresSalesApproval || salesOutboundApproved(env) })),
    scripts: scripts.results.map(row => ({ useCase: text(row.use_case), active: Number(row.active) === 1, claimsApproved: Number(row.claims_approved) === 1, version: Number(row.version) })),
    productionCallsPlaced: Number(placed?.n || 0),
    unappliedProviderEvents: Number(unapplied?.n || 0),
    callsOpenOverAnHour: Number(stuck?.n || 0),
  };
}
