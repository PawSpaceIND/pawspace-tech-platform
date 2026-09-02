import { resolveCanonicalRecipientOwnership } from "./canonical-recipient-ownership";
import { ensureCommunicationTables, failOutboxAttempt, recordDeliveryEvent } from "./communication-engine";
import { ensureHaptikTables } from "./haptik-integration-governance";
import { ensureWhatsAppTemplateLifecycle } from "./whatsapp-template-lifecycle";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type DeliveryEvent = "sent" | "delivered" | "read" | "failed";

const INTERAKT_MESSAGE_URL = "https://api.interakt.ai/v1/public/message/";
const text = (value: unknown) => String(value ?? "").trim();
const phone = (value: unknown) => text(value).replace(/\D/g, "").slice(-10);
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
const optOutWords = new Set(["stop", "unsubscribe", "cancel", "end", "quit"]);

export const INTERAKT_WHATSAPP_PROVIDER = "interakt_whatsapp";
export const INTERAKT_SECRET_NAMES = ["INTERAKT_WEBHOOK_SECRET", "INTERAKT_API_KEY"] as const;

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
      headers: { authorization: `Basic ${apiKey}`, "content-type": "application/json", "x-pawspace-idempotency-key": text(message.idempotency_key) },
      body: JSON.stringify({ ...recipient, callbackData: `pawspace:${input.messageId}`, type: "Template", template: { name: template.key, languageCode: template.language, bodyValues: values } }),
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

const INTERAKT_DELIVERY_TYPES: Record<string, DeliveryEvent> = { message_api_sent: "sent", message_api_delivered: "delivered", message_api_read: "read", message_api_failed: "failed" };
export function isInteraktDeliveryWebhook(rawBody: string) { try { const body = JSON.parse(rawBody) as Row; return Boolean(INTERAKT_DELIVERY_TYPES[text(body.type)]); } catch { return false; } }

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
    try { await resolveCanonicalRecipientOwnership(db, env, { phone: callbackPhone, customerId: text(message.customer_id), leadId: text(message.lead_id) || null, bookingId: text(message.booking_id) || null, requireSuppliedPhone: true }); }
    catch { return { accepted: true, status: 200, matched: true, applied: false, reason: "recipient_customer_mismatch", externalDelivery: true }; }
  }
  const eventId = `${text(body.type)}:${providerReference}:${text(body.timestamp) || "provider"}`;
  const result = await recordDeliveryEvent(db, { messageId: text(message.id), provider: "interakt", eventId, eventType, detail: { reason: eventType === "failed" ? text(messagePayload.channel_failure_reason || messagePayload.channel_error_code) || "interakt_delivery_failed" : undefined } });
  return { ...result, accepted: true, status: 200, matched: true, messageId: text(message.id), eventType, externalDelivery: true };
}

export async function signInteraktWebhook(secret: string, rawBody: string) { return `sha256=${await hmacHex(rawBody, secret)}`; }

export async function verifyInteraktWebhook(rawBody: string, headers: Headers, env: Env) {
  const secret = text(env.INTERAKT_WEBHOOK_SECRET); if (!secret) return { ok: false as const, status: 503, reason: "interakt_webhook_not_configured" };
  const signature = text(headers.get("x-interakt-signature")).toLowerCase().replace(/^sha256=/, "");
  if (signature) { const expected = await hmacHex(rawBody, secret); return safeEqual(signature, expected) ? { ok: true as const } : { ok: false as const, status: 401, reason: "invalid_interakt_signature" }; }
  const presented = text(headers.get("x-interakt-webhook-secret") || headers.get("authorization")).replace(/^Bearer\s+/i, "");
  return presented && safeEqual(presented, secret) ? { ok: true as const } : { ok: false as const, status: 401, reason: "invalid_interakt_credentials" };
}

async function resolveCanonicalCustomer(db: Db, input: { providerIdentity: string; claimedCustomerId?: string | null }) {
  const identity = phone(input.providerIdentity); if (!identity) throw new Response("Interakt sender phone is required", { status: 400 });
  if (input.claimedCustomerId) { const row = await db.prepare("SELECT id,name,primary_phone,secondary_phone FROM canonical_customers WHERE id=?").bind(text(input.claimedCustomerId)).first<Row>(); if (!row) throw new Response("Canonical customer not found", { status: 404 }); if (![row.primary_phone, row.secondary_phone].some((value) => phone(value) === identity)) throw new Response("Interakt customer ownership mismatch", { status: 409 }); return row; }
  const found = await db.prepare("SELECT id,name,primary_phone,secondary_phone FROM canonical_customers").all<Row>(); const matches = found.results.filter((row) => [row.primary_phone, row.secondary_phone].some((value) => phone(value) === identity)); if (matches.length !== 1) throw new Response("Interakt identity requires governed customer resolution", { status: 409 }); return matches[0];
}
async function consentState(db: Db, customerId: string) { const pref = await db.prepare("SELECT marketing_consent,whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>().catch(() => null); return { marketing: Number(pref?.marketing_consent || 0) === 1, whatsapp: Number(pref?.whatsapp_consent || 0) === 1, optOut: Number(pref?.opt_out || 0) === 1 }; }
async function persistOptOut(db: Db, customerId: string, now: number) { await db.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,0,0,0,0,1,'interakt_inbound_opt_out','interakt_webhook',?) ON CONFLICT(customer_id) DO UPDATE SET marketing_consent=0,whatsapp_consent=0,opt_out=1,source='interakt_inbound_opt_out',updated_by='interakt_webhook',updated_at=excluded.updated_at").bind(customerId, now).run(); }
async function ensureCrmOwnership(db: Db, customer: Row, input: { providerIdentity: string; service: string }) { await ensureHaptikTables(db); const customerId = text(customer.id), now = Date.now(); await db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,stage,owner,source,created_at,updated_at) VALUES (?,?,?,'New lead','Unassigned','interakt_whatsapp',?,?) ON CONFLICT(id) DO UPDATE SET name=COALESCE(NULLIF(excluded.name,''),crm_contacts.name),primary_phone=excluded.primary_phone,source='interakt_whatsapp',updated_at=excluded.updated_at").bind(customerId, text(customer.name) || `Customer ${phone(input.providerIdentity).slice(-4)}`, input.providerIdentity, now, now).run(); const prior = await db.prepare("SELECT id FROM lead_work_items WHERE customer_id=? AND status IN ('active','sla_breached','qualified') ORDER BY created_at DESC LIMIT 1").bind(customerId).first<Row>(); if (prior) return text(prior.id); const leadId = `LWI-${crypto.randomUUID().slice(0, 12).toUpperCase()}`; await db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?,?,?,'Unassigned','Unassigned','active','day_1',1,?,?,?,?,?)").bind(leadId, customerId, "interakt_whatsapp", input.service || "general_enquiry", now, now + 30 * 60_000, now + 60 * 60_000, now, now).run(); return leadId; }
async function recordInboundMessage(db: Db, input: { eventId: string; customerId: string; leadId: string; message: string; providerIdentity: string; receivedAt: number }) { await ensureCommunicationTables(db); const duplicate = await db.prepare("SELECT id,thread_id FROM communication_messages WHERE idempotency_key=?").bind(`interakt:${input.eventId}`).first<Row>(); if (duplicate) return { duplicatePrevented: true, messageId: text(duplicate.id), threadId: text(duplicate.thread_id) }; let thread = await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? AND status='open' ORDER BY updated_at DESC LIMIT 1").bind(input.customerId).first<Row>(); if (!thread) { const id = `THREAD-${crypto.randomUUID().slice(0, 12).toUpperCase()}`; await db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,?,NULL,'open',NULL,NULL,?,?)").bind(id, input.customerId, input.leadId, input.receivedAt, input.receivedAt).run(); thread = { id }; } const threadId = text(thread.id), messageId = `MSG-IA-${crypto.randomUUID().slice(0, 12).toUpperCase()}`; await db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,?,NULL,'inbound','whatsapp','transactional','interakt_inbound',?,'received',?,?,?,?,'interakt_webhook',?,?)").bind(messageId, threadId, input.customerId, input.leadId, JSON.stringify({ text: input.message, providerIdentity: input.providerIdentity }), INTERAKT_WHATSAPP_PROVIDER, input.eventId, `interakt:${input.eventId}`, JSON.stringify({ canonicalCustomerVerified: true, marketingConsentInferred: false }), input.receivedAt, input.receivedAt).run(); await db.prepare("UPDATE communication_threads SET lead_id=COALESCE(lead_id,?),updated_at=? WHERE id=?").bind(input.leadId, input.receivedAt, threadId).run(); return { duplicatePrevented: false, messageId, threadId }; }

export async function processInteraktInbound(db: Db, env: Env, input: { rawBody: string; headers: Headers }) {
  const verified = await verifyInteraktWebhook(input.rawBody, input.headers, env); if (!verified.ok) return { accepted: false, status: verified.status, reason: verified.reason, externalDelivery: false };
  let body: Record<string, unknown>; try { body = JSON.parse(input.rawBody) as Record<string, unknown>; } catch { return { accepted: false, status: 400, reason: "invalid_interakt_json", externalDelivery: false }; }
  const eventId = text(body.event_id || body.eventId || body.id), providerIdentity = text(body.phone || body.from || body.wa_id || body.waId), message = text(body.message || body.text || body.body), claimedCustomerId = text(body.customer_id || body.customerId) || null, service = text(body.service || body.inquiry_category || body.inquiryCategory) || "general_enquiry";
  if (!eventId || !providerIdentity || !message) return { accepted: false, status: 400, reason: "interakt_event_phone_and_message_required", externalDelivery: false };
  const customer = await resolveCanonicalCustomer(db, { providerIdentity, claimedCustomerId }), customerId = text(customer.id), now = Number(body.timestamp || Date.now());
  const leadId = await ensureCrmOwnership(db, customer, { providerIdentity, service }); const normalized = message.toLowerCase().replace(/[.!?,;:]+$/g, ""); if (optOutWords.has(normalized)) await persistOptOut(db, customerId, now);
  const recorded = await recordInboundMessage(db, { eventId, customerId, leadId, message, providerIdentity, receivedAt: now }); const consent = await consentState(db, customerId);
  return { accepted: true, status: recorded.duplicatePrevented ? 200 : 201, eventId, customerId, leadId, ...recorded, optedOut: consent.optOut, whatsappConsent: consent.whatsapp, marketingConsent: consent.marketing, marketingConsentInferred: false, externalDelivery: false };
}

export async function interaktOutboundConsentGuard(db: Db, input: { customerId: string; recipient: string; purpose: "transactional" | "marketing" }) {
  const customer = await db.prepare("SELECT primary_phone,secondary_phone FROM canonical_customers WHERE id=?").bind(input.customerId).first<Row>(); if (!customer) return { allowed: false as const, reason: "canonical_customer_required" };
  if (![customer.primary_phone, customer.secondary_phone].some((value) => phone(value) === phone(input.recipient))) return { allowed: false as const, reason: "recipient_customer_mismatch" };
  const consent = await consentState(db, input.customerId); if (consent.optOut) return { allowed: false as const, reason: "customer_opted_out" }; if (!consent.whatsapp) return { allowed: false as const, reason: "whatsapp_consent_required" }; if (input.purpose === "marketing" && !consent.marketing) return { allowed: false as const, reason: "marketing_consent_required" }; return { allowed: true as const, reason: null };
}
