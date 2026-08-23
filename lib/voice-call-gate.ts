/**
 * Controlled unlock for voice calling. Voice is OFF unless the deployment environment says otherwise,
 * and every unlock step is fail-closed. This mirrors lib/payment-webhook-gate.ts deliberately: the
 * same shape already governs whether real money may move, and voice is the other capability that can
 * reach a real person without anyone watching.
 *
 * Resolution:
 *   PAWSPACE_VOICE_ENV unset / anything but uat|live  -> DISABLED. Nothing dials. This is the default,
 *     so a fresh deployment, a preview, and CI all have voice off without anyone configuring anything.
 *   PAWSPACE_VOICE_ENV=uat   -> needs PAWSPACE_VOICE_UAT_APPROVED="true", the telephony credentials,
 *     a caller ID, a webhook secret, AND a non-empty PAWSPACE_VOICE_UAT_ALLOWLIST. In UAT we only ever
 *     dial numbers a human explicitly put on that list.
 *   PAWSPACE_VOICE_ENV=live  -> additionally needs PAWSPACE_VOICE_LIVE_APPROVED="true". Not exercised;
 *     no live voice traffic has been authorised.
 *
 * ONLY the worker environment is consulted. There is no request header, query parameter, cookie or
 * request-body field anywhere in this module - a browser cannot turn voice on, in any environment.
 *
 * Secrets are referenced by NAME only. Nothing here returns, logs or echoes a credential value.
 */

type Env = Record<string, unknown>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();
const isTrue = (env: Env, key: string) => val(env, key).toLowerCase() === "true";

export type VoiceMode = "disabled" | "uat" | "live";

/** Telephony credentials, by name. Presence is necessary and nowhere near sufficient. */
export const VOICE_TELEPHONY_SECRET_NAMES = ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_CALLER_ID", "EXOTEL_VOICE_APP_ID", "EXOTEL_WEBHOOK_SECRET"] as const;

export type VoiceCallGate =
  | { ok: true; mode: "uat" | "live"; allowlist: string[]; recordingApproved: boolean; salesOutboundApproved: boolean }
  | { ok: false; status: number; reason: string; mode: VoiceMode };

export function voiceMode(env: Env): VoiceMode {
  const raw = val(env, "PAWSPACE_VOICE_ENV").toLowerCase();
  return raw === "live" ? "live" : raw === "uat" ? "uat" : "disabled";
}

/**
 * The numbers a UAT deployment is allowed to dial. Comparison is on the last 10 digits so a list
 * written as +91 98765 43210 matches a stored 09876543210 - and an empty or unparseable list means
 * an empty allow-list, never "allow everything".
 */
export function voiceAllowlist(env: Env): string[] {
  // Split on comma/semicolon/newline only. Whitespace is NOT a separator: a real Indian number is
  // routinely written "+91 98765 43210", and splitting on spaces turned one entry into three fragments
  // too short to survive the length filter - an allow-list that silently parsed to empty.
  return val(env, "PAWSPACE_VOICE_UAT_ALLOWLIST")
    .split(/[,;\n]+/)
    .map(entry => entry.replace(/[^0-9]/g, ""))
    .filter(entry => entry.length >= 8)
    .map(entry => entry.slice(-10));
}

/**
 * The one number the provider is actually given, in E.164.
 *
 * The policy gate, the allow-list and the audit key all use the last 10 digits, but the dial used to
 * forward whatever the caller typed - so "+91 98765 43210" and "09876543210" were checked as the same
 * recipient and then dialled as two different strings, and a retry (which reads the stored 10-digit key)
 * dialled a third. Exotel's documented format is E.164, so that is what gets stored and sent, once.
 *
 * Returns null when the input cannot be canonicalised, so the caller refuses rather than guessing.
 */
export function canonicalDialNumber(env: Env, phone: unknown): string | null {
  const raw = String(phone ?? "").replace(/[\s()\-.]/g, "").trim();
  if (!raw) return null;
  const cc = (val(env, "PAWSPACE_VOICE_DIAL_COUNTRY_CODE") || "91").replace(/[^0-9]/g, "") || "91";
  if (raw.startsWith("+")) {
    const digits = raw.slice(1).replace(/[^0-9]/g, "");
    return digits.length >= 8 && digits.length <= 15 && digits === raw.slice(1) ? `+${digits}` : null;
  }
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits !== raw) return null;
  if (digits.length === 10) return `+${cc}${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+${cc}${digits.slice(1)}`;
  if (digits.length > 10 && digits.length <= 15 && digits.startsWith(cc)) return `+${digits}`;
  return null;
}

export function normalisedDialKey(phone: unknown): string {
  const digits = String(phone ?? "").replace(/[^0-9]/g, "");
  return digits.length >= 8 ? digits.slice(-10) : "";
}

export function isVoiceAllowlisted(env: Env, phone: unknown): boolean {
  const key = normalisedDialKey(phone);
  return Boolean(key) && voiceAllowlist(env).includes(key);
}

/** Outbound sales/pitch calling is a separate, explicit business approval. Default: not approved. */
export function salesOutboundApproved(env: Env): boolean {
  return isTrue(env, "PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED");
}

/** Call recording is a separate consent/compliance decision. Default: not approved. */
export function callRecordingApproved(env: Env): boolean {
  return isTrue(env, "PAWSPACE_VOICE_RECORDING_APPROVED");
}

export function telephonyCredentialsConfigured(env: Env): boolean {
  return VOICE_TELEPHONY_SECRET_NAMES.every(name => Boolean(val(env, name)));
}

/**
 * The https URL the provider posts call progress to. Part of the gate, not an optional extra: without
 * it a provider accepts the dial and we never learn the outcome, so an answered-and-ended call sits in
 * `dialing` forever. An http URL is refused too - call state would cross the network in the clear.
 */
export function statusCallbackUrl(env: Env): string | null {
  const raw = val(env, "PAWSPACE_VOICE_STATUS_CALLBACK_URL");
  if (!raw) return null;
  try { return new URL(raw).protocol === "https:" ? raw : null; }
  catch { return null; }
}

export function resolveVoiceCallGate(env: Env): VoiceCallGate {
  const mode = voiceMode(env);
  if (mode === "disabled") return { ok: false, status: 503, reason: "Voice calling is disabled (set PAWSPACE_VOICE_ENV=\"uat\" in an approved UAT environment)", mode };
  if (!isTrue(env, "PAWSPACE_VOICE_UAT_APPROVED")) return { ok: false, status: 503, reason: "Voice calling is not approved for this environment (set PAWSPACE_VOICE_UAT_APPROVED=\"true\")", mode };
  if (mode === "live" && !isTrue(env, "PAWSPACE_VOICE_LIVE_APPROVED")) return { ok: false, status: 503, reason: "Live voice calling is not approved (set PAWSPACE_VOICE_LIVE_APPROVED=\"true\"). Complete controlled UAT first.", mode };
  const missing = VOICE_TELEPHONY_SECRET_NAMES.filter(name => !val(env, name));
  if (missing.length) return { ok: false, status: 503, reason: `Telephony provider is not configured (missing ${missing.join(", ")})`, mode };
  if (!statusCallbackUrl(env)) return { ok: false, status: 503, reason: "A https provider status callback is not configured (PAWSPACE_VOICE_STATUS_CALLBACK_URL)", mode };
  const allowlist = voiceAllowlist(env);
  // A UAT run with no allow-list is the exact accident this gate exists to prevent: an approved
  // environment with real credentials and no bound on who it may dial.
  if (mode === "uat" && !allowlist.length) return { ok: false, status: 503, reason: "UAT voice calling requires an explicit recipient allow-list (PAWSPACE_VOICE_UAT_ALLOWLIST)", mode };
  return { ok: true, mode, allowlist, recordingApproved: callRecordingApproved(env), salesOutboundApproved: salesOutboundApproved(env) };
}

/**
 * What an operator needs to see on the readiness surface. Reports which NAMED secrets are present and
 * which are not; never a value, never the allow-list contents (those are real customer numbers).
 */
export function voiceCallReadiness(env: Env) {
  const mode = voiceMode(env), gate = resolveVoiceCallGate(env);
  return {
    mode,
    enabled: gate.ok,
    blockedReason: gate.ok ? null : gate.reason,
    uatApproved: isTrue(env, "PAWSPACE_VOICE_UAT_APPROVED"),
    liveApproved: isTrue(env, "PAWSPACE_VOICE_LIVE_APPROVED"),
    telephonyCredentialsConfigured: telephonyCredentialsConfigured(env),
    statusCallbackConfigured: Boolean(statusCallbackUrl(env)),
    missingSecretNames: VOICE_TELEPHONY_SECRET_NAMES.filter(name => !val(env, name)),
    allowlistSize: voiceAllowlist(env).length,
    recordingApproved: callRecordingApproved(env),
    salesOutboundApproved: salesOutboundApproved(env),
    // Stated on the surface itself so a green readiness panel is never mistaken for a completed call.
    truth: { productionCallsExecuted: false, clientCannotEnableVoice: true, credentialPresenceIsNotProofOfACall: true },
  };
}
