import { canonicalDialNumber, voiceAllowlist } from "./voice-call-gate";
import { requestQuietHoursOverride } from "./quiet-hours-override";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
type AiBinding = {
  run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
};
type WorkerSocket = WebSocket & { accept(options?: { allowHalfOpen?: boolean }): void };

type SelfTestActor = { email: string; roleCode: string; permissions: string[] };
type ChatMessage = { role: "user" | "assistant"; content: string };

const text = (value: unknown) => String(value ?? "").trim();
const truthy = (value: unknown) => text(value).toLowerCase() === "true";
const SELF_TEST_PATH = "/voice/ai-self-test";
const MAX_CALL_SECONDS = 300;
const MAX_TURNS = 12;
const DAILY_CAP_DEFAULT = 3;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export type AiVoiceSelfTestReadiness = {
  enabled: boolean;
  mode: string;
  approved: boolean;
  allowlistSize: number;
  singleRecipient: boolean;
  telephonyConfigured: boolean;
  aiBindingConfigured: boolean;
  reason: string | null;
  quietHoursBypass: "audited_single_contact_override";
  recording: false;
  maxCallSeconds: number;
};

function aiBinding(env: Env): AiBinding | null {
  const ai = env.AI as AiBinding | undefined;
  return ai && typeof ai.run === "function" ? ai : null;
}

function requiredTelephonyMissing(env: Env) {
  const required = ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_CALLER_ID", "EXOTEL_WEBHOOK_SECRET"];
  return required.filter(name => !text(env[name]));
}

export function aiVoiceSelfTestReadiness(env: Env): AiVoiceSelfTestReadiness {
  const mode = text(env.PAWSPACE_VOICE_ENV).toLowerCase() || "disabled";
  const approved = truthy(env.PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED);
  const allowlistSize = voiceAllowlist(env).length;
  const missing = requiredTelephonyMissing(env);
  const aiReady = Boolean(aiBinding(env));
  let reason: string | null = null;
  if (mode !== "uat") reason = "AI voice self-test is available only in PAWSPACE_VOICE_ENV=uat";
  else if (!approved) reason = "PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED is not true";
  else if (allowlistSize !== 1) reason = "AI voice self-test requires exactly one PAWSPACE_VOICE_UAT_ALLOWLIST recipient";
  else if (missing.length) reason = `Missing Exotel configuration: ${missing.join(", ")}`;
  else if (!aiReady) reason = "Cloudflare Workers AI binding (AI) is not configured";
  return {
    enabled: !reason,
    mode,
    approved,
    allowlistSize,
    singleRecipient: allowlistSize === 1,
    telephonyConfigured: missing.length === 0,
    aiBindingConfigured: aiReady,
    reason,
    quietHoursBypass: "audited_single_contact_override",
    recording: false,
    maxCallSeconds: MAX_CALL_SECONDS,
  };
}

export async function ensureAiVoiceSelfTestTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS ai_voice_self_tests (id TEXT PRIMARY KEY,phone_key TEXT NOT NULL,phone_last4 TEXT NOT NULL,state TEXT NOT NULL,provider_call_id TEXT,stream_sid TEXT,requested_by TEXT NOT NULL,quiet_hours_bypassed INTEGER NOT NULL DEFAULT 0,turn_count INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at INTEGER NOT NULL,connected_at INTEGER,ended_at INTEGER,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ai_voice_self_tests_created ON ai_voice_self_tests(created_at)"),
  ]);
}

function base64(bytes: Uint8Array) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes)).map(value => value.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function signedStreamUrl(env: Env, callId: string, publicOrigin: string) {
  let origin: URL;
  try { origin = new URL(publicOrigin); } catch { throw new Error("The self-test request origin is not a valid URL"); }
  if (origin.protocol !== "https:") throw new Error("AI voice self-test requires an https staging origin");
  const exp = Date.now() + 10 * 60_000;
  const sig = await hmac(text(env.EXOTEL_WEBHOOK_SECRET), `ai-self-test:${callId}:${exp}`);
  const url = new URL(SELF_TEST_PATH, origin);
  url.protocol = "wss:";
  url.searchParams.set("call", callId);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  url.searchParams.set("sample-rate", "16000");
  return url.toString();
}

async function verifyStreamRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const callId = text(url.searchParams.get("call"));
  const exp = Number(url.searchParams.get("exp"));
  const sig = text(url.searchParams.get("sig")).toLowerCase();
  if (!callId || !Number.isFinite(exp) || !sig) return { ok: false as const, reason: "Missing signed AgentStream token" };
  if (Date.now() > exp || exp - Date.now() > 10 * 60_000) return { ok: false as const, reason: "AgentStream token expired or exceeds its lifetime" };
  const expected = await hmac(text(env.EXOTEL_WEBHOOK_SECRET), `ai-self-test:${callId}:${exp}`);
  if (!safeEqual(expected, sig)) return { ok: false as const, reason: "AgentStream signature mismatch" };
  return { ok: true as const, callId };
}

function dailyCap(env: Env) {
  const configured = Number(text(env.PAWSPACE_VOICE_UAT_AI_SELF_TEST_DAILY_CAP));
  if (!Number.isFinite(configured)) return DAILY_CAP_DEFAULT;
  return Math.min(10, Math.max(1, Math.floor(configured)));
}

function todayIstStart(now = Date.now()) {
  const shifted = new Date(now + IST_OFFSET_MS);
  const startUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return startUtc - IST_OFFSET_MS;
}

async function createExotelAgentStreamCall(env: Env, input: { to: string; callId: string; streamUrl: string }) {
  const key = text(env.EXOTEL_API_KEY);
  const token = text(env.EXOTEL_API_TOKEN);
  const sid = text(env.EXOTEL_SID);
  const callerId = text(env.EXOTEL_CALLER_ID);
  const subdomain = text(env.EXOTEL_SUBDOMAIN) || "api.in.exotel.com";
  const body = new FormData();
  body.set("from", input.to);
  body.set("callerid", callerId);
  body.set("streamurl", input.streamUrl);
  body.set("streamtype", "bidirectional");
  body.set("record", "false");
  body.set("timelimit", String(MAX_CALL_SECONDS));
  body.set("customfield", input.callId.slice(0, 128));
  body.set("streamname", "pawspace-ai-uat");
  const response = await fetch(`https://${subdomain}/v1/accounts/${encodeURIComponent(sid)}/calls/connect`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${key}:${token}`)}` },
    body,
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch {}
  if (!response.ok) return { ok: false as const, status: response.status, reason: `Exotel rejected the self-test dial (HTTP ${response.status})` };
  const call = (parsed.call && typeof parsed.call === "object" ? parsed.call : parsed) as Record<string, unknown>;
  const providerCallId = text(call.sid || call.call_sid || parsed.call_sid);
  if (!providerCallId) return { ok: false as const, status: 502, reason: "Exotel accepted the request but returned no call identifier" };
  return { ok: true as const, providerCallId, providerStatus: text(call.status) || "accepted" };
}

export async function requestAiVoiceSelfTest(db: Db, env: Env, actor: SelfTestActor, publicOrigin: string) {
  await ensureAiVoiceSelfTestTables(db);
  const readiness = aiVoiceSelfTestReadiness(env);
  if (!readiness.enabled) return { ok: false as const, status: 409, reason: readiness.reason || "AI voice self-test is not ready", readiness };
  if (!actor.permissions.includes("*") && !actor.permissions.includes("settings.manage")) return { ok: false as const, status: 403, reason: "settings.manage is required for the AI voice self-test", readiness };
  if (!actor.permissions.includes("*") && !actor.permissions.includes("communications.call")) return { ok: false as const, status: 403, reason: "communications.call is required for the AI voice self-test", readiness };

  const now = Date.now();
  const recent = await db.prepare("SELECT COUNT(*) n FROM ai_voice_self_tests WHERE created_at>=?").bind(todayIstStart(now)).first<Row>();
  if (Number(recent?.n || 0) >= dailyCap(env)) return { ok: false as const, status: 429, reason: "AI voice self-test daily cap reached", readiness };
  const active = await db.prepare("SELECT id FROM ai_voice_self_tests WHERE state IN ('dialing','streaming') AND created_at>? ORDER BY created_at DESC LIMIT 1").bind(now - 10 * 60_000).first<Row>();
  if (active) return { ok: false as const, status: 409, reason: `An AI voice self-test is already active (${text(active.id)})`, readiness };

  const phoneKey = voiceAllowlist(env)[0];
  const dialNumber = canonicalDialNumber(phoneKey, env);
  if (!dialNumber) return { ok: false as const, status: 409, reason: "The single UAT allow-list entry cannot be canonicalized for dialing", readiness };
  const callId = `AIVST-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

  const override = await requestQuietHoursOverride(db, {
    actor: { email: actor.email, roleCode: actor.roleCode, permissions: actor.permissions },
    reasonCode: "customer_requested_callback",
    caseReference: `VOICE-UAT-${callId}`,
    reason: "Authenticated staff requested an allow-listed AI voice self-test; one recipient, no recording, UAT only.",
    contactCount: 1,
    channel: "voice",
    asOf: now,
  });
  if (!override.allowed) return { ok: false as const, status: 409, reason: `Quiet-hours override refused: ${override.reason}`, readiness };

  await db.prepare("INSERT INTO ai_voice_self_tests (id,phone_key,phone_last4,state,requested_by,quiet_hours_bypassed,created_at,updated_at) VALUES (?,?,?,'dialing',?,?,?,?)")
    .bind(callId, phoneKey, phoneKey.slice(-4), actor.email, override.overrideUsed ? 1 : 0, now, now).run();

  let streamUrl: string;
  try { streamUrl = await signedStreamUrl(env, callId, publicOrigin); }
  catch (error) {
    const reason = error instanceof Error ? error.message : "Unable to create signed AgentStream URL";
    await db.prepare("UPDATE ai_voice_self_tests SET state='failed',last_error=?,ended_at=?,updated_at=? WHERE id=?").bind(reason, now, now, callId).run();
    return { ok: false as const, status: 409, reason, readiness };
  }
  const dial = await createExotelAgentStreamCall(env, { to: dialNumber, callId, streamUrl });
  if (!dial.ok) {
    await db.prepare("UPDATE ai_voice_self_tests SET state='failed',last_error=?,ended_at=?,updated_at=? WHERE id=?").bind(dial.reason, Date.now(), Date.now(), callId).run();
    return { ok: false as const, status: dial.status, reason: dial.reason, callId, phoneLast4: phoneKey.slice(-4), quietHoursBypassed: override.overrideUsed, readiness };
  }
  await db.prepare("UPDATE ai_voice_self_tests SET provider_call_id=?,updated_at=? WHERE id=?").bind(dial.providerCallId, Date.now(), callId).run();
  return { ok: true as const, status: 201, callId, providerCallId: dial.providerCallId, providerStatus: dial.providerStatus, phoneLast4: phoneKey.slice(-4), quietHoursBypassed: override.overrideUsed, recording: false, maxCallSeconds: MAX_CALL_SECONDS };
}

async function ttsPcm(ai: AiBinding, message: string) {
  const result = await ai.run("@cf/deepgram/aura-1", {
    text: message,
    speaker: "asteria",
    encoding: "linear16",
    container: "none",
    sample_rate: 16000,
  }, { returnRawResponse: true });
  if (result instanceof Response) return new Uint8Array(await result.arrayBuffer());
  if (result && typeof (result as { getReader?: unknown }).getReader === "function") return new Uint8Array(await new Response(result as ReadableStream<Uint8Array>).arrayBuffer());
  throw new Error("Workers AI TTS returned no raw audio response");
}

function llmText(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const row = result as Record<string, unknown>;
  if (typeof row.response === "string") return row.response.trim();
  if (typeof row.result === "string") return row.result.trim();
  return "";
}

async function answer(ai: AiBinding, history: ChatMessage[], question: string) {
  const messages = [
    {
      role: "system",
      content: "You are PawSpace's internal UAT voice assistant. This call is an allow-listed staff self-test. Answer the caller's questions naturally and concisely, usually in one or two spoken sentences. You may explain PawSpace services and general information, but you must not execute bookings, payments, refunds, price changes, discounts, account changes, or other high-impact actions. Do not invent customer-specific data. If a question needs private account context or a human decision, say so plainly. Never claim an action was completed. Avoid markdown because the response will be spoken aloud.",
    },
    ...history.slice(-8),
    { role: "user", content: question },
  ];
  const result = await ai.run("@cf/openai/gpt-oss-20b", { messages, max_tokens: 220, temperature: 0.4 });
  return llmText(result).slice(0, 800);
}

function sendExotelPcm(socket: WorkerSocket, streamSid: string, audio: Uint8Array) {
  const chunkSize = 3200;
  for (let offset = 0; offset < audio.length; offset += chunkSize) {
    const part = audio.subarray(offset, Math.min(offset + chunkSize, audio.length));
    const chunk = part.length === chunkSize ? part : (() => { const padded = new Uint8Array(chunkSize); padded.set(part); return padded; })();
    socket.send(JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: base64(chunk) } }));
  }
}

export async function handleAiVoiceSelfTestStream(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).pathname !== SELF_TEST_PATH) return new Response("Not found", { status: 404 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });
  const token = await verifyStreamRequest(request, env);
  if (!token.ok) return new Response("Unauthorized AgentStream request", { status: 401 });
  const readiness = aiVoiceSelfTestReadiness(env);
  if (!readiness.enabled) return new Response("AI voice self-test is disabled", { status: 503 });
  const db = env.DB as Db | undefined;
  const ai = aiBinding(env);
  if (!db || !ai) return new Response("AI voice self-test runtime is incomplete", { status: 503 });
  await ensureAiVoiceSelfTestTables(db);
  const call = await db.prepare("SELECT id,state FROM ai_voice_self_tests WHERE id=?").bind(token.callId).first<Row>();
  if (!call || !["dialing", "streaming"].includes(text(call.state))) return new Response("Unknown or closed AI voice self-test", { status: 404 });

  const fluxResponse = await ai.run("@cf/deepgram/flux", {
    encoding: "linear16",
    sample_rate: "16000",
    eot_threshold: "0.65",
    eot_timeout_ms: "1200",
    mip_opt_out: "true",
    tag: "pawspace-uat-ai-self-test",
  }, { websocket: true }) as Response & { webSocket?: WorkerSocket };
  const flux = fluxResponse.webSocket;
  if (!flux) return new Response("Workers AI speech recognizer did not open a WebSocket", { status: 503 });
  flux.accept({ allowHalfOpen: true });

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WorkerSocket, WorkerSocket];
  server.accept({ allowHalfOpen: true });
  let streamSid = "";
  let speaking = false;
  let turnCount = 0;
  const history: ChatMessage[] = [];
  let queue = Promise.resolve();

  const setState = async (state: string, extra: { streamSid?: string; error?: string; ended?: boolean } = {}) => {
    const now = Date.now();
    await db.prepare("UPDATE ai_voice_self_tests SET state=?,stream_sid=COALESCE(?,stream_sid),turn_count=?,last_error=COALESCE(?,last_error),connected_at=CASE WHEN ?='streaming' AND connected_at IS NULL THEN ? ELSE connected_at END,ended_at=CASE WHEN ? THEN ? ELSE ended_at END,updated_at=? WHERE id=?")
      .bind(state, extra.streamSid || null, turnCount, extra.error || null, state, now, extra.ended ? 1 : 0, now, now, token.callId).run().catch(() => undefined);
  };

  const speak = async (message: string, mark: string) => {
    if (!streamSid || !message.trim()) return;
    speaking = true;
    try {
      const pcm = await ttsPcm(ai, message.trim());
      sendExotelPcm(server, streamSid, pcm);
      server.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: mark } }));
    } catch (error) {
      speaking = false;
      await setState("failed", { error: error instanceof Error ? error.message : "TTS failure", ended: true });
      server.close(1011, "speech failure");
    }
  };

  const onQuestion = (question: string) => {
    const clean = question.trim();
    if (!clean || turnCount >= MAX_TURNS) return;
    queue = queue.then(async () => {
      turnCount += 1;
      const normalized = clean.toLowerCase();
      if (/\b(do not call|stop calling|unsubscribe)\b/.test(normalized)) {
        await speak("Understood. This self-test will end now. No further test call will be made from this session.", `turn-${turnCount}-end`);
        await setState("ended", { ended: true });
        return;
      }
      if (/\b(agent|human|person|team member)\b/.test(normalized)) {
        await speak("This is a self-test line, so I will stop here. Please contact the PawSpace team directly for a human conversation.", `turn-${turnCount}-end`);
        return;
      }
      let reply = "";
      try { reply = await answer(ai, history, clean); }
      catch { reply = "I could not reach the AI answer service for that question. Please try again in a moment."; }
      if (!reply) reply = "I do not have a reliable answer for that. Please ask another question.";
      history.push({ role: "user", content: clean }, { role: "assistant", content: reply });
      await speak(reply, `turn-${turnCount}-end`);
      await setState("streaming");
    }).catch(async error => {
      await setState("failed", { error: error instanceof Error ? error.message : "AI voice turn failed", ended: true });
    });
  };

  flux.addEventListener("message", event => {
    if (typeof event.data !== "string") return;
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
    const kind = text(payload.event);
    if (kind === "StartOfTurn" && speaking && streamSid) {
      server.send(JSON.stringify({ event: "clear", stream_sid: streamSid }));
      speaking = false;
    }
    if (kind === "EndOfTurn") onQuestion(text(payload.transcript));
  });
  flux.addEventListener("error", () => { void setState("failed", { error: "Workers AI speech recognizer failed", ended: true }); });

  server.addEventListener("message", event => {
    if (typeof event.data !== "string") return;
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
    const kind = text(payload.event);
    if (kind === "start") {
      const start = (payload.start && typeof payload.start === "object" ? payload.start : {}) as Record<string, unknown>;
      streamSid = text(payload.stream_sid || start.stream_sid);
      void setState("streaming", { streamSid });
      void speak("Hi, this is PawSpace's AI self-test assistant. This is an automated UAT call you requested. Ask me any question. This test does not make bookings, payments, refunds, or account changes.", "opening-end");
      return;
    }
    if (kind === "media") {
      const media = (payload.media && typeof payload.media === "object" ? payload.media : {}) as Record<string, unknown>;
      const encoded = text(media.payload);
      if (encoded && flux.readyState === WebSocket.OPEN) flux.send(fromBase64(encoded));
      return;
    }
    if (kind === "mark") speaking = false;
    if (kind === "stop") {
      void setState("ended", { ended: true });
      try { flux.close(1000, "call ended"); } catch {}
    }
  });
  server.addEventListener("close", () => {
    void setState("ended", { ended: true });
    try { flux.close(1000, "provider socket closed"); } catch {}
  });
  server.addEventListener("error", () => { void setState("failed", { error: "Exotel AgentStream socket failed", ended: true }); });

  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
}
