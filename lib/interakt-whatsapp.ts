import { resolveCanonicalRecipientOwnership } from "./canonical-recipient-ownership";
import { ensureCommunicationTables, failOutboxAttempt, recordDeliveryEvent } from "./communication-engine";
import { ensureWhatsAppTemplateLifecycle } from "./whatsapp-template-lifecycle";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type DeliveryEvent = "sent" | "delivered" | "read" | "failed";

const INTERAKT_MESSAGE_URL = "https://api.interakt.ai/v1/public/message/";
const text = (value: unknown) => String(value ?? "").trim();
const safeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
};
const hmacHex = async (raw: string, secret: string) => Array.from(new Uint8Array(await crypto.subtle.sign(
  "HMAC",
  await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  new TextEncoder().encode(raw),
))).map((byte) => byte.toString(16).padStart(2, "0")).join("");

function productionEnabled(env: Env) {
  return text(env.PAWSPACE_DEPLOYMENT_ENV).toLowerCase() === "production"
    && text(env.PAWSPACE_COMMUNICATION_ENV).toLowerCase() === "live";
}

async function whatsappConsent(db: Db, customerId: string) {
  const row = await db.prepare("SELECT whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>().catch(() => null);
  return Boolean(row) && Number(row!.whatsapp_consent) === 1 && Number(row!.opt_out || 0) === 0;
}

async function approvedTemplate(db: Db, templateKey: string) {
  await ensureWhatsAppTemplateLifecycle(db);
  const row = await db.prepare("SELECT template_key,status,approved_language FROM whatsapp_uat_templates WHERE template_key=?").bind(templateKey).first<Row>();
  if (!row || text(row.status) !== "approved") return null;
  const language = text(row.approved_language);
  if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(language)) return null;
  return { key: text(row.template_key), language };
}

function bodyValues(payload: Row) {
  const candidate = Array.isArray(payload.bodyValues) ? payload.bodyValues : Array.isArray(payload.values) ? payload.values : [];
  if (candidate.length > 10) throw new Error("Interakt WhatsApp template bodyValues may contain at most 10 values");
  return candidate.map((value) => {
    const rendered = text(value);
    if (!rendered || rendered.length > 1024) throw new Error("Interakt WhatsApp template values must be non-empty and at most 1024 characters");
    return rendered;
  });
}

function countryAndPhone(dialNumber: string) {
  const digits = dialNumber.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return { countryCode: "+91", phoneNumber: digits.slice(2) };
  throw new Error("Interakt production adapter currently accepts canonical Indian (+91) recipients only");
}

export async function dispatchInteraktWhatsApp(db: Db, env: Env, input: { messageId: string; recipient?: string | null; timeoutMs?: number; fetcher?: Fetcher }) {
  await ensureCommunicationTables(db);
  const message = await db.prepare("SELECT m.*,o.status outbox_status,o.next_attempt_at FROM communication_messages m JOIN communication_outbox o ON o.message_id=m.id WHERE m.id=?").bind(input.messageId).first<Row>();
  if (!message) throw new Error("Queued communication message not found");
  if (text(message.channel) !== "whatsapp") return { status: "wrong_channel", provider: "interakt", externalDelivery: false, productionDelivery: false };
  if (!["queued", "retry_pending", "scheduled"].includes(text(message.outbox_status))) return { status: "already_dispatched", outboxStatus: text(message.outbox_status), provider: "interakt", externalDelivery: false, productionDelivery: false };
  if (Number(message.next_attempt_at) > Date.now()) return { status: "scheduled", nextAttemptAt: Number(message.next_attempt_at), provider: "interakt", externalDelivery: false, productionDelivery: false };

  const apiKey = text(env.INTERAKT_API_KEY);
  if (!productionEnabled(env) || !apiKey) return { status: "not_configured", provider: "interakt", externalDelivery: false, productionDelivery: false };

  const owner = await resolveCanonicalRecipientOwnership(db, env, {
    phone: text(input.recipient) || null,
    customerId: text(message.customer_id),
    leadId: text(message.lead_id) || null,
    bookingId: text(message.booking_id) || null,
    requireSuppliedPhone: Boolean(text(input.recipient)),
  });
  if (!await whatsappConsent(db, owner.customerId)) return { status: "consent_refused", provider: "interakt", externalDelivery: false, productionDelivery: false };

  const template = await approvedTemplate(db, text(message.template_key));
  if (!template) return { status: "template_not_approved", provider: "interakt", externalDelivery: false, productionDelivery: false };
  let payload: Row = {};
  try { payload = JSON.parse(text(message.payload_json) || "{}") as Row; } catch { return { status: "invalid_template_payload", provider: "interakt", externalDelivery: false, productionDelivery: false }; }
  const values = bodyValues(payload);
  const recipient = countryAndPhone(owner.dialNumber);

  const now = Date.now();
  const claim = await db.prepare("UPDATE communication_outbox SET status='dispatching',locked_at=?,updated_at=? WHERE message_id=? AND status IN ('queued','retry_pending','scheduled') AND next_attempt_at<=?").bind(now, now, input.messageId, now).run();
  if (!Number(claim.meta.changes)) return { status: "dispatch_claim_lost", provider: "interakt", externalDelivery: false, productionDelivery: false };

  if (!await whatsappConsent(db, owner.customerId)) {
    await db.batch([
      db.prepare("UPDATE communication_outbox SET status='suppressed',locked_at=NULL,last_error='whatsapp_consent_revoked',updated_at=? WHERE message_id=?").bind(Date.now(), input.messageId),
      db.prepare("UPDATE communication_messages SET status='suppressed',updated_at=? WHERE id=?").bind(Date.now(), input.messageId),
    ]);
    return { status: "consent_refused", provider: "interakt", externalDelivery: false, productionDelivery: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(Number(input.timeoutMs || 10_000), 30_000)));
  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(INTERAKT_MESSAGE_URL, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Basic ${apiKey}`,
        "content-type": "application/json",
        "x-pawspace-idempotency-key": text(message.idempotency_key),
      },
      body: JSON.stringify({
        ...recipient,
        callbackData: `pawspace:${input.messageId}`,
        type: "Template",
        template: { name: template.key, languageCode: template.language, bodyValues: values },
      }),
    });
  } catch (error) {
    clearTimeout(timer);
    const reason = error instanceof Error && error.name === "AbortError" ? "interakt_timeout" : "interakt_network_failure";
    return { ...(await failOutboxAttempt(db, input.messageId, reason)), provider: "interakt", reason, externalDelivery: false, productionDelivery: false };
  }
  clearTimeout(timer);
  const raw = await response.text().catch(() => "");
  let providerPayload: Row = {};
  try { providerPayload = raw ? JSON.parse(raw) as Row : {}; } catch { providerPayload = {}; }
  if (!response.ok || providerPayload.result === false) {
    const reason = `interakt_http_${response.status}`;
    return { ...(await failOutboxAttempt(db, input.messageId, reason)), provider: "interakt", httpStatus: response.status, reason, externalDelivery: false, productionDelivery: false };
  }
  const providerReference = text(providerPayload.id);
  if (!providerReference) return { ...(await failOutboxAttempt(db, input.messageId, "interakt_reference_missing")), provider: "interakt", reason: "interakt_reference_missing", externalDelivery: false, productionDelivery: false };

  await db.prepare("UPDATE communication_messages SET provider='interakt',provider_reference=?,updated_at=? WHERE id=?").bind(providerReference, Date.now(), input.messageId).run();
  await recordDeliveryEvent(db, { messageId: input.messageId, provider: "interakt", eventId: `accepted:${providerReference}`, eventType: "accepted", detail: { httpStatus: response.status, providerReference, productionDelivery: true } });
  return { status: "provider_accepted", provider: "interakt", providerReference, httpStatus: response.status, externalDelivery: true, productionDelivery: true };
}

const INTERAKT_DELIVERY_TYPES: Record<string, DeliveryEvent> = {
  message_api_sent: "sent",
  message_api_delivered: "delivered",
  message_api_read: "read",
  message_api_failed: "failed",
};

export async function recordInteraktWebhook(db: Db, env: Env, input: { rawBody: string; headers: Headers }) {
  await ensureCommunicationTables(db);
  const secret = text(env.INTERAKT_WEBHOOK_SECRET);
  if (!secret) return { accepted: false, status: 503, reason: "interakt_webhook_not_configured", externalDelivery: false };
  const supplied = text(input.headers.get("interakt-signature")).toLowerCase();
  const expected = `sha256=${await hmacHex(input.rawBody, secret)}`;
  if (!supplied || !safeEqual(supplied, expected)) return { accepted: false, status: 401, reason: "invalid_interakt_signature", externalDelivery: false };

  let body: Row;
  try { body = JSON.parse(input.rawBody) as Row; } catch { return { accepted: false, status: 400, reason: "invalid_json", externalDelivery: false }; }
  const eventType = INTERAKT_DELIVERY_TYPES[text(body.type)];
  if (!eventType) return { accepted: true, status: 200, matched: false, reason: "non_delivery_event", externalDelivery: true };

  const data = body.data && typeof body.data === "object" ? body.data as Row : {};
  const messagePayload = data.message && typeof data.message === "object" ? data.message as Row : {};
  const customerPayload = data.customer && typeof data.customer === "object" ? data.customer as Row : {};
  const providerReference = text(messagePayload.id);
  if (!providerReference) return { accepted: true, status: 200, matched: false, reason: "missing_provider_reference", externalDelivery: true };

  const message = await db.prepare("SELECT id,customer_id,lead_id,booking_id FROM communication_messages WHERE provider='interakt' AND provider_reference=?").bind(providerReference).first<Row>();
  if (!message) return { accepted: true, status: 200, matched: false, reason: "unknown_provider_reference", externalDelivery: true };

  const callbackPhone = text(customerPayload.channel_phone_number);
  if (callbackPhone) {
    try {
      await resolveCanonicalRecipientOwnership(db, env, {
        phone: callbackPhone,
        customerId: text(message.customer_id),
        leadId: text(message.lead_id) || null,
        bookingId: text(message.booking_id) || null,
        requireSuppliedPhone: true,
      });
    } catch {
      return { accepted: true, status: 200, matched: true, applied: false, reason: "recipient_customer_mismatch", externalDelivery: true };
    }
  }

  const eventId = `${text(body.type)}:${providerReference}:${text(body.timestamp) || "provider"}`;
  const result = await recordDeliveryEvent(db, {
    messageId: text(message.id),
    provider: "interakt",
    eventId,
    eventType,
    detail: { reason: eventType === "failed" ? text(messagePayload.channel_failure_reason || messagePayload.channel_error_code) || "interakt_delivery_failed" : undefined },
  });
  return { ...result, accepted: true, status: 200, matched: true, messageId: text(message.id), eventType, externalDelivery: true };
}

export async function signInteraktWebhook(secret: string, rawBody: string) {
  return `sha256=${await hmacHex(rawBody, secret)}`;
}
