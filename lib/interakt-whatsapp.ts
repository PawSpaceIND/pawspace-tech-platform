/**
 * Production Interakt WhatsApp boundary.
 *
 * The low-level request builder/config helpers remain in interakt-whatsapp-core.ts. Every public send
 * here re-proves customer ownership and WhatsApp consent immediately before the network boundary, and
 * the outbox dispatcher derives message/customer/template data from the durable communication ledger.
 */
export * from "./interakt-whatsapp-core";
import { buildInteraktRequest, interaktConfig, INTERAKT_PROVIDER, type InteraktDispatchResult, type InteraktSend } from "./interakt-whatsapp-core";
import { failOutboxAttempt, recordDeliveryEvent } from "./communication-engine";

type Row = Record<string, unknown>;
type Env = Record<string, unknown>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
const text = (value: unknown) => String(value ?? "").trim();
const digits = (value: unknown) => text(value).replace(/\D/g, "");
const list = (value: unknown) => text(value).split(",").map((item) => item.trim()).filter(Boolean);
const parse = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(text(value)) as T; } catch { return fallback; } };
const clientError = (status: number, message: string) => Object.assign(new Error(message), { statusCode: status });

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

async function customerOwnsRecipient(db: D1Database, customerId: string, recipient: string) {
  const row = await db.prepare("SELECT primary_phone,secondary_phone FROM canonical_customers WHERE id=?")
    .bind(customerId).first<Row>().catch(() => null);
  if (!row) return false;
  const target = digits(recipient).slice(-10);
  return target.length === 10 && [row.primary_phone, row.secondary_phone].some((value) => digits(value).slice(-10) === target);
}

async function whatsappConsentHolds(db: D1Database, customerId: string) {
  const row = await db.prepare("SELECT whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?")
    .bind(customerId).first<Row>().catch(() => null);
  // Exact fail-closed semantics: NULL/unknown opt_out is not silently treated as zero.
  return Boolean(row && Number(row.whatsapp_consent) === 1 && row.opt_out != null && Number(row.opt_out) === 0);
}

async function templateApproved(db: D1Database, env: Env, templateKey: string, language: string) {
  const allowlist = new Set(list(env.INTERAKT_TEMPLATE_ALLOWLIST));
  if (allowlist.size && !allowlist.has(templateKey)) return false;
  const registry = await db.prepare("SELECT status,language_code FROM interakt_whatsapp_templates WHERE template_key=?")
    .bind(templateKey).first<Row>().catch(() => null);
  return Boolean(registry && text(registry.status) === "approved" && text(registry.language_code || "en") === language);
}

export async function ensureInteraktWhatsAppTables(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS interakt_whatsapp_templates (template_key TEXT PRIMARY KEY,status TEXT NOT NULL,language_code TEXT NOT NULL DEFAULT 'en',provider_template_name TEXT,verified_at INTEGER NOT NULL,verified_by TEXT NOT NULL)").run();
}

export async function setInteraktTemplateVerification(db: D1Database, input: { templateKey: string; status: "approved" | "pending" | "rejected" | "disabled"; language?: string; providerTemplateName?: string; actorId: string; asOf?: number }) {
  await ensureInteraktWhatsAppTables(db);
  const key = text(input.templateKey), actor = text(input.actorId), language = text(input.language) || "en";
  if (!key || !actor) throw clientError(400, "Template key and verifier are required");
  await db.prepare("INSERT INTO interakt_whatsapp_templates (template_key,status,language_code,provider_template_name,verified_at,verified_by) VALUES (?,?,?,?,?,?) ON CONFLICT(template_key) DO UPDATE SET status=excluded.status,language_code=excluded.language_code,provider_template_name=excluded.provider_template_name,verified_at=excluded.verified_at,verified_by=excluded.verified_by")
    .bind(key, input.status, language, text(input.providerTemplateName) || null, input.asOf ?? Date.now(), actor).run();
  return { templateKey: key, status: input.status, language };
}

export async function dispatchInteraktMessage(
  db: D1Database,
  env: Env,
  input: { messageId: string; customerId: string; recipient: string; send: InteraktSend },
  fetcher: Fetcher = fetch,
): Promise<InteraktDispatchResult> {
  await ensureInteraktWhatsAppTables(db);
  const messageId = text(input.messageId), customerId = text(input.customerId);
  if (!messageId || !customerId) throw clientError(400, "Message id and customer are required");
  const config = interaktConfig(env);
  if (!config) {
    await failOutboxAttempt(db, messageId, "interakt_not_configured").catch(() => {});
    return { provider: INTERAKT_PROVIDER, messageId, status: "refused", providerMessageId: null, reason: "interakt_not_configured" };
  }
  const queuedMessage = await db.prepare("SELECT customer_id FROM communication_messages WHERE id=?")
    .bind(messageId).first<Row>().catch(() => null);
  if (!queuedMessage || text(queuedMessage.customer_id) !== customerId) {
    await failOutboxAttempt(db, messageId, "message_customer_mismatch").catch(() => {});
    throw clientError(403, "Queued WhatsApp message does not belong to this canonical customer");
  }
  if (!(await customerOwnsRecipient(db, customerId, input.recipient))) {
    await failOutboxAttempt(db, messageId, "recipient_not_owned_by_customer").catch(() => {});
    throw clientError(403, "That WhatsApp number does not belong to this canonical customer");
  }
  if (!(await whatsappConsentHolds(db, customerId))) {
    await failOutboxAttempt(db, messageId, "whatsapp_consent_missing_or_opted_out").catch(() => {});
    throw clientError(409, "WhatsApp requires whatsapp_consent=1 and opt_out=0");
  }
  if (!input.send.withinSession) {
    const templateKey = text(input.send.templateKey), language = text(input.send.language) || "en";
    if (!templateKey || !(await templateApproved(db, env, templateKey, language))) {
      await failOutboxAttempt(db, messageId, "interakt_template_not_verified").catch(() => {});
      throw clientError(409, "Interakt template is not verified as approved");
    }
  }
  const body = buildInteraktRequest({ recipient: input.recipient, config, send: input.send });
  let response: Response;
  try {
    response = await fetcher(`${config.baseUrl}/v1/public/message/`, { method: "POST", redirect: "error", headers: { authorization: `Basic ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    await failOutboxAttempt(db, messageId, "interakt_transport_failure").catch(() => {});
    throw clientError(502, `WhatsApp provider is unreachable: ${error instanceof Error ? error.message : "unknown"}`);
  }
  const payload = await response.json().catch(() => ({} as Row)) as Row;
  if (!response.ok || payload.result === false) {
    const reason = text(payload.message) || `interakt_http_${response.status}`;
    const outbox = await db.prepare("SELECT attempt_count FROM communication_outbox WHERE message_id=?")
      .bind(messageId).first<Row>().catch(() => null);
    const attempt = Number(outbox?.attempt_count || 0) + 1;
    await recordDeliveryEvent(db, { messageId, provider: INTERAKT_PROVIDER, eventId: `${messageId}:failed:${attempt}`, eventType: "failed", detail: { status: response.status, reason } }).catch(() => {});
    return { provider: INTERAKT_PROVIDER, messageId, status: "refused", providerMessageId: null, reason };
  }
  const providerMessageId = text(payload.id || payload.messageId) || null;
  await recordDeliveryEvent(db, { messageId, provider: INTERAKT_PROVIDER, eventId: `${messageId}:accepted`, eventType: "accepted", detail: { providerMessageId, type: body.type } });
  return { provider: INTERAKT_PROVIDER, messageId, status: "sent", providerMessageId };
}

export async function dispatchInteraktOutboxMessage(db: D1Database, env: Env, input: { messageId: string; recipient: string; fetcher?: Fetcher }) {
  const message = await db.prepare("SELECT m.*,o.status outbox_status,o.next_attempt_at FROM communication_messages m JOIN communication_outbox o ON o.message_id=m.id WHERE m.id=?")
    .bind(text(input.messageId)).first<Row>();
  if (!message || text(message.channel) !== "whatsapp") throw clientError(404, "Queued WhatsApp communication message not found");
  if (!["queued", "retry_pending", "scheduled"].includes(text(message.outbox_status))) return { status: "already_dispatched", outboxStatus: text(message.outbox_status), externalDelivery: false };
  if (Number(message.next_attempt_at) > Date.now()) return { status: "scheduled", nextAttemptAt: Number(message.next_attempt_at), externalDelivery: false };
  const payload = parse<Record<string, unknown>>(message.payload_json, {});
  const language = text(payload.language) || "en";
  const now = Date.now();
  const locked = await db.prepare("UPDATE communication_outbox SET status='dispatching',locked_at=?,updated_at=? WHERE message_id=? AND status IN ('queued','retry_pending','scheduled')")
    .bind(now, now, text(input.messageId)).run();
  if (Number(locked.meta?.changes || 0) !== 1) return { status: "dispatch_race_lost", provider: INTERAKT_PROVIDER, externalDelivery: false };
  try {
    const result = await dispatchInteraktMessage(db, env, {
      messageId: text(input.messageId), customerId: text(message.customer_id), recipient: input.recipient,
      send: { withinSession: false, templateKey: text(message.template_key), language, bodyValues: Array.isArray(payload.bodyValues) ? payload.bodyValues.map(text) : [] },
    }, input.fetcher ?? fetch);
    return { status: result.status === "sent" ? "provider_accepted" : result.reason || "refused", provider: INTERAKT_PROVIDER, providerReference: result.providerMessageId, externalDelivery: result.status === "sent" };
  } catch (error) {
    // dispatchInteraktMessage has already recorded the fail-closed outbox reason.
    throw error;
  }
}

/** Verify Interakt's documented HMAC-SHA256 signature over the exact raw request body. */
async function hmacSha256Hex(secret: string, rawBody: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validateInteraktWebhookSignature(env: Env, rawBody: string, headers: Headers) {
  const secret = text(env.INTERAKT_WEBHOOK_SECRET);
  if (!secret) return { verified: false, reason: "interakt_webhook_not_configured" };
  const received = text(headers.get("interakt-signature")).toLowerCase();
  if (!/^sha256=[0-9a-f]{64}$/.test(received)) return { verified: false, reason: "interakt_webhook_signature_missing_or_invalid" };
  const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
  const verified = safeEqual(received, expected);
  return { verified, reason: verified ? null : "interakt_webhook_signature_invalid", mechanism: "hmac-sha256" };
}

export const validateInteraktWebhookRequest = validateInteraktWebhookSignature;
