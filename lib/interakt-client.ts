/**
 * Fail-closed Interakt adapter. Interakt is the WhatsApp Business product named throughout Haptik's
 * solution document: every "share the details on WhatsApp" step in the voice-agent journeys is an
 * Interakt template send. Gated on INTERAKT_API_KEY + INTERAKT_BASE_URL: with either missing it
 * returns connected:false and sends nothing, exactly like the Razorpay / IDfy / Haptik adapters, so no
 * customer is ever messaged until Interakt is deliberately switched on.
 *
 * Interakt only sends APPROVED templates on this endpoint - there is no free-text send here. The
 * approval state itself lives in the governance layer (lib/interakt-whatsapp-governance.ts); this file
 * is transport only and holds no policy of its own.
 */

type Env = Record<string, unknown>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();
const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");

export type InteraktSend =
  | { connected: true; providerReference: string }
  | { connected: false; reason: string };

export function interaktConfigured(env: Env): boolean {
  return Boolean(val(env, "INTERAKT_API_KEY") && val(env, "INTERAKT_BASE_URL"));
}

/** Default dialling code for a bare ten-digit Indian mobile. Configurable, because the same voice
 * agent will eventually run outside +91 and a hardcoded country code silently mis-addresses people. */
export function interaktCountryCode(env: Env): string {
  const configured = val(env, "INTERAKT_COUNTRY_CODE") || "+91";
  return configured.startsWith("+") ? configured : `+${digits(configured)}`;
}

/**
 * Interakt's send endpoint, derived from the configured base. The base is operator-supplied
 * configuration that customer phone numbers and names are POSTed to, so it is validated rather than
 * trusted: https only, no embedded credentials, and a real hostname. A misconfigured base must fail
 * loudly here instead of quietly shipping PII somewhere unintended.
 */
export function interaktEndpoint(env: Env): string {
  const base = val(env, "INTERAKT_BASE_URL");
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("INTERAKT_BASE_URL is not a valid URL"); }
  if (url.protocol !== "https:") throw new Error("INTERAKT_BASE_URL must be https");
  if (url.username || url.password) throw new Error("INTERAKT_BASE_URL must not embed credentials");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) throw new Error("INTERAKT_BASE_URL must be a hostname, not an address literal");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}/v1/public/message/`;
}

/** Split a stored number into Interakt's countryCode + phoneNumber pair. */
export function interaktRecipient(env: Env, phone: string): { countryCode: string; phoneNumber: string } {
  const all = digits(phone);
  if (all.length < 10) throw new Error("A valid WhatsApp number is required");
  const code = interaktCountryCode(env), bare = digits(code);
  // A number stored with its country code already on it must not be sent with the code twice.
  const phoneNumber = all.length > 10 && all.startsWith(bare) ? all.slice(bare.length) : all.slice(-10);
  return { countryCode: code, phoneNumber };
}

export function buildInteraktTemplateRequest(input: {
  countryCode: string; phoneNumber: string; templateKey: string; language: string;
  headerValues?: string[]; bodyValues?: string[]; buttonValues?: Record<string, string[]>;
}) {
  const templateKey = String(input.templateKey || "").trim();
  if (!templateKey) throw new Error("An approved Interakt template is required");
  return {
    countryCode: input.countryCode,
    phoneNumber: input.phoneNumber,
    type: "Template",
    template: {
      name: templateKey,
      languageCode: String(input.language || "en").trim() || "en",
      headerValues: input.headerValues ?? [],
      bodyValues: input.bodyValues ?? [],
      buttonValues: input.buttonValues ?? {},
    },
  };
}

/** Send one approved template through Interakt. Fail-closed and non-throwing: every failure comes back
 * as connected:false with a reason the outbox can record and retry against. */
export async function sendInteraktTemplate(env: Env, input: {
  phone: string; templateKey: string; language?: string;
  headerValues?: string[]; bodyValues?: string[]; buttonValues?: Record<string, string[]>;
  fetcher?: Fetcher;
}): Promise<InteraktSend> {
  const apiKey = val(env, "INTERAKT_API_KEY");
  if (!interaktConfigured(env)) return { connected: false, reason: "Interakt is not connected (INTERAKT_API_KEY / INTERAKT_BASE_URL not configured)" };
  let endpoint: string, recipient: { countryCode: string; phoneNumber: string }, body: unknown;
  try {
    endpoint = interaktEndpoint(env);
    recipient = interaktRecipient(env, input.phone);
    body = buildInteraktTemplateRequest({ ...recipient, templateKey: input.templateKey, language: input.language || "en", headerValues: input.headerValues, bodyValues: input.bodyValues, buttonValues: input.buttonValues });
  } catch (error) { return { connected: false, reason: error instanceof Error ? error.message : "Interakt request could not be built" }; }
  try {
    const response = await (input.fetcher ?? fetch)(endpoint, {
      method: "POST", redirect: "error",
      headers: { authorization: `Basic ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return { connected: false, reason: `Interakt send failed (${response.status}): ${String(result.message || result.error || "request failed")}` };
    // Interakt answers {result:true,id:"..."} on accept and {result:false,message:"..."} on a
    // business-rule refusal behind a 200, so the HTTP status alone is not proof of a send.
    if (result.result === false) return { connected: false, reason: `Interakt refused the send: ${String(result.message || "no reason given")}` };
    const providerReference = String(result.id || result.messageId || "").trim();
    if (!providerReference) return { connected: false, reason: "Interakt accepted the send without returning a message id" };
    return { connected: true, providerReference };
  } catch (error) {
    return { connected: false, reason: `Interakt request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
