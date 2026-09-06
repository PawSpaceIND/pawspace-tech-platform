import { canonicalDialNumber, isVoiceAllowlisted, normalisedDialKey, resolveVoiceCallGate, salesOutboundApproved } from "./voice-call-gate";
import { sha256Hex } from "./voice-telephony-provider";
import { ensurePeopleTables } from "./people-foundation";
import {
  claimNextHumanQueue,
  ensureOutboundOrchestratorTables,
  getPowerDiallerHud,
  recordPowerDiallerDisposition,
  releaseHumanQueueClaim,
  type PowerDiallerDisposition,
} from "./outbound-orchestrator";
import { POWER_DIALLER_AUTO_ADVANCE_MS } from "./power-dialler-policy";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const IST_OFFSET_MS = 330 * 60_000;
const EXOTEL_TIMEOUT_MS = 12_000;
const digits = (value: unknown) => text(value).replace(/\D/g, "");

export async function ensureEmployeePowerDiallerTables(db: Db) {
  await Promise.all([ensureOutboundOrchestratorTables(db), ensurePeopleTables(db)]);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS employee_power_calls (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,queue_id TEXT NOT NULL,actor_id TEXT NOT NULL,employee_id TEXT,customer_id TEXT NOT NULL,status TEXT NOT NULL,provider TEXT NOT NULL DEFAULT 'exotel',provider_call_id TEXT,employee_phone_hash TEXT NOT NULL,employee_phone_last4 TEXT NOT NULL,customer_phone_hash TEXT NOT NULL,customer_phone_last4 TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,disposition TEXT,failure_detail TEXT,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS employee_power_calls_queue_idx ON employee_power_calls(queue_id,started_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS employee_power_calls_actor_idx ON employee_power_calls(actor_id,status,started_at DESC)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS ux_employee_power_call_active_actor ON employee_power_calls(actor_id) WHERE status IN ('dialing','connected')"),
  ]);
}

function isQuietHours(at: number) {
  const hour = new Date(at + IST_OFFSET_MS).getUTCHours();
  return hour >= 21 || hour < 9;
}
function safeFailure(error: unknown) {
  return text((error as { message?: unknown })?.message || error).replace(/\+?\d[\d\s().-]{7,}/g, "[redacted-phone]").slice(0, 240) || "Employee dial failed";
}
async function activeControl(db: Db, customerId: string, asOf: number) {
  return db.prepare("SELECT control_type,scope,reason,expires_at FROM outbound_contact_controls WHERE customer_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY CASE control_type WHEN 'dnd' THEN 1 WHEN 'wrong_number' THEN 2 ELSE 3 END,created_at DESC LIMIT 1").bind(customerId, asOf).first<Row>().catch(() => null);
}
async function employeeForActor(db: Db, actorId: string) {
  await ensurePeopleTables(db);
  return db.prepare("SELECT id,display_name,work_email,user_email,phone,employment_status FROM employees WHERE lower(work_email)=lower(?) OR lower(user_email)=lower(?) ORDER BY CASE WHEN lower(work_email)=lower(?) THEN 0 ELSE 1 END LIMIT 1").bind(actorId, actorId, actorId).first<Row>();
}
async function customerForQueue(db: Db, queueId: string) {
  return db.prepare("SELECT q.*,c.primary_phone,c.name customer_name,c.city_id,p.marketing_consent,p.service_consent,p.opt_out FROM outbound_routing_queue q JOIN canonical_customers c ON c.id=q.customer_id LEFT JOIN customer_contact_preferences p ON p.customer_id=q.customer_id WHERE q.id=?").bind(queueId).first<Row>();
}

async function dialExotel(env: Env, input: { callId: string; employeePhone: string; customerPhone: string }) {
  const gate = resolveVoiceCallGate(env);
  if (!gate.ok) throw new Error(gate.reason);
  if (!salesOutboundApproved(env)) throw new Error("Outbound sales calling is not approved in this environment");
  const employeeDial = canonicalDialNumber(env, input.employeePhone), customerDial = canonicalDialNumber(env, input.customerPhone);
  if (!employeeDial || !customerDial) throw new Error("Employee or customer phone could not be canonicalised");
  if (gate.mode === "uat" && (!isVoiceAllowlisted(env, employeeDial) || !isVoiceAllowlisted(env, customerDial))) throw new Error("Both employee and customer numbers must be allowlisted in UAT");
  const sid = text(env.EXOTEL_SID), key = text(env.EXOTEL_API_KEY), token = text(env.EXOTEL_API_TOKEN), callerId = text(env.EXOTEL_CALLER_ID);
  if (!sid || !key || !token || !callerId) throw new Error("Exotel employee power-dialler credentials are not configured");
  const subdomain = text(env.EXOTEL_SUBDOMAIN) || "api.exotel.com";
  const body = new URLSearchParams({ From: employeeDial, To: customerDial, CallerId: callerId, CallType: "trans", CustomField: input.callId, TimeOut: "45", Record: "false" });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), EXOTEL_TIMEOUT_MS);
  try {
    const response = await fetch(`https://${subdomain}/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect.json`, { method: "POST", signal: controller.signal, headers: { authorization: `Basic ${btoa(`${key}:${token}`)}`, "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Exotel rejected the employee dial (${response.status})`);
    let parsed: { Call?: { Sid?: string; Status?: string } } = {};
    try { parsed = JSON.parse(raw) as typeof parsed; } catch { throw new Error("Exotel returned a malformed employee dial response"); }
    const providerCallId = text(parsed.Call?.Sid);
    if (!providerCallId) throw new Error("Exotel returned no employee call identifier");
    return { providerCallId, providerStatus: text(parsed.Call?.Status) || "queued", employeeDial, customerDial };
  } finally { clearTimeout(timer); }
}

export async function currentEmployeePowerCall(db: Db, actorId: string) {
  await ensureEmployeePowerDiallerTables(db);
  const call = await db.prepare("SELECT id,queue_id,status,provider_call_id,customer_phone_last4,started_at FROM employee_power_calls WHERE actor_id=? AND status IN ('dialing','connected') ORDER BY started_at DESC LIMIT 1").bind(actorId).first<Row>();
  if (!call) return null;
  return { call, hud: await getPowerDiallerHud(db, text(call.queue_id)) };
}

export async function claimAndDialNextHuman(db: Db, env: Env, input: { actorId: string; asOf?: number }) {
  const asOf = input.asOf ?? Date.now();
  await ensureEmployeePowerDiallerTables(db);
  const existing = await currentEmployeePowerCall(db, input.actorId);
  if (existing) return { status: "already_active", ...existing, autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS };
  if (isQuietHours(asOf)) return { status: "quiet_hours", reason: "Employee power dialler runs only 09:00-21:00 IST", autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS };
  const employee = await employeeForActor(db, input.actorId);
  if (!employee || text(employee.employment_status) !== "active") return { status: "employee_not_configured", reason: "Active employee profile is required for power dialling", autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS };
  if (!text(employee.phone)) return { status: "employee_phone_missing", reason: "Employee phone is required for Exotel power dialling", autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS };
  const queue = await claimNextHumanQueue(db, { actorId: input.actorId, asOf });
  if (!queue) return { status: "queue_empty", autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS };
  const recipient = await customerForQueue(db, text(queue.id));
  if (!recipient || !text(recipient.primary_phone)) { await releaseHumanQueueClaim(db, { queueId: text(queue.id), actorId: input.actorId, asOf }); return { status: "recipient_unavailable", reason: "Customer phone is unavailable", autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS }; }
  const control = await activeControl(db, text(recipient.customer_id), asOf);
  const marketingLifecycle = ["grooming_renewal", "fresh_lead", "dormant_lead", "reactivation", "cross_sell"].includes(text(recipient.lifecycle_code));
  if (control && (["dnd", "wrong_number"].includes(text(control.control_type)) || (text(control.control_type) === "cooling_period" && marketingLifecycle))) { await db.prepare("UPDATE outbound_routing_queue SET status='suppressed',assigned_to=NULL,updated_at=? WHERE id=?").bind(asOf, queue.id).run(); return { status: "suppressed", reason: text(control.reason) || text(control.control_type), autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS }; }
  if (Number(recipient.opt_out || 0) === 1) { await db.prepare("UPDATE outbound_routing_queue SET status='suppressed',assigned_to=NULL,updated_at=? WHERE id=?").bind(asOf, queue.id).run(); return { status: "suppressed", reason: "Customer is opted out", autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS }; }
  const customerKey = normalisedDialKey(text(recipient.primary_phone));
  if (customerKey) { const voiceDnd = await db.prepare("SELECT source FROM voice_call_opt_outs WHERE phone_key=?").bind(customerKey).first<Row>(); if (voiceDnd) { await db.prepare("UPDATE outbound_routing_queue SET status='suppressed',assigned_to=NULL,updated_at=? WHERE id=?").bind(asOf, queue.id).run(); return { status: "suppressed", reason: "Number is on the voice do-not-call register", autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS }; } }

  const attemptNo = Number(queue.attempt_count || 0) + 1, idempotencyKey = `employee-power:${queue.id}:${attemptNo}`, prior = await db.prepare("SELECT * FROM employee_power_calls WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) return { status: text(prior.status), call: prior, hud: await getPowerDiallerHud(db, text(queue.id)), duplicatePrevented: true, autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS };
  const callId = uid("EPCALL"), employeeDial = canonicalDialNumber(env, employee.phone), customerDial = canonicalDialNumber(env, recipient.primary_phone);
  if (!employeeDial || !customerDial) { await releaseHumanQueueClaim(db, { queueId: text(queue.id), actorId: input.actorId, asOf }); return { status: "invalid_phone", reason: "Employee or customer phone cannot be dialled", autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS }; }
  try {
    await db.prepare("INSERT INTO employee_power_calls (id,idempotency_key,queue_id,actor_id,employee_id,customer_id,status,provider,employee_phone_hash,employee_phone_last4,customer_phone_hash,customer_phone_last4,started_at,updated_at) VALUES (?,?,?,?,?,?,'dialing','exotel',?,?,?,?,?,?)")
      .bind(callId, idempotencyKey, queue.id, input.actorId, employee.id, recipient.customer_id, await sha256Hex(employeeDial), digits(employeeDial).slice(-4), await sha256Hex(customerDial), digits(customerDial).slice(-4), asOf, asOf).run();
    const provider = await dialExotel(env, { callId, employeePhone: text(employee.phone), customerPhone: text(recipient.primary_phone) });
    await db.batch([
      db.prepare("UPDATE employee_power_calls SET provider_call_id=?,updated_at=? WHERE id=?").bind(provider.providerCallId, asOf, callId),
      db.prepare("UPDATE outbound_routing_queue SET status='dialing',human_call_id=?,updated_at=? WHERE id=? AND assigned_to=?").bind(callId, asOf, queue.id, input.actorId),
      db.prepare("INSERT INTO outbound_dialler_events (id,queue_id,actor_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(uid("ODE"), queue.id, input.actorId, "dial_started", JSON.stringify({ callId, provider: "exotel", providerStatus: provider.providerStatus, oneActiveCall: true }), asOf),
    ]);
    return { status: "dialing", call: { id: callId, queueId: text(queue.id), providerCallId: provider.providerCallId, customerLast4: digits(customerDial).slice(-4), startedAt: asOf }, hud: await getPowerDiallerHud(db, text(queue.id)), autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS };
  } catch (error) {
    const detail = safeFailure(error);
    await db.prepare("UPDATE employee_power_calls SET status='failed',failure_detail=?,ended_at=?,updated_at=? WHERE id=?").bind(detail, asOf, asOf, callId).run().catch(() => undefined);
    await releaseHumanQueueClaim(db, { queueId: text(queue.id), actorId: input.actorId, asOf }).catch(() => undefined);
    return { status: "dial_failed", reason: detail, hud: await getPowerDiallerHud(db, text(queue.id)), autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS };
  }
}

export async function dispositionEmployeePowerCall(db: Db, input: { actorId: string; queueId: string; disposition: PowerDiallerDisposition; callbackAt?: number | null; asOf?: number }) {
  const asOf = input.asOf ?? Date.now();
  await ensureEmployeePowerDiallerTables(db);
  const call = await db.prepare("SELECT * FROM employee_power_calls WHERE queue_id=? AND actor_id=? AND status IN ('dialing','connected') ORDER BY started_at DESC LIMIT 1").bind(input.queueId, input.actorId).first<Row>();
  const result = await recordPowerDiallerDisposition(db, { queueId: input.queueId, actorId: input.actorId, disposition: input.disposition, callbackAt: input.callbackAt, asOf });
  if (call) await db.prepare("UPDATE employee_power_calls SET status='completed',disposition=?,ended_at=?,updated_at=? WHERE id=?").bind(input.disposition, asOf, asOf, call.id).run();
  return { ...result, callId: call ? text(call.id) : null, autoAdvanceAfterMs: POWER_DIALLER_AUTO_ADVANCE_MS };
}

export async function releaseEmployeePowerDialler(db: Db, input: { actorId: string; asOf?: number }) {
  const asOf = input.asOf ?? Date.now();
  await ensureEmployeePowerDiallerTables(db);
  const row = await db.prepare("SELECT id,queue_id,status FROM employee_power_calls WHERE actor_id=? AND status IN ('dialing','connected') ORDER BY started_at DESC LIMIT 1").bind(input.actorId).first<Row>();
  if (row) return { released: false, reason: "An active connected/dialing call must be dispositioned before leaving the queue" };
  const claimed = await db.prepare("SELECT id FROM outbound_routing_queue WHERE assigned_to=? AND lane='human' AND status='claimed' ORDER BY updated_at DESC LIMIT 1").bind(input.actorId).first<Row>();
  if (!claimed) return { released: true, queueId: null };
  const released = await releaseHumanQueueClaim(db, { queueId: text(claimed.id), actorId: input.actorId, asOf });
  return { ...released, queueId: text(claimed.id) };
}
