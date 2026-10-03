import { assertNativeDemoSession, auditNativeAttendedDemo, verifyNativeDemoStreamTicket } from "./native-attended-demo";
import { orchestrateAiTurn, type AiProviderInput, type AiResponseProvider } from "./ai-conversation-orchestrator";
import { createGroundedAiRuntimeProvider } from "./ai-grounded-runtime-provider";
import { ensureAiVoiceUatTables } from "./ai-voice-uat";
import { recordAgentStreamCompletionDisposition } from "./voice-agentstream-disposition";
import { nativeVoiceTurnDiagnostics, resolveCarrierSttLanguage, whisperInputLanguage, type CarrierSttLanguage } from "./voice-agentstream-quality";
import { transitionVoiceCall } from "./voice-outbound-governance";
import { canVoiceCallTransition, isVoiceCallState } from "./voice-call-state";
import { classifyVoiceFollowup, type VoiceHistoryMessage } from "./voice-conversation-followup";
import { DEFAULT_WORKERS_NATIVE_TTS_MODEL, NativeCarrierTtsAudioError, NativeCarrierTtsCancelledError, synthesizeNativeCarrierTts } from "./voice-native-tts";
import { beginNativeVoiceOfferTurn, cancelNativeVoiceOfferTurn, acknowledgeNativeVoiceOfferTurn, type VoiceSalesService } from "./voice-sales-specialists";
import type { AuthenticatedActor } from "./server-auth";

// Exotel AgentStream is raw signed little-endian PCM over JSON/WebSocket. This module is deliberately
// outside /api/* so the carrier socket does not pass through the browser/session gateway. The start
// event is still authenticated against an already-created Exotel call ledger row and the configured
// account SID before any audio is accepted.
export const EXOTEL_AGENTSTREAM_PATH = "/voice/exotel/agentstream";
export const EXOTEL_AGENTSTREAM_TTS_MODEL = DEFAULT_WORKERS_NATIVE_TTS_MODEL;
export const EXOTEL_AGENTSTREAM_STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const VOICE_TURN_LATENCY_TARGET_MS = 1_500;

const MAX_UTTERANCE_MS = 6_000;
const END_SILENCE_MS = 350;
const PRE_ROLL_MS = 250;
const SPEECH_RMS_THRESHOLD = 420;
const AGENTSTREAM_ACTIVE_STATES = new Set(["connected", "speaking", "listening"]);
// Exotel AgentStream outbound media is byte-bounded: each payload is 3,200–100,000 bytes and a multiple of 320.
// The carrier buffers these payloads; a clear event flushes buffered playback on barge-in.
const EXOTEL_MIN_OUTBOUND_MEDIA_BYTES = 3_200;

type Env = Record<string, unknown> & { DB: D1Database; AI?: unknown };
type Row = Record<string, unknown>;
type ProcessingStage = "start" | "opening_tts" | "opening_text" | "opening_send" | "stt" | "llm" | "turn_tts" | "turn_text" | "turn_send" | "media" | "stop";
class TransportClosed extends Error {}
class StaleGeneration extends Error {}
type AiBinding = {
  run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
};
type AgentStart = {
  stream_sid?: unknown;
  call_sid?: unknown;
  account_sid?: unknown;
  from?: unknown;
  to?: unknown;
  custom_parameters?: Record<string, unknown>;
  media_format?: { encoding?: unknown; sample_rate?: unknown; bit_rate?: unknown };
};
type AgentEvent = {
  event?: unknown;
  stream_sid?: unknown;
  start?: AgentStart;
  media?: { payload?: unknown; chunk?: unknown; timestamp?: unknown };
  mark?: { name?: unknown };
  stop?: { reason?: unknown; call_sid?: unknown };
};

type Session = {
  streamSid: string;
  providerCallId: string;
  ledgerCallId: string;
  aiCallId: string;
  threadId: string;
  customerId: string;
  sampleRate: number;
  language: CarrierSttLanguage;
  segmentIndex: number;
  reconnected: boolean;
  useCase: string;
  openingDisclosure: string;
  salesService: VoiceSalesService | undefined;
  salesDispatchItemId: string | null;
  demoExpiresAt: number | null;
};

const text = (value: unknown) => String(value ?? "").trim();

export function nativeVoiceSalesService(useCase: unknown): VoiceSalesService | undefined {
  const value = text(useCase);
  if (value === "grooming_sales") return "grooming";
  if (value === "training_sales") return "dog_training";
  return undefined;
}

function normalizedLedgerCallId(ledgerCallId: unknown) {
  const normalized = text(ledgerCallId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 96);
  if (!normalized) throw new Error("AgentStream call id cannot create a voice identity");
  return normalized;
}

export function nativeVoiceThreadId(ledgerCallId: unknown) {
  return `THREAD-VOICE-${normalizedLedgerCallId(ledgerCallId)}`;
}

export function nativeVoiceAiCallId(ledgerCallId: unknown) {
  return `AIVCALL-NATIVE-${normalizedLedgerCallId(ledgerCallId)}`;
}

function nativeVoiceParticipantId(ledgerCallId: unknown) {
  return `VOICEPART-${normalizedLedgerCallId(ledgerCallId)}`;
}
const serviceActor: AuthenticatedActor = {
  email: "exotel-agentstream@system.pawspace",
  name: "Exotel AgentStream voice service",
  roleCode: "service_exotel_agentstream",
  permissions: ["communications.manage", "customers.manage", "bookings.manage", "scheduling.book"],
  developmentPreview: false,
  identitySource: "workspace",
  principalType: "identity_subject",
  principalKey: "service:exotel-agentstream",
};

function ai(env: Env): AiBinding {
  const binding = env.AI as AiBinding | undefined;
  if (!binding || typeof binding.run !== "function") throw new Error("Workers AI binding is unavailable");
  return binding;
}

function bytesToBase64(bytes: Uint8Array) {
  let out = "";
  for (let offset = 0; offset < bytes.length; offset += 0x6000) {
    const part = bytes.subarray(offset, Math.min(bytes.length, offset + 0x6000));
    out += String.fromCharCode(...part);
  }
  return btoa(out);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function pcmRms(pcm: Uint8Array) {
  const usable = pcm.byteLength - (pcm.byteLength % 2);
  if (!usable) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, usable);
  let sum = 0;
  const samples = usable / 2;
  for (let i = 0; i < usable; i += 2) {
    const value = view.getInt16(i, true);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

function wavFromPcm16le(pcm: Uint8Array, sampleRate: number) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + pcm.byteLength, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, pcm.byteLength, true);
  return concat([new Uint8Array(header), pcm]);
}

async function openThread(db: D1Database, order: Row) {
  const customerId = text(order.customer_id), id = nativeVoiceThreadId(order.id), now = Date.now();
  await db.prepare("INSERT OR IGNORE INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,?,?,NULL,'open','ai-orchestrator',NULL,?,?)")
    .bind(id, customerId, text(order.booking_id) || null, text(order.lead_id) || null, now, now).run();
  const existing = await db.prepare("SELECT id,customer_id,status FROM communication_threads WHERE id=?").bind(id).first<Row>();
  if (!existing || text(existing.customer_id) !== customerId) throw new Error("AgentStream voice thread/customer mismatch");
  if (text(existing.status) === "closed") throw new Error("AgentStream voice thread is closed");
  await db.prepare("INSERT OR IGNORE INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'customer',?)")
    .bind(nativeVoiceParticipantId(order.id), id, "customer", customerId, customerId, now).run();
  return id;
}

export async function nativeVoiceConversationHistory(db: D1Database, threadId: string, customerId: string): Promise<VoiceHistoryMessage[]> {
  const rows = await db.prepare("SELECT direction,payload_json FROM communication_messages WHERE thread_id=? AND customer_id=? AND channel='voice' ORDER BY created_at DESC LIMIT 32")
    .bind(threadId, customerId).all<Row>();
  const history: VoiceHistoryMessage[] = [];
  for (const row of [...rows.results].reverse()) {
    const direction = text(row.direction);
    if (direction !== "inbound" && direction !== "outbound") continue;
    let payload: Row = {};
    try { payload = JSON.parse(text(row.payload_json) || "{}") as Row; } catch { continue; }
    const content = text(payload.text).slice(0, 1000);
    if (content) history.push({ role: direction === "inbound" ? "user" : "assistant", content });
  }
  return history;
}

async function ensureAgentStreamConnected(db: D1Database, order: Row) {
  const callId = text(order.id), state = text(order.state);
  if (AGENTSTREAM_ACTIVE_STATES.has(state)) return;
  if (state !== "dialing" && state !== "ringing") throw new Error("AgentStream call is not connected in the canonical voice ledger");
  try {
    await transitionVoiceCall(db, {
      callId,
      to: "connected",
      reason: "authenticated_agentstream_start",
      actor: serviceActor.email,
      detail: { source: "exotel_agentstream_start" },
    });
  } catch (error) {
    const current = await db.prepare("SELECT state FROM voice_call_orders WHERE id=?").bind(callId).first<Row>();
    if (!current || !AGENTSTREAM_ACTIVE_STATES.has(text(current.state))) throw error;
  }
}

async function establishSession(env: Env, start: AgentStart, demoTicketCallId: string | null = null): Promise<Session> {
  await ensureAiVoiceUatTables(env.DB);
  const providerCallId = text(start.call_sid), accountSid = text(start.account_sid), streamSid = text(start.stream_sid);
  if (!providerCallId || !streamSid) throw new Error("AgentStream start is missing call_sid or stream_sid");
  if (!accountSid || accountSid !== text(env.EXOTEL_SID)) throw new Error("AgentStream account_sid does not match the configured Exotel account");
  const order = await env.DB.prepare("SELECT id,customer_id,lead_id,booking_id,use_case,state,provider,provider_call_id,ai_call_id,consent_decision,opt_out_decision,mode FROM voice_call_orders WHERE provider='exotel' AND provider_call_id=? ORDER BY requested_at DESC LIMIT 1").bind(providerCallId).first<Row>();
  if (!order) throw new Error("AgentStream call is not present in the governed outbound ledger");
  if (demoTicketCallId ? text(order.id)!==demoTicketCallId : text(order.id).startsWith("NDEMO-")) throw new Error("Native demo requires its exact authenticated stream ticket");
  if (!text(order.customer_id)) throw new Error("AgentStream voice AI requires a canonical customer");
  if (text(order.consent_decision) !== "granted" || text(order.opt_out_decision) !== "clear") throw new Error("AgentStream call has no current voice consent or is opted out");
  if (text(env.PAWSPACE_VOICE_ENV) === "uat" && text(order.mode) !== "uat") throw new Error("AgentStream UAT cannot bind a non-UAT call");

  const customerId = text(order.customer_id), useCase = text(order.use_case);
  const demoExpiresAt = await assertNativeDemoSession(env.DB,env,text(order.id),customerId,true);
  const script = await env.DB.prepare("SELECT opening_disclosure,active FROM voice_call_scripts WHERE use_case=?").bind(useCase).first<Row>();
  const openingDisclosure = demoExpiresAt ? `${text(script?.opening_disclosure)} This is your attended demo. I can explain services and quotes, but cannot create bookings, reserve slots or take payments.` : text(script?.opening_disclosure);
  if (!script || Number(script.active) !== 1 || !openingDisclosure || openingDisclosure.length > 1200) throw new Error("AgentStream opening disclosure is unavailable");
  const sampleRate = Number(start.media_format?.sample_rate || 8000);
  if (![8000, 16000, 24000].includes(sampleRate)) throw new Error("AgentStream sample rate is unsupported");
  const requestedLanguage = resolveCarrierSttLanguage(env.VOICE_AGENTSTREAM_STT_LANGUAGE);
  await ensureAgentStreamConnected(env.DB, order);

  const threadId = await openThread(env.DB, order), aiCallId = nativeVoiceAiCallId(order.id), now = Date.now();
  if (text(order.ai_call_id) && text(order.ai_call_id) !== aiCallId) throw new Error("AgentStream call is already bound to a different AI voice ledger");
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO ai_voice_calls (id,thread_id,customer_id,transport_provider,direction,status,consent_status,language,started_at,created_by) VALUES (?,?,?,'exotel','outbound','active','verified',?,?,?)")
    .bind(aiCallId, threadId, customerId, requestedLanguage, now, serviceActor.email).run();
  const created = Number(inserted.meta?.changes || 0) === 1;
  const existingAiCall = await env.DB.prepare("SELECT id,thread_id,customer_id,status,language FROM ai_voice_calls WHERE id=?").bind(aiCallId).first<Row>();
  if (!existingAiCall || text(existingAiCall.thread_id) !== threadId || text(existingAiCall.customer_id) !== customerId || text(existingAiCall.status) !== "active") {
    throw new Error("AgentStream AI voice ledger does not match the governed call");
  }
  const language = resolveCarrierSttLanguage(existingAiCall.language);
  if (!created) await env.DB.prepare("UPDATE ai_voice_calls SET reconnect_count=reconnect_count+1 WHERE id=? AND status='active'").bind(aiCallId).run();
  const segment = await env.DB.prepare("SELECT COALESCE(MAX(segment_index),-1)+1 AS n FROM ai_voice_segments WHERE call_id=?").bind(aiCallId).first<Row>();
  const segmentIndex = Number(segment?.n ?? 0);
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) throw new Error("AgentStream segment sequence is invalid");

  await env.DB.batch([
    env.DB.prepare("UPDATE voice_call_orders SET ai_call_id=?,transcript_ref=?,updated_at=? WHERE id=? AND provider_call_id=? AND (ai_call_id IS NULL OR ai_call_id=?)")
      .bind(aiCallId, aiCallId, now, text(order.id), providerCallId, aiCallId),
    env.DB.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), aiCallId, created ? "agentstream_started" : "agentstream_reconnected", JSON.stringify({ provider: "exotel", streamSid, sampleRate, encoding: "linear16", sttLanguage: language, ttsLanguage: "en" }), now),
  ]);
  const salesService = nativeVoiceSalesService(useCase);
  const routing=await env.DB.prepare("SELECT context_json FROM outbound_routing_queue WHERE voice_call_id=? ORDER BY updated_at DESC LIMIT 1").bind(order.id).first<Row>();
  let salesDispatchItemId:string|null=null;try{salesDispatchItemId=text((JSON.parse(text(routing?.context_json)||"{}")as Row).aiSalesDispatchItemId)||null;}catch{}
  return { streamSid, providerCallId, ledgerCallId: text(order.id), aiCallId, threadId, customerId, sampleRate, language, segmentIndex, reconnected: !created, useCase, openingDisclosure, salesService, salesDispatchItemId, demoExpiresAt };
}
async function recordSegment(env: Env, session: Session, speaker: "customer" | "assistant", transcript: string, confidence: number | null, provider: AiResponseProvider | null, guard?: () => void) {
  if (session.demoExpiresAt) await assertNativeDemoSession(env.DB,env,session.ledgerCallId,session.customerId);
  const messageId = `MSG-VOICE-${crypto.randomUUID().slice(0, 12).toUpperCase()}`, now = Date.now(), index = session.segmentIndex++;
  const turnKey = `exotel-agentstream:${session.providerCallId}:${index}`;
  if (speaker === "customer" && provider) { await beginNativeVoiceOfferTurn(env.DB,turnKey,session.threadId,session.customerId); guard?.(); }
  const direction = speaker === "customer" ? "inbound" : "outbound";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,?,'voice','transactional','voice_transcript_segment',?,'received',?,NULL,?,?,?, ?,?)")
      .bind(messageId, session.threadId, session.customerId, direction, JSON.stringify({ text: transcript, segmentIndex: index }), speaker === "customer" ? "workers_ai" : "exotel_agentstream", `voice:${session.aiCallId}:${index}:${speaker}`, JSON.stringify({ consentVerified: true, carrierStream: true }), serviceActor.email, now, now),
    env.DB.prepare("INSERT INTO ai_voice_segments (id,call_id,message_id,segment_index,speaker,transcript_text,stt_provider,stt_confidence,interrupted,created_at) VALUES (?,?,?,?,?,?,?,?,0,?)")
      .bind(crypto.randomUUID(), session.aiCallId, messageId, index, speaker, transcript, speaker === "customer" ? EXOTEL_AGENTSTREAM_STT_MODEL : null, confidence, now),
  ]);
  if (speaker !== "customer" || !provider) return { output: transcript, outcome: "recorded" };
  const conversationHistory = await nativeVoiceConversationHistory(env.DB, session.threadId, session.customerId);
  const voiceFollowupIntent = classifyVoiceFollowup(transcript, conversationHistory);
  const contextualProvider: AiResponseProvider = {
    ...provider,
    async generate(input: AiProviderInput) {
      return provider.generate({
        ...input,
        context: { ...input.context, conversationHistory, asOf: now },
      });
    },
  };
  const turn = await orchestrateAiTurn(env.DB, {
    actor: session.demoExpiresAt ? {...serviceActor,permissions:["communications.manage","customers.manage"]} : serviceActor,
    threadId: session.threadId,
    customerId: session.customerId,
    inputMessageId: messageId,
    idempotencyKey: turnKey,
    nativeTurnKey: turnKey,
    assertCurrent: guard,
    channel: "voice",
    provider: contextualProvider,
    voiceFollowupIntent,
  });
  const row = (turn.turn || null) as Row | null;
  return { turnKey, output: text(row?.output || row?.output_text), outcome: text(row?.outcome) || (row ? "draft_review_required" : "pending") };
}

async function transcribe(env: Env, pcm: Uint8Array, sampleRate: number, language: CarrierSttLanguage) {
  const started = Date.now();
  const model = text(env.VOICE_STT_MODEL) || EXOTEL_AGENTSTREAM_STT_MODEL;
  const input: Record<string, unknown> = { audio: Array.from(wavFromPcm16le(pcm, sampleRate)), vad_filter: true };
  const requestedLanguage = whisperInputLanguage(language);
  if (requestedLanguage) input.language = requestedLanguage;
  const result = await ai(env).run(model, input);
  if (!result || typeof result !== "object") throw new Error("Whisper returned no result object");
  const record = result as Record<string, unknown>;
  const transcript = text(record.text ?? record.transcription);
  const raw = Number(record.confidence);
  const detectedLanguage = text(record.language).toLowerCase().slice(0, 32) || (requestedLanguage ?? null);
  return { text: transcript, confidence: Number.isFinite(raw) ? raw : (transcript ? 0.9 : 0), latencyMs: Date.now() - started, detectedLanguage, model };
}

async function synthesizeLinear16(env: Env, output: string, sampleRate: number, signal?: AbortSignal) {
  const started = Date.now();
  // TTS selection now returns validated PCM as a stream. ElevenLabs can begin playback before the
  // full response exists; Workers AI remains a validated buffered fallback behind the same boundary.
  const synthesized = await synthesizeNativeCarrierTts(env, output, sampleRate, { signal });
  return { stream: synthesized.result, readyMs: Date.now() - started, provider: synthesized.provider, model: synthesized.model, fallbackUsed: synthesized.fallbackUsed };
}

function sendAudioFrame(socket: WebSocket, session: Session, raw: Uint8Array, terminal = false) {
  if (socket.readyState !== 1) throw new TransportClosed();
  const paddedLength = terminal ? Math.max(EXOTEL_MIN_OUTBOUND_MEDIA_BYTES, Math.ceil(raw.byteLength / 320) * 320) : raw.byteLength;
  const chunk = paddedLength === raw.byteLength ? raw : (() => { const value = new Uint8Array(paddedLength); value.set(raw); return value; })();
  socket.send(JSON.stringify({ event: "media", stream_sid: session.streamSid, media: { payload: bytesToBase64(chunk) } }));
}

async function sendAudioStream(socket: WebSocket, session: Session, stream: ReadableStream<Uint8Array>, markName: string, options: {
  signal: AbortSignal;
  isCurrent(): boolean;
  turnStarted: number;
  onFirstAudio(firstAudioMs: number): void;
}) {
  const reader = stream.getReader();
  let pending = new Uint8Array(), bytes = 0, frames = 0, firstAudioMs: number | null = null;
  const assertCurrent = () => {
    if (options.signal.aborted || !options.isCurrent()) throw new StaleGeneration();
    if (socket.readyState !== 1) throw new TransportClosed();
  };
  try {
    while (true) {
      assertCurrent();
      const next = await reader.read();
      assertCurrent();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || !next.value.byteLength) continue;
      bytes += next.value.byteLength;
      pending = pending.byteLength ? concat([pending, next.value]) : new Uint8Array(next.value);
      while (pending.byteLength >= EXOTEL_MIN_OUTBOUND_MEDIA_BYTES) {
        assertCurrent();
        sendAudioFrame(socket, session, pending.subarray(0, EXOTEL_MIN_OUTBOUND_MEDIA_BYTES));
        pending = pending.subarray(EXOTEL_MIN_OUTBOUND_MEDIA_BYTES); frames++;
        if (firstAudioMs === null) { firstAudioMs = Date.now() - options.turnStarted; options.onFirstAudio(firstAudioMs); }
      }
    }
    assertCurrent();
    if (pending.byteLength) {
      sendAudioFrame(socket, session, pending, true); frames++;
      if (firstAudioMs === null) { firstAudioMs = Date.now() - options.turnStarted; options.onFirstAudio(firstAudioMs); }
    }
    if (!frames) throw new NativeCarrierTtsAudioError("empty_audio");
    assertCurrent();
    socket.send(JSON.stringify({ event: "mark", stream_sid: session.streamSid, mark: { name: markName } }));
    return { frames, bytes, firstAudioMs: firstAudioMs ?? 0 };
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally { try { reader.releaseLock(); } catch {} }
}

async function recordStreamDiagnostic(env: Env, session: Session, event: string, detail: Row) {
  // Only bounded counters, enums and locally generated mark names. Never persist provider errors,
  // transcripts, request URLs, headers, credentials, or provider response bodies here.
  await env.DB.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)")
    .bind(crypto.randomUUID(), session.aiCallId, event, JSON.stringify(detail), Date.now()).run();
}

async function recordTransportInterruption(env: Env, session: Session | null, reason: string) {
  if (!session) return;
  await env.DB.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)")
    .bind(crypto.randomUUID(), session.aiCallId, "agentstream_transport_interrupted", JSON.stringify({ reason, streamSid: session.streamSid }), Date.now())
    .run().catch(() => undefined);
}

async function closeSession(env: Env, session: Session | null, reason: string, failed = false) {
  if (!session) return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE ai_voice_calls SET status=CASE WHEN status='active' THEN ? ELSE status END,outcome=COALESCE(outcome,?),disposition=COALESCE(disposition,?),ended_at=COALESCE(ended_at,?) WHERE id=?").bind(failed ? "failed" : "completed", failed ? "provider_failure" : "carrier_ended", reason, now, session.aiCallId),
    env.DB.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), session.aiCallId, "agentstream_stopped", JSON.stringify({ reason }), now),
  ]).catch(() => undefined);
  try {
    const disposition = await recordAgentStreamCompletionDisposition(env.DB,{ledgerCallId:session.ledgerCallId,aiCallId:session.aiCallId,providerCallId:session.providerCallId,reason,actorId:serviceActor.email});
    await env.DB.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),session.aiCallId,"agentstream_crm_disposition",JSON.stringify(disposition),Date.now()).run();
  } catch (error) {
    await env.DB.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),session.aiCallId,"agentstream_crm_disposition_failed",JSON.stringify({reason:text((error as Error)?.message).slice(0,160)}),Date.now()).run().catch(()=>undefined);
  }
}

export async function handleExotelAgentStream(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  if (new URL(request.url).pathname !== EXOTEL_AGENTSTREAM_PATH) return new Response("Not found", { status: 404 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
  let demoTicketCallId:string|null=null;
  try{demoTicketCallId=await verifyNativeDemoStreamTicket(env.DB,env,request);}catch{return new Response("Native demo stream admission refused",{status:403});}
  if (!demoTicketCallId && text(env.PAWSPACE_VOICE_ENV) !== "uat" && text(env.PAWSPACE_VOICE_ENV) !== "live") return new Response("Voice carrier streaming is disabled", { status: 403 });
  if (!env.AI) return new Response("Workers AI binding is unavailable", { status: 503 });

  const Pair = (globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: WebSocket } }).WebSocketPair;
  const pair = new Pair(), client = pair[0], server = pair[1];
  (server as WebSocket & { accept(): void }).accept();

  let session: Session | null = null;
  let transportOpen = true, terminated = false;
  let currentMark: string | null = null;
  const pendingMarks = new Map<string, { session: Session; queuedAt: number; bytes: number; frames: number; turnKey?: string; version: number }>();
  let providerPromise: Promise<AiResponseProvider> | null = null;
  let speechParts: Uint8Array[] = [], preRoll: Uint8Array[] = [], speechStartedAt = 0, silenceMs = 0, assistantPlaying = false;
  let speechGeneration = 0, generationVersion = 0;
  const activeTtsControllers = new Set<AbortController>();
  let controlChain = Promise.resolve();
  let activeOfferTurnKey: string | null = null;
  let authorityFence: Promise<unknown> = Promise.resolve();

  const assertLive = (active: Session) => {
    if (!transportOpen || terminated || server.readyState !== 1 || session !== active) throw new TransportClosed();
    if (active.demoExpiresAt && Date.now() >= active.demoExpiresAt) throw new Error("Native attended demo expired");
  };
  const isCurrent = (active: Session, version: number) =>
    transportOpen && !terminated && server.readyState === 1 && session === active && generationVersion === version && (!active.demoExpiresAt || Date.now() < active.demoExpiresAt);
  const assertCurrent = (active: Session, version: number) => {
    assertLive(active);
    if (generationVersion !== version) throw new StaleGeneration();
  };
  const diagnostic = (active: Session, event: string, detail: Row) => recordStreamDiagnostic(env, active, event, detail).catch(() => undefined);

  const cancelStaleGeneration = (active: Session, reason: "caller_speech" | "stop" | "transport_closed") => {
    const hadGeneration = activeTtsControllers.size > 0, hadPlayback = assistantPlaying;
    const cancelledKeys = new Set([...pendingMarks.values()].map(mark => mark.turnKey).filter((key): key is string => Boolean(key)));
    if (activeOfferTurnKey) cancelledKeys.add(activeOfferTurnKey);
    activeOfferTurnKey = null;
    if (cancelledKeys.size) {
      authorityFence = authorityFence.then(() => Promise.all([...cancelledKeys].map(key => cancelNativeVoiceOfferTurn(env.DB,key,active.threadId,active.customerId))));
      ctx.waitUntil(authorityFence.catch(error => failProcessing(error,active,"llm",Date.now())));
    }

    generationVersion++;
    for (const controller of activeTtsControllers) controller.abort();
    activeTtsControllers.clear();
    if (hadPlayback && transportOpen && server.readyState === 1 && session === active) {
      server.send(JSON.stringify({ event: "clear", stream_sid: active.streamSid }));
    }
    pendingMarks.clear(); currentMark = null; assistantPlaying = false;
    if (reason === "caller_speech" && (hadGeneration || hadPlayback)) {
      ctx.waitUntil(diagnostic(active, "agentstream_barge_in", {
        generation: generationVersion,
        generationCancelled: hadGeneration,
        playbackCleared: hadPlayback,
      }));
    }
    return generationVersion;
  };

  const failProcessing = async (error: unknown, active: Session | null, stage: ProcessingStage, startedAt: number, version?: number) => {
    if (error instanceof TransportClosed || !transportOpen || server.readyState !== 1) {
      if (active) await diagnostic(active, "agentstream_processing_abandoned", {
        stage, reason: "transport_closed", elapsedMs: Math.min(600_000, Date.now() - startedAt),
      });
      if (!transportOpen) session = null;
      return;
    }
    if (error instanceof StaleGeneration || error instanceof NativeCarrierTtsCancelledError || (version !== undefined && version !== generationVersion)) {
      if (active) await diagnostic(active, "agentstream_generation_cancelled", {
        stage, reason: "superseded_by_caller", elapsedMs: Math.min(600_000, Date.now() - startedAt),
      });
      return;
    }
    terminated = true;
    const cancelledKeys = new Set([...pendingMarks.values()].map(mark => mark.turnKey).filter((key): key is string => Boolean(key)));
    if (activeOfferTurnKey) cancelledKeys.add(activeOfferTurnKey);
    activeOfferTurnKey = null;
    const cancelledSession = active;
    if (cancelledKeys.size && cancelledSession) {
      authorityFence = authorityFence.then(() => Promise.all([...cancelledKeys].map(key => cancelNativeVoiceOfferTurn(env.DB,key,cancelledSession.threadId,cancelledSession.customerId))));
      ctx.waitUntil(authorityFence.catch(error => failProcessing(error,cancelledSession,"llm",Date.now())));
    }
    generationVersion++;
    for (const controller of activeTtsControllers) controller.abort(); activeTtsControllers.clear();
    if (active) {
      const code = error instanceof NativeCarrierTtsAudioError ? error.code : "processing_exception";
      await diagnostic(active, "agentstream_processing_failed", {
        stage, code, elapsedMs: Math.min(600_000, Date.now() - startedAt),
      });
      const ttsFailure = error instanceof NativeCarrierTtsAudioError || stage === "opening_tts" || stage === "turn_tts";
      const to = stage === "stt" ? "stt_failed" : ttsFailure ? "tts_failed" : "provider_error";
      try {
        const row = await env.DB.prepare("SELECT state FROM voice_call_orders WHERE id=?").bind(active.ledgerCallId).first<Row>();
        if (isVoiceCallState(row?.state) && canVoiceCallTransition(row.state, to)) {
          await transitionVoiceCall(env.DB, {
            callId: active.ledgerCallId,
            to,
            reason: "agentstream_processing_failed",
            actor: serviceActor.email,
            detail: { source: "exotel_agentstream", stage, code },
          });
        }
      } catch {
        await diagnostic(active, "agentstream_ledger_reconciliation_failed", { stage, target: to });
      }
    }
    await closeSession(env, active, "agentstream_error", true);
    try { server.close(1011, "AgentStream processing failed"); } catch {}
  };

  const queueAudio = async (
    active: Session,
    stream: ReadableStream<Uint8Array>,
    markName: string,
    version: number,
    turnStarted: number,
    controller: AbortController,
    purpose: "opening" | "turn",
  ) => {
    assertCurrent(active, version);
    const queuedAt = Date.now();
    const sent = await sendAudioStream(server, active, stream, markName, {
      signal: controller.signal,
      isCurrent: () => isCurrent(active, version),
      turnStarted,
      onFirstAudio(firstAudioMs) {
        assistantPlaying = true;
        currentMark = markName;
        ctx.waitUntil(diagnostic(active, "agentstream_first_audio", {
          purpose, firstAudioMs: Math.min(600_000, firstAudioMs), sampleRate: active.sampleRate,
        }));
      },
    });
    assertCurrent(active, version);
    if (pendingMarks.size >= 32) pendingMarks.delete(pendingMarks.keys().next().value!);
    pendingMarks.set(markName, { session: active, queuedAt, bytes: sent.bytes, frames: sent.frames, version, ...(purpose === "turn" && activeOfferTurnKey ? { turnKey: activeOfferTurnKey } : {}) });
    currentMark = markName;
    ctx.waitUntil(diagnostic(active, "agentstream_audio_queued", {
      markName, bytes: sent.bytes, frames: sent.frames, sampleRate: active.sampleRate,
      firstAudioMs: Math.min(600_000, sent.firstAudioMs),
    }));
    return sent;
  };

  const runOpening = async (active: Session, version: number) => {
    const startedAt = Date.now();
    let taskStage: ProcessingStage = "opening_tts";
    const controller = new AbortController();
    activeTtsControllers.add(controller);
    try {
      assertCurrent(active, version);
      ctx.waitUntil(diagnostic(active, "agentstream_speech_started", { purpose: "opening", stage: taskStage, sampleRate: active.sampleRate }));
      const greeting = await synthesizeLinear16(env, active.openingDisclosure, active.sampleRate, controller.signal);
      assertCurrent(active, version);
      ctx.waitUntil(diagnostic(active, "agentstream_text_generated", {
        purpose: "opening",
        chars: active.openingDisclosure.length,
        ttsMs: Math.min(600_000, greeting.readyMs),
        ttsProvider: greeting.provider,
        ttsModel: greeting.model,
        ttsFallbackUsed: greeting.fallbackUsed,
      }));
      taskStage = "opening_send";
      await queueAudio(active, greeting.stream, `opening-${active.segmentIndex}-end`, version, startedAt, controller, "opening");
      assertCurrent(active, version);
      taskStage = "opening_text";
      await recordSegment(env, active, "assistant", active.openingDisclosure, null, null);
      assertCurrent(active, version);
    } catch (error) {
      await failProcessing(error, active, taskStage, startedAt, version);
    } finally {
      activeTtsControllers.delete(controller);
    }
  };

  const processUtterance = async (pcm: Uint8Array, active: Session, version: number) => {
    const turnStarted = Date.now();
    let taskStage: ProcessingStage = "stt";
    let controller: AbortController | null = null;
    try {
      assertCurrent(active, version);
      const stt = await transcribe(env, pcm, active.sampleRate, active.language);
      assertCurrent(active, version);
      if (!stt.text) return;

      const llmStarted = Date.now();
      taskStage = "llm";
      providerPromise ||= createGroundedAiRuntimeProvider(env.DB, serviceActor, "voice", {
        dispatchItemId: active.salesDispatchItemId,
        salesService: active.salesService,
      });
      const provider = await providerPromise;
      assertCurrent(active, version);
      await authorityFence;
      assertCurrent(active,version);
      activeOfferTurnKey = `exotel-agentstream:${active.providerCallId}:${active.segmentIndex}`;
      const generated = await recordSegment(env, active, "customer", stt.text, stt.confidence, provider, () => assertCurrent(active,version));
      assertCurrent(active, version);
      const llmMs = Date.now() - llmStarted;
      if (!generated.output) return;

      taskStage = "turn_tts";
      controller = new AbortController();
      activeTtsControllers.add(controller);
      const tts = await synthesizeLinear16(env, generated.output, active.sampleRate, controller.signal);
      assertCurrent(active, version);

      ctx.waitUntil(diagnostic(active, "agentstream_text_generated", {
        purpose: "turn", chars: Math.min(1_000_000, generated.output.length),
        ttsMs: Math.min(600_000, tts.readyMs), ttsProvider: tts.provider,
        ttsModel: tts.model, ttsFallbackUsed: tts.fallbackUsed,
      }));

      taskStage = "turn_send";
      const markName = `turn-${active.segmentIndex}-end`;
      const sent = await queueAudio(active, tts.stream, markName, version, turnStarted, controller, "turn");
      assertCurrent(active, version);
      taskStage = "turn_text";
      await recordSegment(env, active, "assistant", generated.output, null, null);
      assertCurrent(active, version);
      const totalMs = Date.now() - turnStarted;
      const diagnostics = nativeVoiceTurnDiagnostics({
        configuredSttLanguage: active.language,
        detectedSttLanguage: stt.detectedLanguage,
        sampleRate: active.sampleRate,
        pcmBytes: pcm.byteLength,
        sttMs: stt.latencyMs,
        llmMs,
        ttsMs: tts.readyMs,
        firstAudioMs: sent.firstAudioMs,
        totalMs,
        latencyTargetMs: VOICE_TURN_LATENCY_TARGET_MS,
        transcriptChars: stt.text.length,
        assistantChars: generated.output.length,
        sttModel: stt.model,
        ttsModel: tts.model,
        ttsProvider: tts.provider,
        ttsFallbackUsed: tts.fallbackUsed,
        outcome: generated.outcome,
      });
      await env.DB.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)").bind(
        crypto.randomUUID(), active.aiCallId, "agentstream_turn", JSON.stringify(diagnostics), Date.now(),
      ).run();
    } catch (error) {
      await failProcessing(error, active, taskStage, turnStarted, version);
    } finally {
      if (controller) activeTtsControllers.delete(controller);
    }
  };

  const handleMedia = (incoming: AgentEvent) => {
    const active = session;
    if (!active || !transportOpen || terminated) return;
    const startedAt = Date.now();
    try {
      const payload = text(incoming.media?.payload);
      if (!payload) return;
      let pcm: Uint8Array;
      try { pcm = base64ToBytes(payload); } catch { server.close(1007, "Invalid base64 media"); return; }
      if (!pcm.byteLength || pcm.byteLength % 2) { server.close(1007, "Invalid PCM media"); return; }
      const frameMs = Math.max(1, Math.round((pcm.byteLength / 2 / active.sampleRate) * 1000));
      const speech = pcmRms(pcm) >= SPEECH_RMS_THRESHOLD;
      preRoll.push(pcm);
      while (preRoll.reduce((sum, item) => sum + item.byteLength, 0) > active.sampleRate * 2 * (PRE_ROLL_MS / 1000)) preRoll.shift();

      if (speech) {
        if (!speechStartedAt) {
          speechStartedAt = Date.now();
          speechParts = [...preRoll];
          speechGeneration = cancelStaleGeneration(active, "caller_speech");
        } else speechParts.push(pcm);
        silenceMs = 0;
      } else if (speechStartedAt) {
        speechParts.push(pcm); silenceMs += frameMs;
      }

      const elapsed = speechStartedAt ? Date.now() - speechStartedAt : 0;
      if (speechStartedAt && (silenceMs >= END_SILENCE_MS || elapsed >= MAX_UTTERANCE_MS)) {
        const utterance = concat(speechParts), version = speechGeneration;
        speechParts = []; preRoll = []; speechStartedAt = 0; silenceMs = 0;
        ctx.waitUntil(processUtterance(utterance, active, version));
      }
    } catch (error) {
      ctx.waitUntil(failProcessing(error, active, "media", startedAt));
    }
  };

  server.addEventListener("message", (event: MessageEvent) => {
    let incoming: AgentEvent;
    try { incoming = JSON.parse(String(event.data)) as AgentEvent; }
    catch { server.close(1003, "Malformed AgentStream JSON"); return; }
    const kind = text(incoming.event);

    // Media intake never waits behind STT, model generation or speech rendering. If the authenticated
    // start is still being established, wait only for that control operation without joining its queue.
    if (kind === "media") {
      if (session) handleMedia(incoming);
      else {
        const ready = controlChain;
        ctx.waitUntil(ready.then(() => { if (session) handleMedia(incoming); }));
      }
      return;
    }

    let eventStage: ProcessingStage = "start";
    const eventStarted = Date.now();
    controlChain = controlChain.then(async () => {
      if (!transportOpen || terminated) return;
      if (kind === "connected") return;
      if (kind === "start") {
        eventStage = "start";
        if (session) { server.close(1002, "Duplicate AgentStream start"); return; }
        const active = await establishSession(env, incoming.start || {},demoTicketCallId);
        session = active;
        if (active.demoExpiresAt) {
          let checking=false;
          const revocationTimer=setInterval(()=>{if(session!==active||terminated){clearInterval(revocationTimer);return;}if(checking)return;checking=true;ctx.waitUntil(assertNativeDemoSession(env.DB,env,active.ledgerCallId,active.customerId).then(()=>{},error=>failProcessing(error,active,"stop",Date.now())).finally(()=>{checking=false;}));},1000);
          const expiryTimer=setTimeout(()=>{ctx.waitUntil(failProcessing(new Error("Native attended demo expired"),active,"stop",Date.now()));},Math.max(0,active.demoExpiresAt-Date.now()));
          server.addEventListener("close",()=>{clearTimeout(expiryTimer);clearInterval(revocationTimer);ctx.waitUntil(auditNativeAttendedDemo(env.DB,active.ledgerCallId,"ended"));});
        }
        assertLive(active);
        if (!active.reconnected) ctx.waitUntil(runOpening(active, generationVersion));
        return;
      }
      if (kind === "mark") {
        const name = text(incoming.mark?.name), pending = pendingMarks.get(name);
        if (pending && (!incoming.stream_sid || text(incoming.stream_sid) === pending.session.streamSid)) {
          if (pending.turnKey) {
            assertCurrent(pending.session,pending.version);
            await acknowledgeNativeVoiceOfferTurn(env.DB,pending.turnKey,pending.session.threadId,pending.session.customerId);
            assertCurrent(pending.session,pending.version);
            if (activeOfferTurnKey === pending.turnKey) activeOfferTurnKey = null;
          }
          pendingMarks.delete(name);
          if (currentMark === name) { assistantPlaying = false; currentMark = null; }
          ctx.waitUntil(diagnostic(pending.session, "agentstream_audio_mark_ack", {
            markName: name, bytes: pending.bytes, frames: pending.frames,
            ackMs: Math.min(600_000, Date.now() - pending.queuedAt),
          }));
        }
        return;
      }
      if (kind === "stop") {
        eventStage = "stop";
        const active = session;
        terminated = true;
        if (active) cancelStaleGeneration(active, "stop");
        await closeSession(env, active, "callended");
        session = null;
        server.close(1000, "Call ended");
      }
    }).catch(error => failProcessing(error, session, eventStage, eventStarted));
    ctx.waitUntil(controlChain);
  });

  server.addEventListener("close", () => {
    transportOpen = false;
    const active = session;
    if (active) cancelStaleGeneration(active, "transport_closed");
    pendingMarks.clear(); currentMark = null;
    session = null;
    ctx.waitUntil(recordTransportInterruption(env, active, "socket_closed"));
  });
  server.addEventListener("error", () => {
    transportOpen = false;
    const active = session;
    if (active) cancelStaleGeneration(active, "transport_closed");
    pendingMarks.clear(); currentMark = null;
    ctx.waitUntil(recordTransportInterruption(env, active, "socket_error"));
  });

  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
}
