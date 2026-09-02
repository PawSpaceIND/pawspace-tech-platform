/**
 * Interakt as a WhatsApp delivery provider, alongside Meta direct.
 *
 * The Haptik LOE needs a WhatsApp send in 8 of its 12 outbound use cases - package link, subscription
 * link, renewal link, website link - and the repo had no Interakt path at all, so those eight
 * dead-ended. This adds the provider; it does not add a second messaging stack.
 *
 * DELIBERATELY A SIBLING OF lib/meta-whatsapp-uat-dispatch.ts, NOT A PARALLEL STACK. The dangerous part
 * of a WhatsApp send is not the HTTP call, it is answering "may we message this number at all?" - and
 * that question is already answered correctly for Meta. This file reuses the same three guards in the
 * same order, and closes the loop through the same communication_outbox, so a message sent via Interakt
 * is auditable exactly like one sent via Meta:
 *
 *   1. provider configured        -> fail CLOSED when the key or base URL is unset (nothing is sent,
 *                                   and the caller is told the provider is not configured rather than
 *                                   getting a silent no-op that looks like success)
 *   2. recipient belongs to the customer -> the phone must match canonical_customers for the named
 *                                   customer_id. This is the guard that matters most: without it a
 *                                   caller-supplied phone plus a real customer_id would send that
 *                                   customer's booking or payment link to an attacker's handset.
 *   3. consent holds              -> whatsapp_consent=1 AND opt_out!=1, read per send, never cached
 *
 * Outside WhatsApp's 24-hour customer-service window Meta permits only an approved template, so a
 * free-text send is refused rather than silently converted - a converted send would be rejected by the
 * provider anyway, and the refusal is what tells the operator their template is missing.
 *
 * The HTTP client is injected so the whole path is testable without a network, and so a test can assert
 * on the exact request body we would put on the wire.
 */

import { recordDeliveryEvent, failOutboxAttempt } from "./communication-engine";

/**
 * Annotate a refusal with the status it should be answered with.
 *
 * This uses the `statusCode` convention the repo already carries in backend/src (scheduling.ts marks
 * its rejections statusCode:422 and backend/src/app.ts honours it). It is declared locally rather than
 * imported so this file has no dependency on an unmerged branch; when lib/http-errors.ts lands, these
 * calls can be swapped for its helpers with no behaviour change.
 *
 * It matters here because the surrounding libs throw a bare `new Error`, which the Worker's authError()
 * turns into a 500 - so a consent refusal or a wrong-number refusal would reach the operator as an
 * outage rather than as the thing they need to fix.
 */
const clientError = (status: number, message: string) => Object.assign(new Error(message), { statusCode: status });

type Row = Record<string, unknown>;
type Env = Record<string, unknown>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const text = (value: unknown) => String(value ?? "").trim();
const digits = (value: unknown) => text(value).replace(/\D/g, "");

/** Interakt's public send endpoint. Overridable per environment so UAT never points at production. */
const DEFAULT_BASE_URL = "https://api.interakt.ai";
const SEND_PATH = "v1/public/message/";

export const INTERAKT_PROVIDER = "interakt" as const;

export type InteraktConfig = { apiKey: string; baseUrl: string; countryCode: string };

/**
 * Read the provider config, or return null when it is not configured.
 *
 * Returning null rather than throwing lets a caller answer 503 "provider not configured" - the same
 * fail-closed shape /api/haptik uses - instead of surfacing an outage for a deliberate off state.
 */
export function interaktConfig(env: Env): InteraktConfig | null {
  const apiKey = text(env.INTERAKT_API_KEY);
  if (!apiKey) return null;
  const baseUrl = text(env.INTERAKT_BASE_URL) || DEFAULT_BASE_URL;
  if (!/^https:\/\//.test(baseUrl)) throw new Error("INTERAKT_BASE_URL must be an https URL");
  const countryCode = text(env.INTERAKT_COUNTRY_CODE) || "+91";
  if (!/^\+\d{1,4}$/.test(countryCode)) throw new Error("INTERAKT_COUNTRY_CODE must look like +91");
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), countryCode };
}

export const interaktEnabled = (env: Env) => interaktConfig(env) !== null;

/**
 * Split a stored Indian number into Interakt's {countryCode, phoneNumber} pair.
 *
 * Numbers are seeded and captured in several shapes (10-digit, 91-prefixed, +91-prefixed), and sending
 * a country code twice silently reaches nobody, so normalisation happens once, here.
 */
export function splitPhone(recipient: unknown, countryCode: string) {
  const all = digits(recipient);
  const cc = digits(countryCode);
  // Strip the country code ONLY when what remains is still a full national number. A bare Indian
  // mobile is 10 digits and may itself begin "91" (mobiles start 6-9), so a naive startsWith(cc) test
  // silently eats the first two digits of 9100000000 and sends to an 8-digit number that reaches
  // nobody. Length-checking first is what distinguishes a prefix from a coincidence.
  const local = all.length >= cc.length + 10 && all.startsWith(cc) ? all.slice(cc.length) : all;
  if (local.length !== 10) throw clientError(400, "A full 10-digit WhatsApp number is required");
  return { countryCode: `+${cc}`, phoneNumber: local };
}

export type InteraktSend =
  | { withinSession: true; messageText: string }
  | { withinSession: false; templateKey: string; language?: string; bodyValues?: string[] };

/**
 * The exact JSON we would put on the wire. Pure, so a test can assert the body without a network and
 * without reaching the guards - the guards are asserted separately, against the dispatcher.
 */
export function buildInteraktRequest(input: { recipient: string; config: InteraktConfig; send: InteraktSend }) {
  const { countryCode, phoneNumber } = splitPhone(input.recipient, input.config.countryCode);
  if (input.send.withinSession) {
    const message = text(input.send.messageText);
    if (!message) throw clientError(400, "Session reply text is required");
    return { countryCode, phoneNumber, type: "Text", data: { message } };
  }
  const name = text(input.send.templateKey);
  // Outside the 24h window Meta accepts only an approved template. Refusing here beats a provider-side
  // rejection, because this message names the missing thing.
  if (!name) throw clientError(409, "An approved WhatsApp template is required outside the 24-hour customer-service window");
  return {
    countryCode, phoneNumber, type: "Template",
    template: { name, languageCode: text(input.send.language) || "en", bodyValues: (input.send.bodyValues ?? []).map(text) },
  };
}

/** Does this phone actually belong to this customer? The anti-misdelivery guard. */
async function recipientBelongsToCustomer(db: D1Database, customerId: string, recipient: string) {
  const row = await db.prepare("SELECT primary_phone,secondary_phone FROM canonical_customers WHERE id=?")
    .bind(customerId).first<Row>().catch(() => null);
  if (!row) return false;
  const target = digits(recipient);
  // Compare on the last 10 digits so a stored +91 and a supplied 10-digit number are the same handset.
  const tail = (value: unknown) => digits(value).slice(-10);
  return tail(target).length === 10 && [row.primary_phone, row.secondary_phone].some((value) => tail(value) === tail(target));
}

/** Consent read per send, never cached: an opt-out must take effect on the very next message. */
async function whatsappConsentHolds(db: D1Database, customerId: string) {
  const row = await db.prepare("SELECT whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?")
    .bind(customerId).first<Row>().catch(() => null);
  return Boolean(row && Number(row.whatsapp_consent) === 1 && Number(row.opt_out || 0) !== 1);
}

export type InteraktDispatchResult = {
  provider: typeof INTERAKT_PROVIDER;
  messageId: string;
  status: "sent" | "refused";
  providerMessageId: string | null;
  reason?: string;
};

/**
 * Send one WhatsApp message through Interakt, with every guard applied and the outbox updated.
 *
 * Guard order is deliberate and matches Meta's: configuration, then ownership, then consent. Ownership
 * before consent means a caller probing with someone else's customer_id cannot learn that customer's
 * consent state from the error they get back.
 */
export async function dispatchInteraktMessage(
  db: D1Database,
  env: Env,
  input: { messageId: string; customerId: string; recipient: string; send: InteraktSend },
  fetcher: Fetcher = fetch,
): Promise<InteraktDispatchResult> {
  const messageId = text(input.messageId);
  if (!messageId) throw clientError(400, "A message id is required so the send can be reconciled");
  const customerId = text(input.customerId);
  if (!customerId) throw clientError(400, "A customer is required");

  const config = interaktConfig(env);
  if (!config) {
    // Deliberately off, not broken. Nothing is sent and nothing is marked sent.
    await failOutboxAttempt(db, messageId, "interakt_not_configured").catch(() => {});
    return { provider: INTERAKT_PROVIDER, messageId, status: "refused", providerMessageId: null, reason: "interakt_not_configured" };
  }

  if (!(await recipientBelongsToCustomer(db, customerId, input.recipient))) {
    await failOutboxAttempt(db, messageId, "recipient_not_owned_by_customer").catch(() => {});
    throw clientError(403, "That WhatsApp number does not belong to this customer");
  }
  if (!(await whatsappConsentHolds(db, customerId))) {
    await failOutboxAttempt(db, messageId, "whatsapp_consent_missing").catch(() => {});
    throw clientError(409, "This customer has not consented to WhatsApp, or has opted out");
  }

  const body = buildInteraktRequest({ recipient: input.recipient, config, send: input.send });

  let response: Response;
  try {
    response = await fetcher(`${config.baseUrl}/${SEND_PATH}`, {
      method: "POST",
      headers: { authorization: `Basic ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // A transport failure is retryable, so the outbox keeps the message rather than losing it.
    await failOutboxAttempt(db, messageId, `interakt_transport: ${error instanceof Error ? error.message : "unknown"}`).catch(() => {});
    throw clientError(502, "WhatsApp provider is unreachable");
  }

  const payload = await response.json().catch(() => ({}) as Row);
  if (!response.ok || (payload as Row).result === false) {
    const reason = text((payload as Row).message) || `interakt_http_${response.status}`;
    await failOutboxAttempt(db, messageId, reason).catch(() => {});
    await recordDeliveryEvent(db, {
      messageId, provider: INTERAKT_PROVIDER, eventId: `${messageId}:failed`,
      eventType: "failed", detail: { status: response.status, reason },
    }).catch(() => {});
    return { provider: INTERAKT_PROVIDER, messageId, status: "refused", providerMessageId: null, reason };
  }

  const providerMessageId = text((payload as Row).id) || null;
  // eventId is derived from messageId, so a retried send records the same event once rather than
  // inflating the delivery history.
  await recordDeliveryEvent(db, {
    messageId, provider: INTERAKT_PROVIDER, eventId: `${messageId}:accepted`,
    eventType: "accepted", detail: { providerMessageId, type: body.type },
  });
  return { provider: INTERAKT_PROVIDER, messageId, status: "sent", providerMessageId };
}
