import { aiProviderConnection, requestAiDraft } from "./ai-provider-adapter";
import { orchestrateAiTurn, type AiProviderInput, type AiResponseProvider } from "./ai-conversation-orchestrator";
import { ensureAiVoiceUatTables } from "./ai-voice-uat";
import type { AuthenticatedActor } from "./server-auth";

// Exotel AgentStream is raw signed little-endian PCM over JSON/WebSocket. This module is deliberately
// outside /api/* so the carrier socket does not pass through the browser/session gateway. The start
// event is still authenticated against an already-created Exotel call ledger row and the configured
// account SID before any audio is accepted.
export const EXOTEL_AGENTSTREAM_PATH = "/voice/exotel/agentstream";
export const EXOTEL_AGENTSTREAM_TTS_MODEL = "@cf/deepgram/aura-2-en";
export const EXOTEL_AGENTSTREAM_STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const VOICE_TURN_LATENCY_TARGET_MS = 1_500;

const MAX_UTTERANCE_MS = 6_000;
const END_SILENCE_MS = 350;
const PRE_ROLL_MS = 250;
const SPEECH_RMS_THRESHOLD = 420;
const OUTBOUND_CHUNK_BYTES = 3_200;

type Env = Record<string, unknown> & { DB: D1Database; AI?: unknown };
type Row = Record<string, unknown>;
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
  language: string;
  segmentIndex: number;
};

const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const serviceActor: AuthenticatedActor = {
  email: "exotel-agentstream@system.pawspace",
  name: "Exotel AgentStream voice service",
  roleCode: "service_exotel_agentstream",
  permissions: ["communications.manage", "customers.manage", "bookings.manage"],
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

async function responseBytes(result: unknown): Promise<Uint8Array> {
  if (result instanceof Response) return new Uint8Array(await result.arrayBuffer());
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof ReadableStream) return new Uint8Array(await new Response(result).arrayBuffer());
  if (result && typeof result === "object") {
    const audio = text((result as Record<string, unknown>).audio);
    if (audio) return base64ToBytes(audio);
  }
  throw new Error("TTS model returned no audio bytes");
}

async function runtimeProvider(): Promise<AiResponseProvider> {
  const connection = await aiProviderConnection();
  const systemPrompt = "Reply as PawSpace's voice assistant. Keep the answer short enough to speak naturally, use only the supplied canonical context, never invent availability, pricing, discounts, payment/refund outcomes or completed actions, and allow the existing handoff policy to take over for risky or unsupported requests.";
  return {
    status: connection.connected ? "connected" : "not_connected",
    provider: connection.providerRef || "not_connected",
    modelRef: connection.modelRef,
    deadlineMs: connection.timeoutMs,
    async generate(input: AiProviderInput) {
      const result = await requestAiDraft({
        systemPrompt,
        userPrompt: JSON.stringify({ channel: "voice", customerMessage: input.inputText, intent: input.intent, canonicalContext: input.context }),
        maxTokens: 280,
      });
      if (!result.connected) return { text: "", provider: connection.providerRef || "not_connected", modelRef: connection.modelRef, latencyMs: 0, unsupported: true };
      return { text: result.text, provider: result.providerRef, modelRef: result.modelRef, latencyMs: result.latencyMs, referencedCustomerIds: [input.customerId], highImpactAction: false };
    },
  };
}

async function openThread(db: D1Database, customerId: string) {
  const existing = await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? AND status='open' ORDER BY updated_at DESC LIMIT 1").bind(customerId).first<Row>();
  if (existing) return text(existing.id);
  const id = uid("THREAD"), now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,NULL,NULL,'open','ai-orchestrator',NULL,?,?)").bind(id, customerId, now, now),
    db.prepare("INSERT OR IGNORE INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'customer',?)").bind(crypto.randomUUID(), id, "customer", customerId, customerId, now),
  ]);
  return id;
}

async function establishSession(env: Env, start: AgentStart): Promise<Session> {
  await ensureAiVoiceUatTables(env.DB);
  const providerCallId = text(start.call_sid), accountSid = text(start.account_sid), streamSid = text(start.stream_sid);
  if (!providerCallId || !streamSid) throw new Error("AgentStream start is missing call_sid or stream_sid");
  if (!accountSid || accountSid !== text(env.EXOTEL_SID)) throw new Error("AgentStream account_sid does not match the configured Exotel account");
  const order = await env.DB.prepare("SELECT id,customer_id,state,provider,provider_call_id,consent_decision,opt_out_decision,mode FROM voice_call_orders WHERE provider='exotel' AND provider_call_id=? ORDER BY requested_at DESC LIMIT 1").bind(providerCallId).first<Row>();
  if (!order) throw new Error("AgentStream call is not present in the governed outbound ledger");
  if (!text(order.customer_id)) throw new Error("AgentStream voice AI requires a canonical customer");
  if (text(order.consent_decision) !== "granted" || text(order.opt_out_decision) !== "clear") throw new Error("AgentStream call has no current voice consent or is opted out");
  if (["blocked_disabled", "blocked_permission", "blocked_use_case", "blocked_not_allowlisted", "blocked_consent", "blocked_opt_out", "blocked_quiet_hours", "blocked_frequency_cap", "provider_unavailable", "ended", "cancelled"].includes(text(order.state))) throw new Error("AgentStream call is not in an active carrier state");
  if (text(env.PAWSPACE_VOICE_ENV) === "uat" && text(order.mode) !== "uat") throw new Error("AgentStream UAT cannot bind a non-UAT call");

  const customerId = text(order.customer_id), threadId = await openThread(env.DB, customerId), aiCallId = uid("AIVCALL"), now = Date.now();
  const sampleRate = Number(start.media_format?.sample_rate || 8000);
  if (![8000, 16000, 24000].includes(sampleRate)) throw new Error("AgentStream sample rate is unsupported");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO ai_voice_calls (id,thread_id,customer_id,transport_provider,direction,status,consent_status,language,started_at,created_by) VALUES (?,?,?,'exotel','outbound','active','verified','en',?,?)").bind(aiCallId, threadId, customerId, now, serviceActor.email),
    env.DB.prepare("UPDATE voice_call_orders SET ai_call_id=?,transcript_ref=?,updated_at=? WHERE id=? AND provider_call_id=?").bind(aiCallId, aiCallId, now, text(order.id), providerCallId),
    env.DB.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), aiCallId, "agentstream_started", JSON.stringify({ provider: "exotel", streamSid, sampleRate, encoding: "linear16" }), now),
  ]);
  return { streamSid, providerCallId, ledgerCallId: text(order.id), aiCallId, threadId, customerId, sampleRate, language: "en", segmentIndex: 0 };
}

async function recordSegment(env: Env, session: Session, speaker: "customer" | "assistant", transcript: string, confidence: number | null, provider: AiResponseProvider | null) {
  const messageId = `MSG-VOICE-${crypto.randomUUID().slice(0, 12).toUpperCase()}`, now = Date.now(), index = session.segmentIndex++;
  const direction = speaker === "customer" ? "inbound" : "outbound";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,?,'voice','transactional','voice_transcript_segment',?,'received',?,NULL,?,?,?, ?,?)")
      .bind(messageId, session.threadId, session.customerId, direction, JSON.stringify({ text: transcript, segmentIndex: index }), speaker === "customer" ? "workers_ai" : "exotel_agentstream", `voice:${session.aiCallId}:${index}:${speaker}`, JSON.stringify({ consentVerified: true, carrierStream: true }), serviceActor.email, now, now),
    env.DB.prepare("INSERT INTO ai_voice_segments (id,call_id,message_id,segment_index,speaker,transcript_text,stt_provider,stt_confidence,interrupted,created_at) VALUES (?,?,?,?,?,?,?,?,0,?)")
      .bind(crypto.randomUUID(), session.aiCallId, messageId, index, speaker, transcript, speaker === "customer" ? EXOTEL_AGENTSTREAM_STT_MODEL : null, confidence, now),
  ]);
  if (speaker !== "customer" || !provider) return { output: transcript, outcome: "recorded" };
  const turn = await orchestrateAiTurn(env.DB, { actor: serviceActor, threadId: session.threadId, customerId: session.customerId, inputMessageId: messageId, idempotencyKey: `exotel-agentstream:${session.providerCallId}:${index}`, channel: "voice", provider });
  const row = (turn.turn || null) as Row | null;
  return { output: text(row?.output || row?.output_text), outcome: text(row?.outcome) || (row ? "draft_review_required" : "pending") };
}

async function transcribe(env: Env, pcm: Uint8Array, sampleRate: number, language: string) {
  const started = Date.now();
  const result = await ai(env).run(text(env.VOICE_STT_MODEL) || EXOTEL_AGENTSTREAM_STT_MODEL, { audio: Array.from(wavFromPcm16le(pcm, sampleRate)), language, vad_filter: true });
  if (!result || typeof result !== "object") throw new Error("Whisper returned no result object");
  const record = result as Record<string, unknown>;
  const transcript = text(record.text ?? record.transcription);
  const raw = Number(record.confidence);
  return { text: transcript, confidence: Number.isFinite(raw) ? raw : (transcript ? 0.9 : 0), latencyMs: Date.now() - started };
}

async function synthesizeLinear16(env: Env, output: string, sampleRate: number) {
  const started = Date.now();
  // MeloTTS remains the in-app/default TTS. Its documented output is MP3, which cannot be placed on
  // AgentStream as raw linear16. The carrier bridge therefore uses a Workers-AI TTS model that exposes
  // linear16 directly, avoiding a lossy/slow MP3 decode+resample step inside the live socket.
  const model = text(env.VOICE_CARRIER_TTS_MODEL) || EXOTEL_AGENTSTREAM_TTS_MODEL;
  const result = await ai(env).run(model, { text: output, encoding: "linear16", container: "none", sample_rate: sampleRate, speaker: text(env.VOICE_CARRIER_TTS_SPEAKER) || "luna" }, { returnRawResponse: true });
  let audio = await responseBytes(result);
  if (audio.byteLength % 2) audio = audio.subarray(0, audio.byteLength - 1);
  return { audio, latencyMs: Date.now() - started };
}

function sendAudio(socket: WebSocket, session: Session, audio: Uint8Array, markName: string) {
  // Exotel documents chunks as multiples of 320 bytes. Pad only the terminal chunk with digital silence.
  for (let offset = 0; offset < audio.byteLength; offset += OUTBOUND_CHUNK_BYTES) {
    const raw = audio.subarray(offset, Math.min(audio.byteLength, offset + OUTBOUND_CHUNK_BYTES));
    const paddedLength = Math.ceil(raw.byteLength / 320) * 320;
    const chunk = paddedLength === raw.byteLength ? raw : (() => { const value = new Uint8Array(paddedLength); value.set(raw); return value; })();
    socket.send(JSON.stringify({ event: "media", stream_sid: session.streamSid, media: { payload: bytesToBase64(chunk) } }));
  }
  socket.send(JSON.stringify({ event: "mark", stream_sid: session.streamSid, mark: { name: markName } }));
}

async function closeSession(env: Env, session: Session | null, reason: string) {
  if (!session) return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE ai_voice_calls SET status=CASE WHEN status='active' THEN 'completed' ELSE status END,outcome=COALESCE(outcome,'carrier_ended'),disposition=COALESCE(disposition,?),ended_at=COALESCE(ended_at,?) WHERE id=?").bind(reason, now, session.aiCallId),
    env.DB.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), session.aiCallId, "agentstream_stopped", JSON.stringify({ reason }), now),
  ]).catch(() => undefined);
}

export async function handleExotelAgentStream(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  if (new URL(request.url).pathname !== EXOTEL_AGENTSTREAM_PATH) return new Response("Not found", { status: 404 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
  if (text(env.PAWSPACE_VOICE_ENV) !== "uat" && text(env.PAWSPACE_VOICE_ENV) !== "live") return new Response("Voice carrier streaming is disabled", { status: 403 });
  if (!env.AI) return new Response("Workers AI binding is unavailable", { status: 503 });

  const Pair = (globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: WebSocket } }).WebSocketPair;
  const pair = new Pair(), client = pair[0], server = pair[1];
  (server as WebSocket & { accept(): void }).accept();

  let session: Session | null = null;
  let providerPromise: Promise<AiResponseProvider> | null = null;
  let speechParts: Uint8Array[] = [], preRoll: Uint8Array[] = [], speechStartedAt = 0, silenceMs = 0, assistantPlaying = false;
  let chain = Promise.resolve();

  const processUtterance = async (pcm: Uint8Array, active: Session) => {
    const turnStarted = Date.now();
    const stt = await transcribe(env, pcm, active.sampleRate, active.language);
    if (!stt.text) return;
    const llmStarted = Date.now();
    providerPromise ||= runtimeProvider();
    const generated = await recordSegment(env, active, "customer", stt.text, stt.confidence, await providerPromise);
    const llmMs = Date.now() - llmStarted;
    if (!generated.output) return;
    const tts = await synthesizeLinear16(env, generated.output, active.sampleRate);
    const assistantSegment = recordSegment(env, active, "assistant", generated.output, null, null);
    const totalMs = Date.now() - turnStarted;
    const markName = `turn-${active.segmentIndex}-end`;
    assistantPlaying = true;
    sendAudio(server, active, tts.audio, markName);
    await assistantSegment;
    await env.DB.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)").bind(
      crypto.randomUUID(), active.aiCallId, "agentstream_turn", JSON.stringify({ sttMs: stt.latencyMs, llmMs, ttsMs: tts.latencyMs, totalMs, latencyTargetMs: VOICE_TURN_LATENCY_TARGET_MS, targetMet: totalMs <= VOICE_TURN_LATENCY_TARGET_MS, outcome: generated.outcome }), Date.now(),
    ).run();
  };

  server.addEventListener("message", (event: MessageEvent) => {
    chain = chain.then(async () => {
      let incoming: AgentEvent;
      try { incoming = JSON.parse(String(event.data)) as AgentEvent; } catch { server.close(1003, "Malformed AgentStream JSON"); return; }
      const kind = text(incoming.event);
      if (kind === "connected") return;
      if (kind === "start") {
        if (session) { server.close(1002, "Duplicate AgentStream start"); return; }
        session = await establishSession(env, incoming.start || {});
        return;
      }
      if (kind === "mark") { assistantPlaying = false; return; }
      if (kind === "stop") { const active = session; await closeSession(env, active, text(incoming.stop?.reason) || "callended"); session = null; server.close(1000, "Call ended"); return; }
      if (kind !== "media" || !session) return;
      const payload = text(incoming.media?.payload);
      if (!payload) return;
      let pcm: Uint8Array;
      try { pcm = base64ToBytes(payload); } catch { server.close(1007, "Invalid base64 media"); return; }
      if (!pcm.byteLength || pcm.byteLength % 2) { server.close(1007, "Invalid PCM media"); return; }
      const frameMs = Math.max(1, Math.round((pcm.byteLength / 2 / session.sampleRate) * 1000));
      const speech = pcmRms(pcm) >= SPEECH_RMS_THRESHOLD;
      preRoll.push(pcm);
      while (preRoll.reduce((sum, item) => sum + item.byteLength, 0) > session.sampleRate * 2 * (PRE_ROLL_MS / 1000)) preRoll.shift();
      if (speech) {
        if (!speechStartedAt) {
          speechStartedAt = Date.now();
          speechParts = [...preRoll];
          if (assistantPlaying) { server.send(JSON.stringify({ event: "clear", stream_sid: session.streamSid })); assistantPlaying = false; }
        } else speechParts.push(pcm);
        silenceMs = 0;
      } else if (speechStartedAt) {
        speechParts.push(pcm); silenceMs += frameMs;
      }
      const elapsed = speechStartedAt ? Date.now() - speechStartedAt : 0;
      if (speechStartedAt && (silenceMs >= END_SILENCE_MS || elapsed >= MAX_UTTERANCE_MS)) {
        const utterance = concat(speechParts), active = session;
        speechParts = []; preRoll = []; speechStartedAt = 0; silenceMs = 0;
        await processUtterance(utterance, active);
      }
    }).catch(async error => {
      const active = session;
      await closeSession(env, active, "agentstream_error");
      try { server.close(1011, text((error as Error)?.message).slice(0, 100) || "AgentStream processing failed"); } catch {}
    });
  });
  server.addEventListener("close", () => { ctx.waitUntil(closeSession(env, session, "socket_closed")); session = null; });
  server.addEventListener("error", () => { ctx.waitUntil(closeSession(env, session, "socket_error")); });

  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
}
