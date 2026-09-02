/**
 * The telephony provider boundary. One interface, three implementations, and nothing above this line
 * knows which one it is talking to.
 *
 * What existed before: the type `VoiceTransportProvider = "exotel" | "sandbox_simulator"` and nothing
 * behind it. No call was ever created, no provider event was ever received, no callback was ever
 * verified - the string was written into a database column and that was the whole integration. The
 * registry (INT-VOICE-01) recorded this honestly as `partial`.
 *
 * Exotel is the provider the integration registry already selected for telephony; this module does not
 * choose one. It is also NOT connected: there are no credentials in any environment this code has run
 * in, so the Exotel adapter below has never exchanged a packet with Exotel. It is a complete, reviewable
 * request/response/verification contract, not a verified integration - see docs/VOICE_UAT_CHECKLIST.md.
 *
 * Provider payloads are normalised to a small curated event shape on the way in. Raw provider bodies
 * are never returned from here, so no caller can persist one by accident.
 */

import { callRecordingApproved, statusCallbackUrl, telephonyCredentialsConfigured, voiceMode, VOICE_TELEPHONY_SECRET_NAMES } from "./voice-call-gate";
import { ProviderResponseTooLarge, readBoundedText as readBoundedResponseText } from "./provider-response-bounds";

type Env = Record<string, unknown>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();

export type TelephonyEventKind =
  | "dialing" | "ringing" | "connected" | "dtmf"
  | "no_answer" | "busy" | "failed" | "completed" | "recording_available";

export type TelephonyCallIntent = {
  /** Our own call id. Round-trips through the provider so a callback can be matched to a call. */
  callRef: string;
  toNumber: string;
  statusCallbackUrl: string;
  /** Only ever true when PAWSPACE_VOICE_RECORDING_APPROVED is set; the caller does not get to decide. */
  recordingAllowed: boolean;
  timeoutSeconds?: number;
  /** Deterministic behaviour selector, honoured by the local simulator ONLY. */
  simulatedOutcome?: TelephonyEventKind | null;
};

/**
 * Peer-to-peer two-leg connect: dial the first leg, and on answer bridge it to the second, presenting the
 * masking CallerId (the ExoPhone) to BOTH so neither party sees the other's real number. The two numbers
 * are resolved server-side by the governance layer; a caller never supplies them.
 */
export type TelephonyBridgeIntent = {
  callRef: string;
  firstLegNumber: string;
  secondLegNumber: string;
  statusCallbackUrl: string;
  /** Only ever true when PAWSPACE_VOICE_RECORDING_APPROVED is set; the caller does not get to decide. */
  recordingAllowed: boolean;
  timeoutSeconds?: number;
  /** Deterministic behaviour selector, honoured by the local simulator ONLY. */
  simulatedOutcome?: TelephonyEventKind | null;
};

export type TelephonyCallHandle = {
  accepted: boolean;
  providerCallId: string;
  providerStatus: string;
  /** False for every adapter that is not a real carrier. Callers must not claim a call was placed. */
  productionCall: boolean;
};

export type TelephonyProviderEvent = {
  providerEventId: string;
  kind: TelephonyEventKind;
  callRef: string | null;
  providerCallId: string | null;
  providerStatus: string | null;
  dtmfDigits: string | null;
  recordingRef: string | null;
  durationSeconds: number | null;
};

export type TelephonyWebhookVerification = { verified: boolean; mechanism: string | null; reason: string | null };

export type TelephonyProvider = {
  provider: string;
  status: "connected" | "not_connected" | "simulated";
  /** True only for an adapter that can actually reach the public telephone network. */
  productionCapable: boolean;
  createCall(intent: TelephonyCallIntent): Promise<TelephonyCallHandle>;
  /** Optional: not every transport can bridge two legs. Absent => the bridge governance refuses (503). */
  connectTwoNumbers?(intent: TelephonyBridgeIntent): Promise<TelephonyCallHandle>;
  verifyWebhook(input: { rawBody: string; headers: Headers }): Promise<TelephonyWebhookVerification>;
  parseEvent(rawBody: string): TelephonyProviderEvent;
};

export class TelephonyProviderUnavailable extends Error {
  readonly code = "provider_unavailable";
  constructor(message: string) { super(message); this.name = "TelephonyProviderUnavailable"; }
}

/** The fail-closed default. Every method refuses; nothing is fabricated. */
export const disconnectedTelephony: TelephonyProvider = {
  provider: "not_connected",
  status: "not_connected",
  productionCapable: false,
  async createCall() { throw new TelephonyProviderUnavailable("Telephony provider is not connected"); },
  async connectTwoNumbers() { throw new TelephonyProviderUnavailable("Telephony provider is not connected"); },
  async verifyWebhook() { return { verified: false, mechanism: null, reason: "Telephony provider is not connected" }; },
  parseEvent() { throw new TelephonyProviderUnavailable("Telephony provider is not connected"); },
};

// --- shared webhook verification -------------------------------------------------------------------

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

/**
 * Two accepted mechanisms, both shared-secret and both compared in constant time:
 *
 *   1. HMAC-SHA256 over `${timestamp}.${rawBody}` in x-pawspace-voice-signature, with the timestamp
 *      in x-pawspace-voice-timestamp. Preferred, and the only one with replay protection built in.
 *   2. HTTP Basic, password = EXOTEL_WEBHOOK_SECRET. Exotel's status callback cannot HMAC-sign a
 *      payload but it CAN be configured with a Basic-auth callback URL, so this is what makes the
 *      receiver deployable against the real provider. It carries no freshness of its own; replay is
 *      handled by provider-event idempotency in the governance layer.
 *
 * A query-string token is deliberately not accepted: it would end up in access logs and referrers.
 * No secret -> refuse. No recognised mechanism -> refuse. There is no unauthenticated path in.
 */
export async function verifyVoiceWebhookSignature(secret: string, rawBody: string, headers: Headers, asOf = Date.now()): Promise<TelephonyWebhookVerification> {
  if (!secret) return { verified: false, mechanism: null, reason: "Webhook secret is not configured" };
  const signature = (headers.get(VOICE_SIGNATURE_HEADER) || "").trim().toLowerCase();
  if (signature) {
    const timestamp = (headers.get(VOICE_TIMESTAMP_HEADER) || "").trim();
    const stamped = Number(timestamp);
    if (!timestamp || !Number.isFinite(stamped)) return { verified: false, mechanism: "hmac", reason: "Signature timestamp is missing or malformed" };
    if (Math.abs(asOf - stamped) > SIGNATURE_FRESHNESS_MS) return { verified: false, mechanism: "hmac", reason: "Signature timestamp is outside the freshness window" };
    const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
    return safeEqual(expected, signature)
      ? { verified: true, mechanism: "hmac", reason: null }
      : { verified: false, mechanism: "hmac", reason: "Signature does not match" };
  }
  const authorization = (headers.get("authorization") || "").trim();
  if (/^basic /i.test(authorization)) {
    let decoded = "";
    try { decoded = atob(authorization.slice(6).trim()); } catch { return { verified: false, mechanism: "basic", reason: "Malformed Basic credentials" }; }
    const password = decoded.slice(decoded.indexOf(":") + 1);
    return safeEqual(password, secret)
      ? { verified: true, mechanism: "basic", reason: null }
      : { verified: false, mechanism: "basic", reason: "Basic credentials do not match" };
  }
  return { verified: false, mechanism: null, reason: "No webhook signature or Basic credentials presented" };
}

// --- normalisation ---------------------------------------------------------------------------------

/**
 * Exotel's CallStatus / event vocabulary mapped onto ours. Anything unrecognised is a failure.
 *
 * NEGATIVE tokens are matched first, and that ordering is the whole correctness of this function.
 * Substring matching on the positive words is a trap: "disconnected" and "not_connected" both contain
 * "connected", and "not_answered" contains "answered" - so a terminal or failed callback was classified
 * as `connected` and moved the call into an ACTIVE lifecycle state. A failed call reported as answered
 * is worse than an unclassified one, so anything negative resolves before anything positive.
 */
function mapProviderStatus(status: string, event: string): TelephonyEventKind {
  const value = `${event} ${status}`.toLowerCase();
  if (value.includes("dtmf") || value.includes("digits")) return "dtmf";
  if (value.includes("recording")) return "recording_available";
  if (/(^|[^a-z])(no[-_ ]?answer|noanswer|not[-_ ]?answered|unanswered)/.test(value)) return "no_answer";
  if (value.includes("busy")) return "busy";
  // Negatives before positives. Ordered here so a new negative token cannot be shadowed by a positive
  // substring it happens to contain.
  if (/(dis|not[-_ ]?|un|non[-_ ]?)(connect|answer)/.test(value)) return "failed";
  if (value.includes("failed") || value.includes("failure") || value.includes("cancel") || value.includes("reject") || value.includes("declin")) return "failed";
  if (value.includes("completed") || value.includes("complete")) return "completed";
  if (value.includes("in-progress") || value.includes("in_progress") || value.includes("connected") || value.includes("answered")) return "connected";
  if (value.includes("ringing") || value.includes("alerting")) return "ringing";
  if (value.includes("queued") || value.includes("initiated") || value.includes("dialing")) return "dialing";
  return "failed";
}

/**
 * Provider callbacks arrive either form-encoded or as JSON depending on the provider's configuration,
 * so both are accepted - and only the named fields are lifted out. Everything else in the body is
 * discarded here, which is what keeps an uncontrolled provider payload out of our database.
 */
export function normaliseTelephonyEvent(rawBody: string, provider: string): TelephonyProviderEvent {
  const fields = new Map<string, string>();
  const trimmed = String(rawBody ?? "").trim();
  if (trimmed.startsWith("{")) {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(trimmed) as Record<string, unknown>; } catch { throw new Error("Provider event body is not valid JSON"); }
    for (const [key, value] of Object.entries(parsed)) if (value !== null && typeof value !== "object") fields.set(key.toLowerCase(), String(value));
  } else {
    for (const [key, value] of new URLSearchParams(trimmed)) fields.set(key.toLowerCase(), value);
  }
  const pick = (...names: string[]) => { for (const name of names) { const value = fields.get(name.toLowerCase()); if (value != null && value !== "") return value; } return ""; };
  const providerEventId = pick("eventid", "event_id", "callsid", "call_sid", "sid");
  if (!providerEventId) throw new Error("Provider event is missing an event identifier");
  const status = pick("callstatus", "status", "dialcallstatus");
  const event = pick("eventtype", "event_type", "event");
  const digits = pick("digits", "dtmf", "dtmfdigits");
  const duration = Number(pick("callduration", "duration", "conversationduration") || 0);
  return {
    providerEventId: `${provider}:${providerEventId}:${event || status || "event"}`,
    kind: mapProviderStatus(status, event),
    callRef: pick("customfield", "custom_field", "callref", "call_ref") || null,
    providerCallId: pick("callsid", "call_sid", "sid") || null,
    providerStatus: status || event || null,
    dtmfDigits: digits ? digits.replace(/[^0-9*#]/g, "").slice(0, 32) : null,
    recordingRef: pick("recordingurl", "recording_url") || null,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
  };
}

// --- Exotel ---------------------------------------------------------------------------------------

const EXOTEL_TIMEOUT_MS = 12_000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

/**
 * Read a provider response with a hard byte cap, so a runaway body cannot exhaust the isolate. The
 * loop itself lives in provider-response-bounds so the AI adapter cannot grow a second copy of it
 * that drifts; only the telephony-specific failure type is added here.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  try {
    return await readBoundedResponseText(response, maxBytes);
  } catch (error) {
    if (error instanceof ProviderResponseTooLarge) throw new TelephonyProviderUnavailable("Telephony provider response exceeded the size limit");
    throw error;
  }
}

/**
 * Exotel Connect API adapter. Reachable only when every secret in VOICE_TELEPHONY_SECRET_NAMES is
 * present; `selectTelephonyProvider` returns the disconnected adapter otherwise, so an absent
 * credential can never degrade into a silent no-op that looks like success.
 */
export function exotelTelephony(env: Env): TelephonyProvider {
  const sid = val(env, "EXOTEL_SID"), key = val(env, "EXOTEL_API_KEY"), token = val(env, "EXOTEL_API_TOKEN");
  const callerId = val(env, "EXOTEL_CALLER_ID"), appId = val(env, "EXOTEL_VOICE_APP_ID");
  const secret = val(env, "EXOTEL_WEBHOOK_SECRET");
  const subdomain = val(env, "EXOTEL_SUBDOMAIN") || "api.exotel.com";
  // Reporting "connected" without checking is how a half-configured provider gets to look ready. The
  // selector already refuses to hand this adapter out unless every secret is present, but a direct
  // caller must not be able to reach fetch() with an incomplete configuration either.
  const missing = VOICE_TELEPHONY_SECRET_NAMES.filter(name => !val(env, name));
  if (missing.length) return disconnectedTelephony;
  // The single POST to Exotel's Connect API, shared by the one-leg dial and the two-leg bridge so the
  // timeout, byte cap, error mapping and Call.Sid extraction cannot drift between the two call shapes.
  async function placeExotelCall(body: URLSearchParams): Promise<TelephonyCallHandle> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXOTEL_TIMEOUT_MS);
    try {
      let response: Response;
      let text: string;
      try {
        response = await fetch(`https://${subdomain}/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect.json`, {
          method: "POST", signal: controller.signal,
          headers: { authorization: `Basic ${btoa(`${key}:${token}`)}`, "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        text = await readBoundedText(response, MAX_PROVIDER_RESPONSE_BYTES);
      } catch (error) {
        throw new TelephonyProviderUnavailable(controller.signal.aborted ? `Telephony provider did not respond within ${EXOTEL_TIMEOUT_MS}ms` : `Telephony provider request failed: ${String((error as Error)?.message || error).slice(0, 120)}`);
      }
      if (!response.ok) throw new TelephonyProviderUnavailable(`Telephony provider rejected the call request (${response.status})`);
      let parsed: { Call?: { Sid?: string; Status?: string } } = {};
      try { parsed = JSON.parse(text) as { Call?: { Sid?: string; Status?: string } }; } catch { throw new TelephonyProviderUnavailable("Telephony provider returned a malformed response"); }
      const providerCallId = String(parsed.Call?.Sid || "").trim();
      if (!providerCallId) throw new TelephonyProviderUnavailable("Telephony provider returned no call identifier");
      return { accepted: true, providerCallId, providerStatus: String(parsed.Call?.Status || "queued"), productionCall: true };
    } finally { clearTimeout(timer); }
  }
  // Both entry points enforce the exact-approved status callback and the environment recording approval
  // before any dial body is built, so neither a direct createCall nor a direct connectTwoNumbers can
  // redirect call progress or start recording that the environment has not approved.
  function assertCallbackAndRecording(intent: { statusCallbackUrl: string; recordingAllowed: boolean }) {
    const approved = statusCallbackUrl(env);
    if (!approved) throw new TelephonyProviderUnavailable("A https status callback URL is required before a call may be placed (PAWSPACE_VOICE_STATUS_CALLBACK_URL)");
    if (intent.statusCallbackUrl !== approved) throw new TelephonyProviderUnavailable("The status callback does not match the approved environment callback");
    if (intent.recordingAllowed && !callRecordingApproved(env)) throw new TelephonyProviderUnavailable("Call recording is not approved for this environment (PAWSPACE_VOICE_RECORDING_APPROVED)");
  }
  return {
    provider: "exotel",
    status: "connected",
    productionCapable: true,
    async createCall(intent) {
      // Defence in depth behind the environment gate: an exactly-approved https callback (or the carrier
      // accepts the dial and we never learn the outcome), and the environment recording approval checked
      // HERE, not only on the caller's word. Both live in assertCallbackAndRecording, shared with the
      // two-leg bridge so neither entry point can drift.
      assertCallbackAndRecording(intent);
      return placeExotelCall(new URLSearchParams({
        From: intent.toNumber,
        CallerId: callerId,
        Url: `http://my.exotel.com/${sid}/exoml/start_voice/${appId}`,
        CallType: "trans",
        StatusCallback: intent.statusCallbackUrl,
        CustomField: intent.callRef,
        TimeOut: String(Math.max(15, Math.min(intent.timeoutSeconds ?? 45, 120))),
        Record: intent.recordingAllowed ? "true" : "false",
      }));
    },
    async connectTwoNumbers(intent) {
      assertCallbackAndRecording(intent);
      // Two-number connect: From is dialed first, To is bridged on answer, CallerId (the ExoPhone) masks
      // BOTH legs. No ExoML Url - the second leg is the destination, not an applet.
      return placeExotelCall(new URLSearchParams({
        From: intent.firstLegNumber,
        To: intent.secondLegNumber,
        CallerId: callerId,
        CallType: "trans",
        StatusCallback: intent.statusCallbackUrl,
        CustomField: intent.callRef,
        TimeOut: String(Math.max(15, Math.min(intent.timeoutSeconds ?? 45, 120))),
        Record: intent.recordingAllowed ? "true" : "false",
      }));
    },
    async verifyWebhook({ rawBody, headers }) { return verifyVoiceWebhookSignature(secret, rawBody, headers); },
    parseEvent(rawBody) { return normaliseTelephonyEvent(rawBody, "exotel"); },
  };
}

// --- local simulator ------------------------------------------------------------------------------

export const LOCAL_SIMULATOR_PROVIDER = "local_simulator_non_production";

/**
 * NON-PRODUCTION. A deterministic in-process transport so the state machine, the policy gate, the
 * webhook receiver and every failure path can be executed as tests without a carrier. It reaches no
 * network, places no call, and reports productionCapable/productionCall = false everywhere - so no
 * result produced through it can be presented as evidence that a real call happened.
 *
 * `selectTelephonyProvider` will not return it unless PAWSPACE_VOICE_TRANSPORT names it explicitly,
 * and never when PAWSPACE_VOICE_ENV=live.
 */
export function localSimulatorTelephony(env: Env): TelephonyProvider {
  const secret = val(env, "EXOTEL_WEBHOOK_SECRET") || val(env, "PAWSPACE_VOICE_SIMULATOR_SECRET");
  return {
    provider: LOCAL_SIMULATOR_PROVIDER,
    status: "simulated",
    productionCapable: false,
    async createCall(intent) {
      if (intent.simulatedOutcome === "failed") throw new TelephonyProviderUnavailable("Simulated telephony dial failure");
      return { accepted: true, providerCallId: `SIMCALL-${intent.callRef}`, providerStatus: intent.simulatedOutcome || "queued", productionCall: false };
    },
    async connectTwoNumbers(intent) {
      if (intent.simulatedOutcome === "failed") throw new TelephonyProviderUnavailable("Simulated telephony bridge failure");
      return { accepted: true, providerCallId: `SIMBRIDGE-${intent.callRef}`, providerStatus: intent.simulatedOutcome || "queued", productionCall: false };
    },
    async verifyWebhook({ rawBody, headers }) { return verifyVoiceWebhookSignature(secret, rawBody, headers); },
    parseEvent(rawBody) { return normaliseTelephonyEvent(rawBody, LOCAL_SIMULATOR_PROVIDER); },
  };
}

// --- selection ------------------------------------------------------------------------------------

export function selectTelephonyProvider(env: Env): TelephonyProvider {
  if (val(env, "PAWSPACE_VOICE_TRANSPORT") === LOCAL_SIMULATOR_PROVIDER && voiceMode(env) !== "live") return localSimulatorTelephony(env);
  if (telephonyCredentialsConfigured(env)) return exotelTelephony(env);
  return disconnectedTelephony;
}

/** Readiness for the ops surface. Names the missing secrets; never reads or returns a value. */
export function telephonyProviderStatus(env: Env) {
  const provider = selectTelephonyProvider(env);
  return {
    provider: provider.provider,
    status: provider.status,
    productionCapable: provider.productionCapable,
    recordingApproved: callRecordingApproved(env),
    missingSecretNames: VOICE_TELEPHONY_SECRET_NAMES.filter(name => !val(env, name)),
    webhookMechanisms: ["hmac_sha256_signature", "http_basic"],
    truth: { verifiedAgainstLiveProvider: false, callsPlaced: 0 },
  };
}
