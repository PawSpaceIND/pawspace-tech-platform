/**
 * The telephony provider boundary. One interface, three implementations, and nothing above this line
 * knows which one it is talking to.
 */

import { callRecordingApproved, statusCallbackUrl, telephonyCredentialsConfigured, voiceMode, VOICE_TELEPHONY_SECRET_NAMES } from "./voice-call-gate";
import { ProviderResponseTooLarge, readBoundedText as readBoundedResponseText } from "./provider-response-bounds";

type Env = Record<string, unknown>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();

export type TelephonyEventKind =
  | "dialing" | "ringing" | "connected" | "dtmf"
  | "no_answer" | "busy" | "failed" | "completed" | "recording_available";

export type TelephonyCallIntent = {
  callRef: string;
  toNumber: string;
  statusCallbackUrl: string;
  recordingAllowed: boolean;
  timeoutSeconds?: number;
  simulatedOutcome?: TelephonyEventKind | null;
  customerId?: string | null;
  leadId?: string | null;
  bookingId?: string | null;
  useCase?: string | null;
};

export type TelephonyCallHandle = { accepted: boolean; providerCallId: string; providerStatus: string; productionCall: boolean };
export type TelephonyProviderEvent = { providerEventId: string; kind: TelephonyEventKind; callRef: string | null; providerCallId: string | null; providerStatus: string | null; dtmfDigits: string | null; recordingRef: string | null; durationSeconds: number | null };
export type TelephonyWebhookVerification = { verified: boolean; mechanism: string | null; reason: string | null };
export type TelephonyProvider = {
  provider: string;
  status: "connected" | "not_connected" | "simulated";
  productionCapable: boolean;
  createCall(intent: TelephonyCallIntent): Promise<TelephonyCallHandle>;
  verifyWebhook(input: { rawBody: string; headers: Headers }): Promise<TelephonyWebhookVerification>;
  parseEvent(rawBody: string): TelephonyProviderEvent;
};

export class TelephonyProviderUnavailable extends Error {
  readonly code = "provider_unavailable";
  constructor(message: string) { super(message); this.name = "TelephonyProviderUnavailable"; }
}

export const disconnectedTelephony: TelephonyProvider = {
  provider: "not_connected", status: "not_connected", productionCapable: false,
  async createCall() { throw new TelephonyProviderUnavailable("Telephony provider is not connected"); },
  async verifyWebhook() { return { verified: false, mechanism: null, reason: "Telephony provider is not connected" }; },
  parseEvent() { throw new TelephonyProviderUnavailable("Telephony provider is not connected"); },
};

function hex(bytes: ArrayBuffer) { return Array.from(new Uint8Array(bytes)).map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function safeEqual(a: string, b: string) { if (a.length !== b.length) return false; let out = 0; for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i); return out === 0; }
async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}
export async function sha256Hex(body: string) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))); }

export const VOICE_SIGNATURE_HEADER = "x-pawspace-voice-signature";
export const VOICE_TIMESTAMP_HEADER = "x-pawspace-voice-timestamp";
const SIGNATURE_FRESHNESS_MS = 300_000;

export async function verifyVoiceWebhookSignature(secret: string, rawBody: string, headers: Headers, asOf = Date.now()): Promise<TelephonyWebhookVerification> {
  if (!secret) return { verified: false, mechanism: null, reason: "Webhook secret is not configured" };
  const signature = (headers.get(VOICE_SIGNATURE_HEADER) || "").trim().toLowerCase();
  if (signature) {
    const timestamp = (headers.get(VOICE_TIMESTAMP_HEADER) || "").trim(), stamped = Number(timestamp);
    if (!timestamp || !Number.isFinite(stamped)) return { verified: false, mechanism: "hmac", reason: "Signature timestamp is missing or malformed" };
    if (Math.abs(asOf - stamped) > SIGNATURE_FRESHNESS_MS) return { verified: false, mechanism: "hmac", reason: "Signature timestamp is outside the freshness window" };
    const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
    return safeEqual(expected, signature) ? { verified: true, mechanism: "hmac", reason: null } : { verified: false, mechanism: "hmac", reason: "Signature does not match" };
  }
  const authorization = (headers.get("authorization") || "").trim();
  if (/^basic /i.test(authorization)) {
    let decoded = "";
    try { decoded = atob(authorization.slice(6).trim()); } catch { return { verified: false, mechanism: "basic", reason: "Malformed Basic credentials" }; }
    const password = decoded.slice(decoded.indexOf(":") + 1);
    return safeEqual(password, secret) ? { verified: true, mechanism: "basic", reason: null } : { verified: false, mechanism: "basic", reason: "Basic credentials do not match" };
  }
  return { verified: false, mechanism: null, reason: "No webhook signature or Basic credentials presented" };
}

function mapProviderStatus(status: string, event: string): TelephonyEventKind {
  const value = `${event} ${status}`.toLowerCase();
  if (value.includes("dtmf") || value.includes("digits")) return "dtmf";
  if (value.includes("recording")) return "recording_available";
  if (/(^|[^a-z])(no[-_ ]?answer|noanswer|not[-_ ]?answered|unanswered)/.test(value)) return "no_answer";
  if (value.includes("busy")) return "busy";
  if (/(dis|not[-_ ]?|un|non[-_ ]?)(connect|answer)/.test(value)) return "failed";
  if (value.includes("failed") || value.includes("failure") || value.includes("cancel") || value.includes("reject") || value.includes("declin")) return "failed";
  if (value.includes("completed") || value.includes("complete")) return "completed";
  if (value.includes("in-progress") || value.includes("in_progress") || value.includes("connected") || value.includes("answered")) return "connected";
  if (value.includes("ringing") || value.includes("alerting")) return "ringing";
  if (value.includes("queued") || value.includes("initiated") || value.includes("dialing")) return "dialing";
  return "failed";
}

export function normaliseTelephonyEvent(rawBody: string, provider: string): TelephonyProviderEvent {
  const fields = new Map<string, string>(), trimmed = String(rawBody ?? "").trim();
  if (trimmed.startsWith("{")) {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(trimmed) as Record<string, unknown>; } catch { throw new Error("Provider event body is not valid JSON"); }
    for (const [key, value] of Object.entries(parsed)) if (value !== null && typeof value !== "object") fields.set(key.toLowerCase(), String(value));
  } else for (const [key, value] of new URLSearchParams(trimmed)) fields.set(key.toLowerCase(), value);
  const pick = (...names: string[]) => { for (const name of names) { const value = fields.get(name.toLowerCase()); if (value != null && value !== "") return value; } return ""; };
  const providerEventId = pick("eventid", "event_id", "callsid", "call_sid", "sid");
  if (!providerEventId) throw new Error("Provider event is missing an event identifier");
  const status = pick("callstatus", "status", "dialcallstatus"), event = pick("eventtype", "event_type", "event"), digits = pick("digits", "dtmf", "dtmfdigits"), duration = Number(pick("callduration", "duration", "conversationduration") || 0);
  return { providerEventId: `${provider}:${providerEventId}:${event || status || "event"}`, kind: mapProviderStatus(status, event), callRef: pick("customfield", "custom_field", "callref", "call_ref") || null, providerCallId: pick("callsid", "call_sid", "sid") || null, providerStatus: status || event || null, dtmfDigits: digits ? digits.replace(/[^0-9*#]/g, "").slice(0, 32) : null, recordingRef: pick("recordingurl", "recording_url") || null, durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null };
}

const EXOTEL_TIMEOUT_MS = 12_000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  try { return await readBoundedResponseText(response, maxBytes); }
  catch (error) { if (error instanceof ProviderResponseTooLarge) throw new TelephonyProviderUnavailable("Telephony provider response exceeded the size limit"); throw error; }
}

function safeProviderErrorCode(raw: string) {
  const safe = (value: unknown) => { const text = String(value ?? "").trim(); return /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? text : null; };
  const field = (value: unknown, key: string): unknown => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const value of [parsed.code, parsed.Code, field(parsed.error, "code"), field(parsed.error_data, "code"), field(parsed.ResponseData, "Code"), field(parsed.response, "code"), field(field(parsed.response, "error_data"), "code")]) {
      const code = safe(value); if (code) return code;
    }
  } catch {}
  const xml = raw.match(/<(?:Code|code)>\s*([A-Za-z0-9_.:-]{1,64})\s*<\/(?:Code|code)>/);
  return safe(xml?.[1]);
}

function approvedStreamUrl(env: Env) {
  const value = val(env, "PAWSPACE_VOICE_STREAM_URL");
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "wss:") throw new Error("not wss");
    return url.toString();
  } catch { throw new TelephonyProviderUnavailable("PAWSPACE_VOICE_STREAM_URL must be an absolute wss URL"); }
}

export function exotelTelephony(env: Env): TelephonyProvider {
  const sid = val(env, "EXOTEL_SID"), key = val(env, "EXOTEL_API_KEY"), token = val(env, "EXOTEL_API_TOKEN");
  const callerId = val(env, "EXOTEL_CALLER_ID"), appId = val(env, "EXOTEL_VOICE_APP_ID"), secret = val(env, "EXOTEL_WEBHOOK_SECRET");
  const subdomain = val(env, "EXOTEL_SUBDOMAIN") || "api.exotel.com";
  const missing = VOICE_TELEPHONY_SECRET_NAMES.filter(name => !val(env, name));
  if (missing.length) return disconnectedTelephony;
  return {
    provider: "exotel", status: "connected", productionCapable: true,
    async createCall(intent) {
      const approved = statusCallbackUrl(env);
      if (!approved) throw new TelephonyProviderUnavailable("A https status callback URL is required before a call may be placed (PAWSPACE_VOICE_STATUS_CALLBACK_URL)");
      if (intent.statusCallbackUrl !== approved) throw new TelephonyProviderUnavailable("The status callback does not match the approved environment callback");
      if (intent.recordingAllowed && !callRecordingApproved(env)) throw new TelephonyProviderUnavailable("Call recording is not approved for this environment (PAWSPACE_VOICE_RECORDING_APPROVED)");
      const streamUrl = approvedStreamUrl(env);
      const timeout = String(Math.max(15, Math.min(intent.timeoutSeconds ?? 45, 120)));
      const body = streamUrl
        ? (() => {
            const params = new URLSearchParams({
              From: intent.toNumber,
              CallerId: callerId,
              StreamUrl: streamUrl,
              StreamType: "bidirectional",
              StatusCallback: intent.statusCallbackUrl,
              CustomField: intent.callRef,
              Record: intent.recordingAllowed ? "true" : "false",
              TimeLimit: timeout,
            });
            params.append("StatusCallbackEvents[]", "terminal");
            return params;
          })()
        : new URLSearchParams({ From: intent.toNumber, CallerId: callerId, Url: `http://my.exotel.com/${sid}/exoml/start_voice/${appId}`, CallType: "trans", StatusCallback: intent.statusCallbackUrl, CustomField: intent.callRef, TimeOut: timeout, Record: intent.recordingAllowed ? "true" : "false" });
      const endpoint = `https://${subdomain}/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect.json`;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), EXOTEL_TIMEOUT_MS);
      try {
        let response: Response, responseText: string;
        try {
          const headers: Record<string, string> = { authorization: `Basic ${btoa(`${key}:${token}`)}`, "content-type": "application/x-www-form-urlencoded" };
          response = await fetch(endpoint, { method: "POST", signal: controller.signal, headers, body: body.toString() });
          responseText = await readBoundedText(response, MAX_PROVIDER_RESPONSE_BYTES);
        } catch (error) {
          throw new TelephonyProviderUnavailable(controller.signal.aborted ? `Telephony provider did not respond within ${EXOTEL_TIMEOUT_MS}ms` : `Telephony provider request failed: ${String((error as Error)?.message || error).slice(0, 120)}`);
        }
        if (!response.ok) {
          const code = safeProviderErrorCode(responseText);
          throw new TelephonyProviderUnavailable(`Telephony provider rejected the call request (${response.status}${code ? `; code ${code}` : ""})`);
        }
        let parsed: { Call?: { Sid?: string; Status?: string }; call?: { sid?: string; status?: string } } = {};
        try { parsed = JSON.parse(responseText) as typeof parsed; } catch { throw new TelephonyProviderUnavailable("Telephony provider returned a malformed response"); }
        const providerCallId = String(parsed.call?.sid || parsed.Call?.Sid || "").trim();
        if (!providerCallId) throw new TelephonyProviderUnavailable("Telephony provider returned no call identifier");
        return { accepted: true, providerCallId, providerStatus: String(parsed.call?.status || parsed.Call?.Status || "queued"), productionCall: true };
      } finally { clearTimeout(timer); }
    },
    async verifyWebhook({ rawBody, headers }) { return verifyVoiceWebhookSignature(secret, rawBody, headers); },
    parseEvent(rawBody) { return normaliseTelephonyEvent(rawBody, "exotel"); },
  };
}

export const ELEVENLABS_EXOTEL_PROVIDER = "elevenlabs_exotel";
export function elevenLabsAgentIdForUseCase(env: Env, useCase?: string | null) {
  const code = String(useCase ?? "").trim().toLowerCase();
  if (code === "grooming_sales") return val(env, "ELEVENLABS_GROOMING_AGENT_ID") || val(env, "ELEVENLABS_AGENT_ID");
  if (code === "training_sales") return val(env, "ELEVENLABS_TRAINING_AGENT_ID") || val(env, "ELEVENLABS_AGENT_ID");
  return val(env, "ELEVENLABS_AGENT_ID");
}
export function elevenLabsExotelTelephony(env: Env): TelephonyProvider {
  const apiKey = val(env, "ELEVENLABS_API_KEY"), defaultAgentId = val(env, "ELEVENLABS_AGENT_ID"), configuredPhoneNumberId = val(env, "ELEVENLABS_AGENT_PHONE_NUMBER_ID");
  if (!apiKey || !defaultAgentId || !configuredPhoneNumberId) return disconnectedTelephony;
  const base = (val(env, "ELEVENLABS_API_BASE") || "https://api.in.residency.elevenlabs.io").replace(/\/$/, "");
  const callerLast10 = val(env, "EXOTEL_CALLER_ID").replace(/\D/g, "").slice(-10);
  return {
    provider: ELEVENLABS_EXOTEL_PROVIDER, status: "connected", productionCapable: true,
    async createCall(intent) {
      if (intent.recordingAllowed && !callRecordingApproved(env)) throw new TelephonyProviderUnavailable("Call recording is not approved for this environment (PAWSPACE_VOICE_RECORDING_APPROVED)");
      const agentId = elevenLabsAgentIdForUseCase(env, intent.useCase);
      if (!agentId) throw new TelephonyProviderUnavailable("ElevenLabs agent is not configured for this voice use case");
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), EXOTEL_TIMEOUT_MS);
      const headers = { "content-type": "application/json", "xi-api-key": apiKey };
      const bodyFor = (phoneNumberId: string) => JSON.stringify({
        agent_id: agentId,
        agent_phone_number_id: phoneNumberId,
        to_number: intent.toNumber,
        conversation_initiation_client_data: {
          custom_llm_extra_body: { pawspace_voice_call_id: intent.callRef },
          dynamic_variables: {
            pawspace_voice_call_id: intent.callRef,
            pawspace_customer_id: intent.customerId || "",
            pawspace_lead_id: intent.leadId || "",
            pawspace_booking_id: intent.bookingId || "",
            pawspace_voice_use_case: intent.useCase || "",
          },
        },
      });
      const place = async (phoneNumberId: string) => {
        const response = await fetch(`${base}/v1/convai/exotel/outbound-call`, { method: "POST", signal: controller.signal, headers, body: bodyFor(phoneNumberId) });
        return { response, raw: await readBoundedText(response, MAX_PROVIDER_RESPONSE_BYTES) };
      };
      const resolveCurrentPhoneNumberId = async () => {
        const candidates = [...new Set([base, "https://api.elevenlabs.io"])];
        for (const apiBase of candidates) {
          let response: Response, raw: string;
          try {
            response = await fetch(`${apiBase}/v1/convai/phone-numbers?provider=exotel`, { signal: controller.signal, headers: { "xi-api-key": apiKey } });
            raw = await readBoundedText(response, MAX_PROVIDER_RESPONSE_BYTES);
          } catch { continue; }
          if (!response.ok) continue;
          let parsed: { phone_numbers?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
          try { parsed = JSON.parse(raw) as typeof parsed; } catch { continue; }
          const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.phone_numbers) ? parsed.phone_numbers : [];
          const exotel = rows.filter(row => !row.provider || String(row.provider).toLowerCase() === "exotel");
          const matching = callerLast10 ? exotel.filter(row => String(row.phone_number || "").replace(/\D/g, "").slice(-10) === callerLast10) : exotel;
          const selected = matching.length === 1 ? matching[0] : (!callerLast10 && exotel.length === 1 ? exotel[0] : null);
          const id = String(selected?.phone_number_id || selected?.id || "").trim();
          if (id) return id;
        }
        throw new TelephonyProviderUnavailable("ElevenLabs Exotel phone number is stale and no unique current ExoPhone could be resolved");
      };
      try {
        let response: Response, raw: string;
        try {
          ({ response, raw } = await place(configuredPhoneNumberId));
          if (response.status === 404) {
            const currentPhoneNumberId = await resolveCurrentPhoneNumberId();
            ({ response, raw } = await place(currentPhoneNumberId));
          }
        } catch (error) {
          if (error instanceof TelephonyProviderUnavailable) throw error;
          throw new TelephonyProviderUnavailable(controller.signal.aborted ? `ElevenLabs outbound provider did not respond within ${EXOTEL_TIMEOUT_MS}ms` : `ElevenLabs outbound provider request failed: ${String((error as Error)?.message || error).slice(0, 120)}`);
        }
        if (!response.ok) throw new TelephonyProviderUnavailable(`ElevenLabs outbound provider rejected the call request (${response.status})`);
        let parsed: { success?: boolean; conversation_id?: string; callSid?: string; message?: string } = {};
        try { parsed = JSON.parse(raw) as typeof parsed; } catch { throw new TelephonyProviderUnavailable("ElevenLabs outbound provider returned a malformed response"); }
        const providerCallId = String(parsed.callSid || parsed.conversation_id || "").trim();
        if (!parsed.success || !providerCallId) throw new TelephonyProviderUnavailable("ElevenLabs outbound provider returned no accepted call identifier");
        return { accepted: true, providerCallId, providerStatus: "queued", productionCall: true };
      } finally { clearTimeout(timer); }
    },
    async verifyWebhook() { return { verified: false, mechanism: null, reason: "ElevenLabs callbacks are verified on the dedicated signed post-call endpoint" }; },
    parseEvent() { throw new TelephonyProviderUnavailable("ElevenLabs events are reconciled through the dedicated post-call endpoint"); },
  };
}

export const LOCAL_SIMULATOR_PROVIDER = "local_simulator_non_production";
export function localSimulatorTelephony(env: Env): TelephonyProvider {
  const secret = val(env, "EXOTEL_WEBHOOK_SECRET") || val(env, "PAWSPACE_VOICE_SIMULATOR_SECRET");
  return { provider: LOCAL_SIMULATOR_PROVIDER, status: "simulated", productionCapable: false,
    async createCall(intent) { if (intent.simulatedOutcome === "failed") throw new TelephonyProviderUnavailable("Simulated telephony dial failure"); return { accepted: true, providerCallId: `SIMCALL-${intent.callRef}`, providerStatus: intent.simulatedOutcome || "queued", productionCall: false }; },
    async verifyWebhook({ rawBody, headers }) { return verifyVoiceWebhookSignature(secret, rawBody, headers); },
    parseEvent(rawBody) { return normaliseTelephonyEvent(rawBody, LOCAL_SIMULATOR_PROVIDER); },
  };
}

export function selectTelephonyProvider(env: Env): TelephonyProvider {
  if (val(env, "PAWSPACE_VOICE_TRANSPORT") === LOCAL_SIMULATOR_PROVIDER && voiceMode(env) !== "live") return localSimulatorTelephony(env);
  if (val(env, "PAWSPACE_VOICE_RUNTIME").toLowerCase() === "elevenlabs") {
    const eleven = elevenLabsExotelTelephony(env);
    if (eleven.status === "connected") return eleven;
  }
  if (telephonyCredentialsConfigured(env)) return exotelTelephony(env);
  return disconnectedTelephony;
}

export function telephonyProviderStatus(env: Env) {
  const provider = selectTelephonyProvider(env);
  return { provider: provider.provider, status: provider.status, productionCapable: provider.productionCapable, recordingApproved: callRecordingApproved(env), missingSecretNames: VOICE_TELEPHONY_SECRET_NAMES.filter(name => !val(env, name)), webhookMechanisms: ["hmac_sha256_signature", "http_basic"], streamConfigured: Boolean(val(env, "PAWSPACE_VOICE_STREAM_URL")), truth: { verifiedAgainstLiveProvider: false, callsPlaced: 0 } };
}
