import { canonicalDialNumber, voiceAllowlist } from "./voice-call-gate";
import { requestQuietHoursOverride } from "./quiet-hours-override";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
type AiBinding = {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
};
type WorkerSocket = WebSocket & {
  accept(options?: { allowHalfOpen?: boolean }): void;
};
type WorkerWebSocketPair = { 0: WorkerSocket; 1: WorkerSocket };
type WorkerWebSocketPairCtor = new () => WorkerWebSocketPair;
type SelfTestActor = {
  email: string;
  roleCode: string;
  permissions: string[];
};
type ChatMessage = { role: "user" | "assistant"; content: string };

const text = (value: unknown) => String(value ?? "").trim();
const truthy = (value: unknown) => text(value).toLowerCase() === "true";
const SELF_TEST_PATH = "/voice/ai-self-test";
const SELF_TEST_NEGOTIATE_PATH = "/voice/ai-self-test/negotiate";
/** Exotel AgentStream PSTN leg: raw/slin, 16-bit, mono, little-endian, 8 kHz. */
const EXOTEL_PSTN_SAMPLE_RATE = 8000;
const MAX_CALL_SECONDS = 300;
const MAX_TURNS = 12;
const STREAM_TOKEN_TTL_MS = 2 * 60_000;
const DAILY_CAP_DEFAULT = 3;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function createWebSocketPair() {
  const Ctor = (globalThis as unknown as { WebSocketPair?: WorkerWebSocketPairCtor })
    .WebSocketPair;
  if (!Ctor) {
    throw new Error("Cloudflare WebSocketPair is unavailable in this runtime");
  }
  return new Ctor();
}

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

function missingTelephony(env: Env) {
  return [
    "EXOTEL_API_KEY",
    "EXOTEL_API_TOKEN",
    "EXOTEL_SID",
    "EXOTEL_CALLER_ID",
    "EXOTEL_VOICE_APP_ID",
    "EXOTEL_WEBHOOK_SECRET",
  ].filter((name) => !text(env[name]));
}

export function aiVoiceSelfTestReadiness(env: Env): AiVoiceSelfTestReadiness {
  const mode = text(env.PAWSPACE_VOICE_ENV).toLowerCase() || "disabled";
  const approved = truthy(env.PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED);
  const allowlistSize = voiceAllowlist(env).length;
  const missing = missingTelephony(env);
  const aiReady = Boolean(aiBinding(env));
  let reason: string | null = null;

  if (mode !== "uat") {
    reason = "AI voice self-test is available only in PAWSPACE_VOICE_ENV=uat";
  } else if (!approved) {
    reason = "PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED is not true";
  } else if (allowlistSize !== 1) {
    reason =
      "AI voice self-test requires exactly one PAWSPACE_VOICE_UAT_ALLOWLIST recipient";
  } else if (missing.length) {
    reason = `Missing Exotel configuration: ${missing.join(", ")}`;
  } else if (!aiReady) {
    reason = "Cloudflare Workers AI binding (AI) is not configured";
  }

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
    db.prepare(
      "CREATE TABLE IF NOT EXISTS ai_voice_self_tests (id TEXT PRIMARY KEY,phone_key TEXT NOT NULL,phone_last4 TEXT NOT NULL,state TEXT NOT NULL,provider_call_id TEXT,stream_sid TEXT,requested_by TEXT NOT NULL,quiet_hours_bypassed INTEGER NOT NULL DEFAULT 0,turn_count INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at INTEGER NOT NULL,connected_at INTEGER,ended_at INTEGER,updated_at INTEGER NOT NULL)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_ai_voice_self_tests_created ON ai_voice_self_tests(created_at)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS ai_voice_self_test_active_guard (slot INTEGER PRIMARY KEY CHECK(slot=1),call_id TEXT NOT NULL UNIQUE,claimed_at INTEGER NOT NULL)",
    ),
  ]);
}

async function releaseActiveGuard(db: Db, callId: string) {
  await db
    .prepare("DELETE FROM ai_voice_self_test_active_guard WHERE slot=1 AND call_id=?")
    .bind(callId)
    .run();
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string) {
  const raw = atob(value);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}

async function signedStreamUrl(env: Env, callId: string, publicOrigin: string) {
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new Error("The self-test request origin is not a valid URL");
  }
  if (origin.protocol !== "https:") {
    throw new Error("AI voice self-test requires an https staging origin");
  }

  const exp = Date.now() + STREAM_TOKEN_TTL_MS;
  const sig = await hmac(
    text(env.EXOTEL_WEBHOOK_SECRET),
    `ai-self-test:${callId}:${exp}`,
  );
  const url = new URL(SELF_TEST_PATH, origin);
  url.protocol = "wss:";
  url.searchParams.set("call", callId);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  // Exotel AgentStream carries raw/slin 16-bit MONO PCM at 8 kHz on the PSTN leg. Advertising 16000
  // here made the Worker generate TTS at twice the negotiated rate, which plays back chipmunked or as
  // noise even when every frame is delivered. The `start` event remains authoritative.
  url.searchParams.set("sample-rate", String(EXOTEL_PSTN_SAMPLE_RATE));
  return url.toString();
}

async function verifyStreamRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const callId = text(url.searchParams.get("call"));
  const exp = Number(url.searchParams.get("exp"));
  const sig = text(url.searchParams.get("sig")).toLowerCase();
  if (!callId || !Number.isFinite(exp) || !sig) return { ok: false as const };
  if (Date.now() > exp || exp - Date.now() > STREAM_TOKEN_TTL_MS) {
    return { ok: false as const };
  }
  const expected = await hmac(
    text(env.EXOTEL_WEBHOOK_SECRET),
    `ai-self-test:${callId}:${exp}`,
  );
  return safeEqual(expected, sig)
    ? { ok: true as const, callId }
    : { ok: false as const };
}

function dailyCap(env: Env) {
  const value = Number(text(env.PAWSPACE_VOICE_UAT_AI_SELF_TEST_DAILY_CAP));
  return Number.isFinite(value)
    ? Math.min(10, Math.max(1, Math.floor(value)))
    : DAILY_CAP_DEFAULT;
}

function todayIstStart(now = Date.now()) {
  const shifted = new Date(now + IST_OFFSET_MS);
  return (
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) - IST_OFFSET_MS
  );
}

function exotelErrorDetail(parsed: Record<string, unknown>) {
  const responseData =
    parsed.ResponseData && typeof parsed.ResponseData === "object"
      ? (parsed.ResponseData as Record<string, unknown>)
      : {};
  const candidates = [
    responseData.Description,
    responseData.Message,
    parsed.description,
    parsed.message,
    parsed.reason,
    parsed.error,
  ]
    .map(text)
    .filter(Boolean);
  const detail = [...new Set(candidates)]
    .join(": ")
    .replace(/\+?\d[\d\s()-]{6,}\d/g, "[redacted-number]")
    .replace(/\s+/g, " ")
    .trim();
  return detail.slice(0, 180);
}

/**
 * Exotel's Connect API is the ONLY documented way to place this call, and bidirectional AgentStream
 * is NOT a parameter on it. Streaming is configured by a Voicebot applet inside an Exotel App, and the
 * call is pointed at that App through `Url`. lib/voice-telephony-provider.ts - the path that already
 * works in this repo - does exactly that.
 *
 * The previous version of this function posted lowercase `/v1/accounts/{sid}/calls/connect` with
 * multipart `streamurl`/`streamtype` fields and no App reference at all. Exotel accepted the request
 * and rang the number, because dialling `From` needs nothing else - but with no call flow attached
 * there was no Voicebot applet to run, so Exotel never opened the AgentStream socket. That is exactly
 * the reported symptom: the phone rings, the tester answers, and hears carrier tone with no AI.
 *
 * `EXOTEL_VOICE_APP_ID` must identify an Exotel App whose Voicebot applet points at
 * `${publicOrigin}/voice/ai-self-test/negotiate`; that endpoint hands back the per-call signed wss URL.
 * Without the App id there is nothing to dial into, so this fails closed rather than placing a call
 * that can only ever be silent.
 */
async function createExotelAgentStreamCall(
  env: Env,
  input: { to: string; callId: string; streamUrl: string },
) {
  const key = text(env.EXOTEL_API_KEY);
  const token = text(env.EXOTEL_API_TOKEN);
  const sid = text(env.EXOTEL_SID);
  const callerId = text(env.EXOTEL_CALLER_ID);
  const subdomain = text(env.EXOTEL_SUBDOMAIN) || "api.exotel.com";

  void input.streamUrl; // delivered to Exotel by the Voicebot applet negotiate endpoint, not the dial
  const appId = text(env.EXOTEL_VOICE_APP_ID);
  if (!appId) {
    return {
      ok: false as const,
      status: 503,
      reason:
        "EXOTEL_VOICE_APP_ID is not configured. Bidirectional AgentStream needs an Exotel App containing a Voicebot applet; a dial without one rings but can never stream audio.",
    };
  }

  // Documented Connect API: capitalised path, form-urlencoded, App referenced through Url.
  const body = new URLSearchParams({
    From: input.to,
    CallerId: callerId,
    Url: `http://my.exotel.com/${sid}/exoml/start_voice/${appId}`,
    CallType: "trans",
    CustomField: input.callId.slice(0, 128),
    Record: "false",
    TimeLimit: String(MAX_CALL_SECONDS),
  });

  const response = await fetch(
    `https://${subdomain}/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${key}:${token}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Exotel occasionally returns a non-JSON error body. HTTP status remains authoritative.
  }

  if (!response.ok) {
    const detail = exotelErrorDetail(parsed);
    return {
      ok: false as const,
      status: response.status,
      reason: `Exotel rejected the AgentStream dial (HTTP ${response.status})${
        detail ? `: ${detail}` : ""
      }`,
    };
  }

  const call =
    parsed.call && typeof parsed.call === "object"
      ? (parsed.call as Record<string, unknown>)
      : parsed;
  const providerCallId = text(call.sid || call.call_sid || parsed.call_sid);
  if (!providerCallId) {
    return {
      ok: false as const,
      status: 502,
      reason: "Exotel accepted the AgentStream request but returned no call identifier",
    };
  }
  return {
    ok: true as const,
    providerCallId,
    providerStatus: text(call.status) || "accepted",
  };
}

export async function requestAiVoiceSelfTest(
  db: Db,
  env: Env,
  actor: SelfTestActor,
  publicOrigin: string,
) {
  await ensureAiVoiceSelfTestTables(db);
  const readiness = aiVoiceSelfTestReadiness(env);
  if (!readiness.enabled) {
    return {
      ok: false as const,
      status: 409,
      reason: readiness.reason || "AI voice self-test is not ready",
      readiness,
    };
  }
  if (!actor.permissions.includes("*") && !actor.permissions.includes("settings.manage")) {
    return {
      ok: false as const,
      status: 403,
      reason: "settings.manage is required for the AI voice self-test",
      readiness,
    };
  }
  if (
    !actor.permissions.includes("*") &&
    !actor.permissions.includes("communications.call")
  ) {
    return {
      ok: false as const,
      status: 403,
      reason: "communications.call is required for the AI voice self-test",
      readiness,
    };
  }

  const now = Date.now();
  const callId = `AIVST-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

  // Serialize self-test admission in D1. The prior read-then-insert check let concurrent requests both
  // observe "no active call" and dial. The singleton guard makes the claim atomic across Worker isolates.
  await db
    .prepare("DELETE FROM ai_voice_self_test_active_guard WHERE claimed_at<=?")
    .bind(now - 10 * 60_000)
    .run();
  const guardClaim = await db
    .prepare(
      "INSERT INTO ai_voice_self_test_active_guard (slot,call_id,claimed_at) VALUES (1,?,?) ON CONFLICT(slot) DO NOTHING",
    )
    .bind(callId, now)
    .run();
  if (Number(guardClaim.meta?.changes || 0) !== 1) {
    return {
      ok: false as const,
      status: 409,
      reason: "An AI voice self-test is already active",
      readiness,
    };
  }

  const recent = await db
    .prepare(
      "SELECT COUNT(*) n FROM ai_voice_self_tests WHERE created_at>=? AND provider_call_id IS NOT NULL",
    )
    .bind(todayIstStart(now))
    .first<Row>();
  if (Number(recent?.n || 0) >= dailyCap(env)) {
    await releaseActiveGuard(db, callId);
    return {
      ok: false as const,
      status: 429,
      reason: "AI voice self-test daily cap reached",
      readiness,
    };
  }

  const active = await db
    .prepare(
      "SELECT id FROM ai_voice_self_tests WHERE state IN ('dialing','negotiated','stream_claimed','streaming') AND created_at>? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(now - 10 * 60_000)
    .first<Row>();
  if (active) {
    await releaseActiveGuard(db, callId);
    return {
      ok: false as const,
      status: 409,
      reason: `An AI voice self-test is already active (${text(active.id)})`,
      readiness,
    };
  }

  const phoneKey = voiceAllowlist(env)[0];
  const dialNumber = canonicalDialNumber(env, phoneKey);
  if (!dialNumber) {
    await releaseActiveGuard(db, callId);
    return {
      ok: false as const,
      status: 409,
      reason: "The single UAT allow-list entry cannot be canonicalized for dialing",
      readiness,
    };
  }

  const override = await requestQuietHoursOverride(db, {
    actor: {
      email: actor.email,
      roleCode: actor.roleCode,
      permissions: actor.permissions,
    },
    reasonCode: "customer_requested_callback",
    caseReference: `VOICE-UAT-${callId}`,
    reason:
      "Authenticated staff requested an allow-listed AI voice self-test; one recipient, no recording, UAT only.",
    contactCount: 1,
    channel: "voice",
    at: now,
  });
  if (!override.allowed) {
    await releaseActiveGuard(db, callId);
    return {
      ok: false as const,
      status: 409,
      reason: `Quiet-hours override refused: ${override.reason}`,
      readiness,
    };
  }

  try {
    await db
      .prepare(
        "INSERT INTO ai_voice_self_tests (id,phone_key,phone_last4,state,requested_by,quiet_hours_bypassed,created_at,updated_at) VALUES (?,?,?,'dialing',?,?,?,?)",
      )
      .bind(
        callId,
        phoneKey,
        phoneKey.slice(-4),
        actor.email,
        override.overrideUsed ? 1 : 0,
        now,
        now,
      )
      .run();
  } catch (error) {
    await releaseActiveGuard(db, callId);
    throw error;
  }

  let streamUrl: string;
  try {
    streamUrl = await signedStreamUrl(env, callId, publicOrigin);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Unable to create signed AgentStream URL";
    await db
      .prepare(
        "UPDATE ai_voice_self_tests SET state='failed',last_error=?,ended_at=?,updated_at=? WHERE id=?",
      )
      .bind(reason, now, now, callId)
      .run();
    await releaseActiveGuard(db, callId);
    return { ok: false as const, status: 409, reason, readiness };
  }

  const dial = await createExotelAgentStreamCall(env, {
    to: dialNumber,
    callId,
    streamUrl,
  });
  if (!dial.ok) {
    const failedAt = Date.now();
    await db
      .prepare(
        "UPDATE ai_voice_self_tests SET state='failed',last_error=?,ended_at=?,updated_at=? WHERE id=?",
      )
      .bind(dial.reason, failedAt, failedAt, callId)
      .run();
    await releaseActiveGuard(db, callId);
    return {
      ok: false as const,
      status: dial.status,
      reason: dial.reason,
      callId,
      phoneLast4: phoneKey.slice(-4),
      quietHoursBypassed: override.overrideUsed,
      readiness,
    };
  }

  await db
    .prepare("UPDATE ai_voice_self_tests SET provider_call_id=?,updated_at=? WHERE id=?")
    .bind(dial.providerCallId, Date.now(), callId)
    .run();

  return {
    ok: true as const,
    status: 201,
    callId,
    providerCallId: dial.providerCallId,
    providerStatus: dial.providerStatus,
    phoneLast4: phoneKey.slice(-4),
    quietHoursBypassed: override.overrideUsed,
    recording: false,
    maxCallSeconds: MAX_CALL_SECONDS,
  };
}

async function ttsPcm(ai: AiBinding, message: string, sampleRate: number) {
  const result = await ai.run(
    "@cf/deepgram/aura-1",
    {
      text: message,
      speaker: "asteria",
      encoding: "linear16",
      container: "none",
      sample_rate: sampleRate,
    },
    { returnRawResponse: true },
  );
  if (result instanceof Response) {
    return new Uint8Array(await result.arrayBuffer());
  }
  if (result && typeof (result as { getReader?: unknown }).getReader === "function") {
    return new Uint8Array(
      await new Response(result as ReadableStream<Uint8Array>).arrayBuffer(),
    );
  }
  throw new Error("Workers AI TTS returned no raw audio response");
}

function llmText(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const row = result as Record<string, unknown>;
  return typeof row.response === "string"
    ? row.response.trim()
    : typeof row.result === "string"
      ? row.result.trim()
      : "";
}

async function answer(ai: AiBinding, history: ChatMessage[], question: string) {
  const messages = [
    {
      role: "system",
      content:
        "You are PawSpace's internal UAT voice assistant. This is an allow-listed staff self-test. Answer naturally and concisely in one or two spoken sentences. You may answer general questions and explain PawSpace services, but do not execute bookings, payments, refunds, price changes, discounts, account changes, or other high-impact actions. Do not invent customer-specific data. Never claim an action was completed. Avoid markdown.",
    },
    ...history.slice(-8),
    { role: "user", content: question },
  ];
  return llmText(
    await ai.run("@cf/openai/gpt-oss-20b", {
      messages,
      max_tokens: 220,
      temperature: 0.4,
    }),
  ).slice(0, 800);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function sendPcm(
  socket: WorkerSocket,
  streamSid: string,
  audio: Uint8Array,
  sampleRate: number,
  shouldContinue: () => boolean = () => true,
) {
  // 100 ms per frame, computed from the NEGOTIATED rate: bytes = rate * 2 (16-bit mono) * 0.1.
  // At Exotel's 8 kHz that is 1600 bytes; the previous hardcoded 3200 was a 200 ms frame at 8 kHz,
  // so pacing and frame size disagreed with what the carrier expected.
  const frameMs = 100;
  const frameBytes = Math.max(2, Math.round(sampleRate * 2 * (frameMs / 1000)));
  for (let offset = 0; offset < audio.length; offset += frameBytes) {
    if (!shouldContinue()) return false;
    const part = audio.subarray(offset, Math.min(offset + frameBytes, audio.length));
    if (part.length < 2) break;
    let chunk = part;
    // Pad only to a whole 16-bit sample. Padding to 320 bytes appended up to 318 bytes of silence to
    // every short final frame, which is audible clipping at the end of each utterance.
    if (chunk.length % 2) {
      const padded = new Uint8Array(chunk.length + 1);
      padded.set(chunk);
      chunk = padded;
    }
    if (!shouldContinue()) return false;
    socket.send(
      JSON.stringify({
        event: "media",
        stream_sid: streamSid,
        media: { payload: toBase64(chunk) },
      }),
    );
    await sleep(frameMs);
  }
  return shouldContinue();
}

function supportedSampleRate(value: unknown) {
  const parsed = Number(text(value));
  // Exotel documents 8/16/24 kHz for the socket, but the PSTN leg is 8 kHz. Anything unrecognised
  // falls back to 8 kHz rather than to whatever the caller hoped for: a wrong rate is inaudible, and
  // silence with a healthy socket is the hardest failure of all to diagnose.
  return parsed === 8000 || parsed === 16000 || parsed === 24000
    ? parsed
    : EXOTEL_PSTN_SAMPLE_RATE;
}

/**
 * Voicebot-applet negotiate endpoint.
 *
 * A Voicebot applet is configured ONCE in the Exotel dashboard with a single static URL, but this
 * lane needs a per-call, short-lived, signed wss URL. Exotel documents exactly this case: give the
 * applet an https URL and it will call it and use the wss URL that comes back. Exotel invokes it with
 * the call's parameters, and `CustomField` carries the self-test id we set on the dial.
 *
 * This is UAT-gated and fails closed the same way the socket does. It deliberately does NOT accept a
 * destination or an origin from the request - the wss URL is rebuilt from the Worker's own origin and
 * signed with EXOTEL_WEBHOOK_SECRET, so a caller who reaches this endpoint cannot redirect the media
 * stream anywhere.
 */
export async function handleAiVoiceSelfTestNegotiate(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== SELF_TEST_NEGOTIATE_PATH) {
    return new Response("Not found", { status: 404 });
  }

  const readiness = aiVoiceSelfTestReadiness(env);
  const db = env.DB as Db | undefined;
  if (!readiness.enabled || !db) {
    return new Response(JSON.stringify({ error: "AI voice self-test is disabled" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  // Exotel sends applet parameters as query string on GET and as a form body on POST.
  const fields: Record<string, string> = {};
  for (const [key, value] of url.searchParams) fields[key.toLowerCase()] = value;
  if (request.method === "POST") {
    try {
      const form = await request.formData();
      for (const [key, value] of form) {
        if (typeof value === "string") fields[key.toLowerCase()] = value;
      }
    } catch {
      // A body we cannot parse is not fatal; the query string may still carry CustomField.
    }
  }

  const callId = text(fields.customfield || fields.custom_field);
  if (!callId) {
    return new Response(JSON.stringify({ error: "Missing CustomField call reference" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Only a self-test this Worker actually created, and only one still waiting for its stream.
  const row = await db
    .prepare("SELECT id,state FROM ai_voice_self_tests WHERE id=?")
    .bind(callId)
    .first<Record<string, unknown>>();
  if (!row) {
    return new Response(JSON.stringify({ error: "Unknown self-test reference" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (text(row.state) !== "dialing") {
    return new Response(JSON.stringify({ error: "Self-test stream was already negotiated or closed" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }

  const streamUrl = await signedStreamUrl(env, callId, url.origin);
  const now = Date.now();
  const negotiated = await db
    .prepare(
      "UPDATE ai_voice_self_tests SET state='negotiated',updated_at=? WHERE id=? AND state='dialing'",
    )
    .bind(now, callId)
    .run();
  if (Number(negotiated.meta?.changes || 0) !== 1) {
    return new Response(JSON.stringify({ error: "Self-test stream was already negotiated" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ url: streamUrl }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleAiVoiceSelfTestStream(
  request: Request,
  env: Env,
): Promise<Response> {
  if (new URL(request.url).pathname !== SELF_TEST_PATH) {
    return new Response("Not found", { status: 404 });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected websocket upgrade", { status: 426 });
  }

  const token = await verifyStreamRequest(request, env);
  if (!token.ok) return new Response("Unauthorized AgentStream request", { status: 401 });

  const readiness = aiVoiceSelfTestReadiness(env);
  const db = env.DB as Db | undefined;
  const ai = aiBinding(env);
  if (!readiness.enabled || !db || !ai) {
    return new Response("AI voice self-test is disabled", { status: 503 });
  }
  await ensureAiVoiceSelfTestTables(db);
  const claimedAt = Date.now();
  const streamClaim = await db
    .prepare(
      "UPDATE ai_voice_self_tests SET state='stream_claimed',updated_at=? WHERE id=? AND state='negotiated'",
    )
    .bind(claimedAt, token.callId)
    .run();
  if (Number(streamClaim.meta?.changes || 0) !== 1) {
    return new Response("AgentStream token is already used or call is not negotiated", { status: 409 });
  }

  const pair = createWebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept({ allowHalfOpen: true });

  let streamSid = "";
  let speaking = false;
  let playbackGeneration = 0;
  let turnCount = 0;
  let queue = Promise.resolve();
  let flux: WorkerSocket | null = null;
  let initializing: Promise<void> | null = null;
  let sampleRate = 8000;
  let sawStart = false;
  const history: ChatMessage[] = [];
  const pendingAudio: Uint8Array[] = [];
  let pendingBytes = 0;

  const setState = async (
    state: string,
    extra: { streamSid?: string; error?: string; ended?: boolean } = {},
  ) => {
    const now = Date.now();
    await db
      .prepare(
        "UPDATE ai_voice_self_tests SET state=?,stream_sid=COALESCE(?,stream_sid),turn_count=?,last_error=COALESCE(?,last_error),connected_at=CASE WHEN ?='streaming' AND connected_at IS NULL THEN ? ELSE connected_at END,ended_at=CASE WHEN ? THEN ? ELSE ended_at END,updated_at=? WHERE id=?",
      )
      .bind(
        state,
        extra.streamSid || null,
        turnCount,
        extra.error || null,
        state,
        now,
        extra.ended ? 1 : 0,
        now,
        now,
        token.callId,
      )
      .run()
      .catch(() => undefined);
    if (state === "ended" || state === "failed" || extra.ended) {
      await releaseActiveGuard(db, token.callId).catch(() => undefined);
    }
  };

  const sendClear = () => {
    playbackGeneration += 1;
    speaking = false;
    if (!streamSid) return;
    server.send(JSON.stringify({ event: "clear", stream_sid: streamSid }));
  };

  const onQuestion = (question: string) => {
    const clean = question.trim();
    if (!clean || turnCount >= MAX_TURNS) return;
    queue = queue
      .then(async () => {
        turnCount += 1;
        const normalized = clean.toLowerCase();
        if (/\b(do not call|stop calling|unsubscribe)\b/.test(normalized)) {
          await speak(
            "Understood. This self-test will end now.",
            `turn-${turnCount}-end`,
          );
          await setState("ended", { ended: true });
          return;
        }
        if (/\b(agent|human|person|team member)\b/.test(normalized)) {
          await speak(
            "This is a self-test line, so I will stop the AI conversation here.",
            `turn-${turnCount}-end`,
          );
          return;
        }

        let reply = "";
        try {
          reply = await answer(ai, history, clean);
        } catch {
          reply =
            "I could not reach the AI answer service for that question. Please try again.";
        }
        if (!reply) {
          reply = "I do not have a reliable answer for that. Please ask another question.";
        }
        history.push(
          { role: "user", content: clean },
          { role: "assistant", content: reply },
        );
        await speak(reply, `turn-${turnCount}-end`);
        await setState("streaming");
      })
      .catch(async (error) => {
        await setState("failed", {
          error: error instanceof Error ? error.message : "AI voice turn failed",
          ended: true,
        });
      });
  };

  const attachFlux = (socket: WorkerSocket) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const kind = text(payload.event || payload.type);
      if (kind === "StartOfTurn" && speaking && streamSid) {
        sendClear();
        speaking = false;
      }
      if (kind === "EndOfTurn") {
        onQuestion(text(payload.transcript));
      }
    });
    socket.addEventListener("error", () => {
      void setState("failed", {
        error: "Workers AI speech recognizer failed",
        ended: true,
      });
    });
    socket.addEventListener("close", () => {
      flux = null;
    });
  };

  const initializeFlux = () => {
    if (flux && flux.readyState === WebSocket.OPEN) return Promise.resolve();
    if (initializing) return initializing;

    initializing = (async () => {
      await ensureAiVoiceSelfTestTables(db);
      const call = await db
        .prepare("SELECT id,state FROM ai_voice_self_tests WHERE id=?")
        .bind(token.callId)
        .first<Row>();
      if (!call || !["stream_claimed", "streaming"].includes(text(call.state))) {
        throw new Error("Unknown or closed AI voice self-test");
      }

      const fluxResponse = (await ai.run(
        "@cf/deepgram/flux",
        {
          encoding: "linear16",
          sample_rate: String(sampleRate),
          eot_threshold: "0.65",
          eot_timeout_ms: "1200",
          mip_opt_out: "true",
          tag: "pawspace-uat-ai-self-test",
        },
        { websocket: true },
      )) as Response & { webSocket?: WorkerSocket };
      const socket = fluxResponse.webSocket;
      if (!socket) {
        throw new Error("Workers AI speech recognizer did not open a WebSocket");
      }
      socket.accept({ allowHalfOpen: true });
      flux = socket;
      attachFlux(socket);

      while (pendingAudio.length && socket.readyState === WebSocket.OPEN) {
        const chunk = pendingAudio.shift();
        if (chunk) {
          pendingBytes -= chunk.byteLength;
          socket.send(chunk);
        }
      }
    })()
      .catch(async (error) => {
        const message =
          error instanceof Error ? error.message : "AI stream initialization failed";
        await setState("failed", { error: message, ended: true });
        try {
          server.close(1011, "AI initialization failed");
        } catch {
          // ignore close races
        }
        throw error;
      })
      .finally(() => {
        initializing = null;
      });

    return initializing;
  };

  const speak = async (message: string, mark: string) => {
    if (!streamSid || !message.trim()) return;
    const generation = ++playbackGeneration;
    speaking = true;
    try {
      const audio = await ttsPcm(ai, message.trim(), sampleRate);
      if (playbackGeneration !== generation) return;
      const completed = await sendPcm(
        server,
        streamSid,
        audio,
        sampleRate,
        () => playbackGeneration === generation,
      );
      if (!completed || playbackGeneration !== generation) return;
      server.send(
        JSON.stringify({
          event: "mark",
          stream_sid: streamSid,
          mark: { name: mark },
        }),
      );
    } catch (error) {
      speaking = false;
      await setState("failed", {
        error: error instanceof Error ? error.message : "TTS failure",
        ended: true,
      });
      try {
        server.close(1011, "speech failure");
      } catch {
        // ignore close races
      }
    }
  };

  const startDeadline = setTimeout(() => {
    if (!sawStart) {
      void setState("failed", {
        error: "AgentStream WebSocket opened but Exotel sent no start event within 10 seconds",
        ended: true,
      });
      try {
        server.close(1011, "missing start event");
      } catch {
        // ignore close races
      }
    }
  }, 10_000);

  server.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    void (async () => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }

      const kind = text(payload.event);
      if (kind === "connected") return;

      if (kind === "start") {
        sawStart = true;
        clearTimeout(startDeadline);
        const start =
          payload.start && typeof payload.start === "object"
            ? (payload.start as Record<string, unknown>)
            : {};
        const mediaFormat =
          start.media_format && typeof start.media_format === "object"
            ? (start.media_format as Record<string, unknown>)
            : {};
        sampleRate = supportedSampleRate(mediaFormat.sample_rate);
        streamSid = text(payload.stream_sid || start.stream_sid);
        if (!streamSid) {
          await setState("failed", {
            error: "Exotel start event did not include stream_sid",
            ended: true,
          });
          server.close(1002, "missing stream_sid");
          return;
        }

        await setState("streaming", { streamSid });
        void initializeFlux().catch(() => undefined);
        await speak(
          "Hi, this is PawSpace's AI self-test assistant. This is an automated UAT call you requested. Ask me any question. This test cannot make bookings, payments, refunds, or account changes.",
          "opening-end",
        );
        return;
      }

      if (kind === "media") {
        const media =
          payload.media && typeof payload.media === "object"
            ? (payload.media as Record<string, unknown>)
            : {};
        const encoded = text(media.payload);
        if (!encoded) return;
        const audio = fromBase64(encoded);
        if (flux && flux.readyState === WebSocket.OPEN) {
          flux.send(audio);
        } else {
          if (pendingBytes < 64_000) {
            pendingAudio.push(audio);
            pendingBytes += audio.byteLength;
          }
          if (sawStart) void initializeFlux().catch(() => undefined);
        }
        return;
      }

      if (kind === "mark") {
        speaking = false;
        return;
      }

      if (kind === "stop") {
        clearTimeout(startDeadline);
        await setState("ended", { ended: true });
        try {
          flux?.close(1000, "call ended");
        } catch {
          // ignore close races
        }
      }
    })().catch(async (error) => {
      await setState("failed", {
        error: error instanceof Error ? error.message : "Exotel stream event failed",
        ended: true,
      });
    });
  });

  server.addEventListener("close", () => {
    clearTimeout(startDeadline);
    void setState("ended", { ended: true });
    try {
      flux?.close(1000, "provider socket closed");
    } catch {
      // ignore close races
    }
  });

  server.addEventListener("error", () => {
    clearTimeout(startDeadline);
    void setState("failed", {
      error: "Exotel AgentStream socket failed",
      ended: true,
    });
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  } as ResponseInit & { webSocket: WebSocket });
}
