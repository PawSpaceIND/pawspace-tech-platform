import { ensureCommunicationTables } from "./communication-engine";
import { ensureAiVoiceUatTables } from "./ai-voice-uat";
import { ensureOutboundOrchestratorTables, enqueueHumanEscalation } from "./outbound-orchestrator";
import { requestOutboundVoiceCall, seedVoiceCallScripts } from "./voice-outbound-canonical";
import { selectVoiceTts, voiceProvidersStatus } from "./voice-provider-adapter";
import { sha256Hex } from "./voice-telephony-provider";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const AI_RETRY_DELAY_MS = 5 * 60_000;
export const OUTBOUND_AI_MAX_ATTEMPTS = 2;

export async function ensureOutboundAiTables(db: Db) {
  await Promise.all([ensureOutboundOrchestratorTables(db), ensureCommunicationTables(db), ensureAiVoiceUatTables(db)]);
  await seedVoiceCallScripts(db, "system:outbound-ai");
}

async function openThread(db: Db, customerId: string, leadId?: string | null) {
  const existing = await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? AND status='open' ORDER BY updated_at DESC LIMIT 1").bind(customerId).first<Row>();
  if (existing) return text(existing.id);
  const id = uid("THREAD"), now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,?,NULL,'open','ai-orchestrator',NULL,?,?)").bind(id, customerId, text(leadId) || null, now, now),
    db.prepare("INSERT OR IGNORE INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'customer',?)").bind(uid("PART"), id, "customer", customerId, customerId, now),
  ]);
  return id;
}

function outboundVoiceUseCaseFor(row: Row) {
  const lifecycle = text(row.lifecycle_code);
  return ["fresh_lead", "dormant_lead"].includes(lifecycle) ? "lead_qualification" : "sales_pitch";
}

async function activateAiSession(db: Db, env: Env, queue: Row, call: Row, asOf: number) {
  if (!["connected", "speaking", "listening"].includes(text(call.state))) return { activated: false, reason: "call_not_connected" };
  if (text(queue.ai_session_id)) return { activated: false, aiSessionId: text(queue.ai_session_id), reason: "already_bound" };
  if (text(call.consent_decision) !== "granted") throw new Error("Outbound AI session requires a voice-policy-approved call with recorded consent");
  const threadId = await openThread(db, text(queue.customer_id), text(queue.lead_id) || null);
  const aiSessionId = uid("AIVCALL"), provider = text(call.provider) === "exotel" ? "exotel" : "sandbox_simulator";
  await db.prepare("INSERT INTO ai_voice_calls (id,thread_id,customer_id,transport_provider,direction,status,consent_status,language,started_at,created_by) VALUES (?,?,?,?, 'outbound','active','verified',NULL,?,?)")
    .bind(aiSessionId, threadId, queue.customer_id, provider, asOf, "system:outbound-ai").run();
  await db.batch([
    db.prepare("UPDATE voice_call_orders SET ai_call_id=?,updated_at=? WHERE id=? AND ai_call_id IS NULL").bind(aiSessionId, asOf, call.id),
    db.prepare("UPDATE outbound_routing_queue SET ai_session_id=?,updated_at=? WHERE id=? AND ai_session_id IS NULL").bind(aiSessionId, asOf, queue.id),
  ]);
  const script = await db.prepare("SELECT opening_disclosure FROM voice_call_scripts WHERE use_case=? AND active=1").bind(text(call.use_case)).first<Row>();
  const opening = text(script?.opening_disclosure);
  if (!opening) throw new Error(`No active ${text(call.use_case)} voice disclosure is configured`);
  const tts = selectVoiceTts(env);
  if (tts.status !== "connected") throw new Error("Voice TTS became unavailable after call connection");
  const audio = await tts.synthesize({ text: opening, language: null });
  const audioHash = await sha256Hex(audio.audioRef);
  await db.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)")
    .bind(uid("AIVEVT"), aiSessionId, "outbound_opening_prepared", JSON.stringify({ queueId: text(queue.id), voiceCallId: text(call.id), targetOffer: text(queue.target_offer) || null, nextBestService: text(queue.next_best_service) || null, priorityScore: Number(queue.priority_score || 0), speechProvider: tts.provider, latencyMs: audio.latencyMs, audioSha256: audioHash, productionTelephony: Number(call.production_call) === 1 }), asOf).run();
  return { activated: true, aiSessionId, threadId, speechProvider: tts.provider, openingAudioSha256: audioHash };
}

async function reconcileOne(db: Db, env: Env, queue: Row, asOf: number) {
  const callId = text(queue.voice_call_id);
  if (!callId) { await db.prepare("UPDATE outbound_routing_queue SET status='queued',updated_at=? WHERE id=? AND status='ai_dialing'").bind(asOf, queue.id).run(); return { queueId: text(queue.id), status: "requeued_missing_call" }; }
  const call = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(callId).first<Row>();
  if (!call) { await db.prepare("UPDATE outbound_routing_queue SET status='blocked',updated_at=? WHERE id=?").bind(asOf, queue.id).run(); return { queueId: text(queue.id), status: "blocked_missing_ledger" }; }
  const state = text(call.state), effective = state === "ended" ? text(call.previous_state) : state;
  if (["connected", "speaking", "listening"].includes(state)) {
    try { const activation = await activateAiSession(db, env, queue, call, asOf); return { queueId: text(queue.id), status: "ai_active", activation }; }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await enqueueHumanEscalation(db, { customerId: text(queue.customer_id), leadId: text(queue.lead_id) || null, sourceId: `speech:${callId}`, reason: `AI speech stack failed after connection: ${reason}`, aiSummary: "AI audio session could not start; human follow-up required.", asOf });
      await db.prepare("UPDATE outbound_routing_queue SET status='escalated',updated_at=? WHERE id=?").bind(asOf, queue.id).run();
      return { queueId: text(queue.id), status: "escalated_speech_failure", reason };
    }
  }
  if (["ai_handoff", "handoff_requested"].includes(effective)) { await db.prepare("UPDATE outbound_routing_queue SET status='escalated',updated_at=? WHERE id=?").bind(asOf, queue.id).run(); return { queueId: text(queue.id), status: "escalated" }; }
  if (["completed"].includes(effective)) { await db.prepare("UPDATE outbound_routing_queue SET status='completed',updated_at=? WHERE id=?").bind(asOf, queue.id).run(); return { queueId: text(queue.id), status: "completed" }; }
  if (["no_answer", "busy", "provider_unavailable", "provider_error", "dial_failed"].includes(effective)) {
    const attempts = Number(queue.attempt_count || 0);
    if (attempts < OUTBOUND_AI_MAX_ATTEMPTS) {
      await db.prepare("UPDATE outbound_routing_queue SET status='queued',voice_call_id=NULL,ai_session_id=NULL,cooldown_until=?,updated_at=? WHERE id=?").bind(asOf + AI_RETRY_DELAY_MS, asOf, queue.id).run();
      return { queueId: text(queue.id), status: "retry_pending", attempt: attempts };
    }
    await db.prepare("UPDATE outbound_routing_queue SET status='exhausted',updated_at=? WHERE id=?").bind(asOf, queue.id).run();
    return { queueId: text(queue.id), status: "exhausted" };
  }
  if (effective.startsWith("blocked_")) { await db.prepare("UPDATE outbound_routing_queue SET status='blocked',updated_at=? WHERE id=?").bind(asOf, queue.id).run(); return { queueId: text(queue.id), status: "blocked", reason: effective }; }
  return { queueId: text(queue.id), status: state || "pending" };
}

export async function runOutboundAiDispatchSweep(db: Db, env: Env, input: { asOf?: number; limit?: number; actorId?: string } = {}) {
  const asOf = input.asOf ?? Date.now(), limit = Math.max(1, Math.min(50, Number(input.limit || 20))), actorId = input.actorId || "system:outbound-ai";
  await ensureOutboundAiTables(db);
  const speech = voiceProvidersStatus(env);
  const observing = await db.prepare("SELECT * FROM outbound_routing_queue WHERE lane='ai' AND status='ai_dialing' ORDER BY updated_at LIMIT ?").bind(limit).all<Row>();
  const reconciled = [];
  for (const row of observing.results || []) reconciled.push(await reconcileOne(db, env, row, asOf));
  if (!speech.voiceAutomationReady) return { dispatched: 0, blocked: 0, failed: 0, blockedBy: "speech_stack_not_ready", speech, reconciled };

  const due = await db.prepare("SELECT * FROM outbound_routing_queue WHERE lane='ai' AND status='queued' AND (callback_at IS NULL OR callback_at<=?) AND (cooldown_until IS NULL OR cooldown_until<=?) ORDER BY high_intent DESC,priority_score DESC,created_at LIMIT ?").bind(asOf, asOf, limit).all<Row>();
  let dispatched = 0, blocked = 0, failed = 0;
  const results: unknown[] = [];
  for (const queue of due.results || []) {
    const customer = await db.prepare("SELECT primary_phone,city_id FROM canonical_customers WHERE id=?").bind(queue.customer_id).first<Row>();
    if (!customer || !text(customer.primary_phone)) { blocked++; await db.prepare("UPDATE outbound_routing_queue SET status='blocked',updated_at=? WHERE id=?").bind(asOf, queue.id).run(); results.push({ queueId: text(queue.id), status: "blocked_missing_phone" }); continue; }
    const attempt = Number(queue.attempt_count || 0) + 1;
    try {
      const call = await requestOutboundVoiceCall(db, env, {
        idempotencyKey: `outbound-ai:${text(queue.id)}:${attempt}`,
        useCase: outboundVoiceUseCaseFor(queue),
        phone: text(customer.primary_phone),
        cityId: text(customer.city_id) || "blr",
        customerId: text(queue.customer_id),
        leadId: text(queue.lead_id) || null,
        bookingId: null,
        campaignId: `outbound-orchestrator:${text(queue.lifecycle_code)}`,
        actorId,
        actorPermissions: ["*"],
        asOf,
      });
      const callRow = call as unknown as Row;
      if (Boolean(callRow.dialled)) {
        dispatched++;
        await db.prepare("UPDATE outbound_routing_queue SET status='ai_dialing',voice_call_id=?,attempt_count=?,updated_at=? WHERE id=? AND lane='ai' AND status='queued'").bind(text(callRow.callId), attempt, asOf, queue.id).run();
        results.push({ queueId: text(queue.id), status: "ai_dialing", voiceCallId: text(callRow.callId), state: text(callRow.state) });
      } else {
        blocked++;
        await db.prepare("UPDATE outbound_routing_queue SET status='blocked',attempt_count=?,voice_call_id=?,updated_at=? WHERE id=?").bind(attempt, text(callRow.callId) || null, asOf, queue.id).run();
        results.push({ queueId: text(queue.id), status: "blocked", state: text(callRow.state), blockedBy: text(callRow.blockedBy) });
      }
    } catch (error) {
      failed++;
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await db.prepare("UPDATE outbound_routing_queue SET status='blocked',updated_at=? WHERE id=?").bind(asOf, queue.id).run().catch(() => undefined);
      results.push({ queueId: text(queue.id), status: "failed", reason });
    }
  }
  return { dispatched, blocked, failed, speech, reconciled, results };
}
