/**
 * Interakt WhatsApp governance - the "share the details on WhatsApp" half of Haptik's solution
 * document. Eight of the twelve outbound voice journeys and the inbound agent all end the same way:
 * the customer says yes on the call, and an Interakt template carrying a static PawSpace link has to
 * reach their WhatsApp. Nothing in the platform could do that before this module.
 *
 * The dangerous part of this is not the HTTP call, it is that a voice bot can now cause a WhatsApp
 * message to a real person. So the send is deliberately NOT a straight line from the bot to Interakt:
 *
 *   - It goes through enqueueCommunication, the same engine staff alerts, reminders and food
 *     subscriptions use, which owns the consent decision, quiet hours, the 7-day promotional cap, the
 *     retry/backoff outbox and the dead-letter queue. This module adds no policy of its own on top and
 *     - importantly - takes none away: a message the engine suppresses is recorded as suppressed and
 *     never dispatched.
 *   - The bot cannot grant itself permission. It ASSERTS the consent the customer gave on the call
 *     and must supply a source and an evidence reference (the call ref); that becomes a
 *     whatsapp_ai_consent_evidence row with the same wording-versioned shape the chat path already
 *     writes, and only then is a preference recorded. With no evidence, nothing is written and the
 *     engine's own consent gate then suppresses the message.
 *   - opt_out always wins. Every preference write is guarded on opt_out=0, so an opted-out customer
 *     cannot be talked back into contactability by a bot on a call.
 *   - The link the customer receives is operator-configured and validated (https, no credentials), and
 *     the template must be registered as approved in the language being sent. An unconfigured link or
 *     an unapproved template is a refusal, not a guess - the customer never gets a broken link.
 *
 * The message body of record stays in communication_messages; interakt_sends only ties a voice call to
 * that message so ops can answer "did the WhatsApp the bot promised actually go out?".
 */

import { enqueueCommunication, recordDeliveryEvent, failOutboxAttempt, setCommunicationPreference, type CommunicationPurpose } from "./communication-engine";
import { interaktConfigured, sendInteraktTemplate } from "./interakt-client";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
const text = (value: unknown) => String(value ?? "").trim();
const digits = (value: unknown) => text(value).replace(/\D/g, "");
const last10 = (value: unknown) => digits(value).slice(-10);
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const parse = <T,>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; } };

export const INTERAKT_CONSENT_WORDING_VERSION = "interakt-voice-consent-v1";

/**
 * The static links the solution document names, one per journey ending. `purpose` is the
 * communication-engine purpose the send runs under, which decides which consent gate applies:
 * `marketing` needs express marketing consent, `lifecycle` needs service updates not to be refused.
 * Promotional pitches are marketing; messages about something the customer already bought are not.
 */
export type InteraktLinkDefinition = {
  key: string;
  label: string;
  purpose: Extract<CommunicationPurpose, "marketing" | "lifecycle">;
  envKey: string;
  defaultTemplateKey: string;
  useCase: string;
};

export const INTERAKT_LINKS: InteraktLinkDefinition[] = [
  { key: "grooming_package_booking", label: "Grooming package details + booking link", purpose: "marketing", envKey: "INTERAKT_LINK_GROOMING_BOOKING", defaultTemplateKey: "pawspace_grooming_package_v1", useCase: "New grooming lead follow-up, abandoned checkout, offer pitch" },
  { key: "grooming_subscription", label: "Grooming subscription details + booking link", purpose: "marketing", envKey: "INTERAKT_LINK_GROOMING_SUBSCRIPTION", defaultTemplateKey: "pawspace_grooming_subscription_v1", useCase: "Grooming subscription pitch" },
  { key: "subscription_renewal", label: "Subscription renewal link", purpose: "lifecycle", envKey: "INTERAKT_LINK_SUBSCRIPTION_RENEWAL", defaultTemplateKey: "pawspace_subscription_renewal_v1", useCase: "Subscription renewal reminder" },
  { key: "abandoned_checkout", label: "Resume checkout link", purpose: "lifecycle", envKey: "INTERAKT_LINK_ABANDONED_CHECKOUT", defaultTemplateKey: "pawspace_resume_checkout_v1", useCase: "Abandoned checkout recovery" },
  { key: "pending_session_booking", label: "Book a pending session link", purpose: "lifecycle", envKey: "INTERAKT_LINK_PENDING_SESSION", defaultTemplateKey: "pawspace_pending_session_v1", useCase: "Pending grooming session follow-up" },
  { key: "website", label: "PawSpace website link", purpose: "marketing", envKey: "INTERAKT_LINK_WEBSITE", defaultTemplateKey: "pawspace_website_v1", useCase: "Winback, dog walking, inbound enquiry" },
];
export const INTERAKT_LINK_KEYS = INTERAKT_LINKS.map(link => link.key);
const linkByKey = (key: string) => INTERAKT_LINKS.find(link => link.key === text(key)) || null;

export async function ensureInteraktTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS interakt_link_registry (link_key TEXT PRIMARY KEY,url TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS interakt_templates (template_key TEXT PRIMARY KEY,link_key TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending_approval',language TEXT NOT NULL DEFAULT 'en',category TEXT NOT NULL DEFAULT 'marketing',updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS interakt_sends (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,message_id TEXT,link_key TEXT NOT NULL,template_key TEXT NOT NULL,purpose TEXT NOT NULL,lead_id TEXT,customer_id TEXT,contact_id TEXT,phone TEXT NOT NULL,call_ref TEXT,status TEXT NOT NULL,reason TEXT,requested_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_interakt_sends_link ON interakt_sends(link_key,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_interakt_sends_message ON interakt_sends(message_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_ai_consent_evidence (id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,contact_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,purpose TEXT NOT NULL,granted INTEGER NOT NULL,source TEXT NOT NULL,evidence_ref TEXT NOT NULL,wording_version TEXT NOT NULL,captured_by TEXT NOT NULL,captured_at INTEGER NOT NULL,revoked_at INTEGER,UNIQUE(lead_id,channel,purpose))"),
  ]);
}

/** Operator-configured destination for a link key. Validated: this URL is sent to customers. */
export async function setInteraktLink(db: Db, input: { linkKey: string; url: string; actorId: string }) {
  await ensureInteraktTables(db);
  const definition = linkByKey(input.linkKey);
  if (!definition) throw new Error(`Unknown Interakt link: ${input.linkKey}. Use one of ${INTERAKT_LINK_KEYS.join(" | ")}`);
  const url = validateLinkUrl(input.url);
  const now = Date.now();
  await db.prepare("INSERT INTO interakt_link_registry (link_key,url,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(link_key) DO UPDATE SET url=excluded.url,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(definition.key, url, input.actorId, now).run();
  return { linkKey: definition.key, url, updatedAt: now };
}

function validateLinkUrl(value: unknown) {
  const raw = text(value);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("A link must be a valid absolute URL"); }
  if (url.protocol !== "https:") throw new Error("A customer-facing link must be https");
  if (url.username || url.password) throw new Error("A customer-facing link must not embed credentials");
  return url.toString();
}

/**
 * Register a template and its WhatsApp approval state. Outside a 24-hour customer-service window
 * WhatsApp only delivers approved templates, and Interakt's send endpoint is template-only, so an
 * unapproved template is a guaranteed non-delivery - better refused here than counted as sent.
 */
export async function setInteraktTemplate(db: Db, input: { templateKey: string; linkKey: string; status?: string; language?: string; category?: string; actorId: string }) {
  await ensureInteraktTables(db);
  const definition = linkByKey(input.linkKey);
  if (!definition) throw new Error(`Unknown Interakt link: ${input.linkKey}`);
  const templateKey = text(input.templateKey);
  if (!templateKey) throw new Error("A template key is required");
  const status = ["approved", "pending_approval", "rejected", "paused"].includes(text(input.status)) ? text(input.status) : "pending_approval";
  const language = text(input.language) || "en";
  const category = ["marketing", "utility", "authentication"].includes(text(input.category)) ? text(input.category) : (definition.purpose === "marketing" ? "marketing" : "utility");
  const now = Date.now();
  await db.prepare("INSERT INTO interakt_templates (template_key,link_key,status,language,category,updated_by,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(template_key) DO UPDATE SET link_key=excluded.link_key,status=excluded.status,language=excluded.language,category=excluded.category,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(templateKey, definition.key, status, language, category, input.actorId, now).run();
  return { templateKey, linkKey: definition.key, status, language, category, updatedAt: now };
}

async function resolveLink(db: Db, env: Env, definition: InteraktLinkDefinition) {
  const row = await db.prepare("SELECT url FROM interakt_link_registry WHERE link_key=?").bind(definition.key).first<Row>().catch(() => null);
  const configured = text(row?.url) || text(env?.[definition.envKey]);
  if (!configured) return null;
  try { return validateLinkUrl(configured); } catch { return null; }
}

async function resolveTemplate(db: Db, definition: InteraktLinkDefinition, language: string) {
  const rows = await db.prepare("SELECT template_key,status,language,category FROM interakt_templates WHERE link_key=?").bind(definition.key).all<Row>().catch(() => ({ results: [] as Row[] }));
  const wanted = text(language) || "en";
  const exact = rows.results.find(r => text(r.status) === "approved" && text(r.language) === wanted);
  if (exact) return { templateKey: text(exact.template_key), language: wanted, approved: true };
  const anyApproved = rows.results.find(r => text(r.status) === "approved");
  if (anyApproved) return { templateKey: text(anyApproved.template_key), language: text(anyApproved.language) || "en", approved: true };
  const registered = rows.results[0];
  return { templateKey: registered ? text(registered.template_key) : definition.defaultTemplateKey, language: wanted, approved: false };
}

/** Readiness for the ops console: what still has to be configured before any WhatsApp can go out. */
export async function interaktReadiness(db: Db, env: Env) {
  await ensureInteraktTables(db);
  const links = [];
  for (const definition of INTERAKT_LINKS) {
    const url = await resolveLink(db, env, definition);
    const template = await resolveTemplate(db, definition, "en");
    links.push({ linkKey: definition.key, label: definition.label, purpose: definition.purpose, useCase: definition.useCase, linkConfigured: Boolean(url), templateKey: template.templateKey, templateApproved: template.approved });
  }
  const connected = interaktConfigured(env);
  return {
    connected,
    reason: connected ? null : "Interakt is not connected (INTERAKT_API_KEY / INTERAKT_BASE_URL not configured)",
    links,
    sendable: connected && links.every(link => link.linkConfigured && link.templateApproved),
  };
}

/**
 * Resolve the CRM contact and canonical customer for a number the bot is about to message. Deliberately
 * strict in both directions: a WhatsApp send is never the first record of a person (the voice journeys
 * all call capture_lead first), and an ambiguous phone match is refused rather than guessed, because
 * guessing means messaging the wrong customer.
 */
type RecipientResolution =
  | { reason: string; contactId?: undefined }
  | { reason: null; contactId: string; customerId: string; leadId: string; phone: string };

async function resolveRecipient(db: Db, input: { phone: string; leadId?: string; cityId?: string }): Promise<RecipientResolution> {
  const key = last10(input.phone);
  if (key.length !== 10) return { reason: "invalid_phone" };
  let contact: Row | null = null, leadId = text(input.leadId);
  if (leadId) {
    const lead = await db.prepare("SELECT id,customer_id,opt_out FROM lead_work_items WHERE id=?").bind(leadId).first<Row>().catch(() => null);
    if (!lead) return { reason: "lead_not_found" };
    if (Number(lead.opt_out || 0) === 1) return { reason: "lead_opted_out" };
    contact = await db.prepare("SELECT id,name,primary_phone,secondary_phone,email,area FROM crm_contacts WHERE id=?").bind(text(lead.customer_id)).first<Row>().catch(() => null);
    if (contact && last10(contact.primary_phone) !== key) return { reason: "lead_phone_mismatch" };
  }
  if (!contact) {
    contact = await db.prepare("SELECT id,name,primary_phone,secondary_phone,email,area FROM crm_contacts WHERE replace(replace(replace(primary_phone,' ',''),'-',''),'+','') LIKE ? ORDER BY updated_at DESC LIMIT 1").bind(`%${key}`).first<Row>().catch(() => null);
    if (!contact) return { reason: "no_crm_lead" };
    if (!leadId) {
      const lead = await db.prepare("SELECT id FROM lead_work_items WHERE customer_id=? ORDER BY created_at DESC LIMIT 1").bind(text(contact.id)).first<Row>().catch(() => null);
      leadId = lead ? text(lead.id) : "";
    }
  }
  const contactId = text(contact.id);
  // Canonical identity, same rule the chat path uses: one match is the customer, several is a review.
  const matches = await db.prepare("SELECT id FROM canonical_customers WHERE replace(replace(replace(primary_phone,' ',''),'-',''),'+','') LIKE ? LIMIT 5").bind(`%${key}`).all<Row>().catch(() => ({ results: [] as Row[] }));
  const unique = [...new Set(matches.results.map(r => text(r.id)))];
  if (unique.length > 1) return { reason: "phone_matches_multiple_customers" };
  let customerId = unique[0] || "";
  if (!customerId) {
    const now = Date.now();
    customerId = contactId;
    await db.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?, 'crm_lead','{}',?,?)")
      .bind(customerId, text(input.cityId) || "blr", text(contact.name) || "PawSpace lead", text(contact.primary_phone), contact.secondary_phone ?? null, contact.email ?? null, now, now).run().catch(() => null);
  }
  return { reason: null, contactId, customerId, leadId, phone: text(contact.primary_phone) || input.phone };
}

export type InteraktQueueInput = {
  idempotencyKey: string;
  linkKey: string;
  phone: string;
  leadId?: string;
  cityId?: string;
  language?: string;
  callRef?: string;
  bodyValues?: string[];
  consentGranted?: boolean;
  consentSource?: string;
  consentEvidenceRef?: string;
  actorId: string;
};

/**
 * Queue the WhatsApp the voice agent promised. Returns a refusal reason rather than throwing for every
 * condition an operator can fix (unconfigured link, unapproved template, missing consent), so the bot
 * can say something truthful on the call instead of the send silently disappearing.
 */
export async function queueInteraktWhatsApp(db: Db, env: Env, input: InteraktQueueInput) {
  await ensureInteraktTables(db);
  const idempotencyKey = text(input.idempotencyKey);
  if (!idempotencyKey) throw new Error("An idempotency key is required");
  const prior = await db.prepare("SELECT id,message_id,status,reason,link_key FROM interakt_sends WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) return { duplicatePrevented: true, sendId: text(prior.id), messageId: text(prior.message_id) || null, status: text(prior.status), reason: text(prior.reason) || null, linkKey: text(prior.link_key) };

  const definition = linkByKey(input.linkKey);
  if (!definition) throw new Error(`Unknown Interakt link: ${input.linkKey}. Use one of ${INTERAKT_LINK_KEYS.join(" | ")}`);
  const now = Date.now(), phone = text(input.phone);
  const record = async (status: string, reason: string | null, extra: { messageId?: string | null; customerId?: string | null; contactId?: string | null; leadId?: string | null; templateKey?: string } = {}) => {
    const id = uid("IKS");
    await db.prepare("INSERT OR IGNORE INTO interakt_sends (id,idempotency_key,message_id,link_key,template_key,purpose,lead_id,customer_id,contact_id,phone,call_ref,status,reason,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, idempotencyKey, extra.messageId || null, definition.key, extra.templateKey || definition.defaultTemplateKey, definition.purpose, extra.leadId || null, extra.customerId || null, extra.contactId || null, phone, text(input.callRef) || null, status, reason, input.actorId, now, now).run();
    const stored = await db.prepare("SELECT id,message_id,status,reason FROM interakt_sends WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
    return { duplicatePrevented: false, sendId: text(stored?.id) || id, messageId: text(stored?.message_id) || null, status: text(stored?.status) || status, reason: text(stored?.reason) || reason, linkKey: definition.key };
  };

  if (!interaktConfigured(env)) return record("blocked", "interakt_not_connected");
  const url = await resolveLink(db, env, definition);
  if (!url) return record("blocked", "link_not_configured");
  const template = await resolveTemplate(db, definition, input.language || "en");
  if (!template.approved) return record("blocked", "template_not_approved", { templateKey: template.templateKey });

  const recipient = await resolveRecipient(db, { phone, leadId: input.leadId, cityId: input.cityId });
  if (recipient.reason !== null) return record("blocked", recipient.reason, { templateKey: template.templateKey });
  const { contactId, customerId, leadId } = recipient;

  const preference = await db.prepare("SELECT opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>().catch(() => null);
  if (Number(preference?.opt_out || 0) === 1) return record("blocked", "customer_opted_out", { templateKey: template.templateKey, customerId, contactId, leadId });

  // The bot asserts what the customer agreed to on the call. No assertion, no preference write - and
  // the engine's own consent gate then suppresses the message rather than sending it anyway.
  const consentSource = text(input.consentSource), evidenceRef = text(input.consentEvidenceRef) || text(input.callRef);
  if (input.consentGranted && consentSource.length >= 3 && evidenceRef.length >= 5) {
    const consentPurpose = definition.purpose === "marketing" ? "voice_marketing" : "voice_lifecycle";
    await db.prepare("INSERT OR IGNORE INTO whatsapp_ai_consent_evidence (id,lead_id,contact_id,customer_id,channel,purpose,granted,source,evidence_ref,wording_version,captured_by,captured_at) VALUES (?,?,?,?, 'whatsapp',?,1,?,?,?,?,?)")
      .bind(uid("WACE"), leadId || contactId, contactId, customerId, consentPurpose, consentSource, evidenceRef, INTERAKT_CONSENT_WORDING_VERSION, input.actorId, now).run();
    // Channel-level consent, guarded so an opted-out customer is never re-enabled by a bot.
    await db.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,?,1,1,0,0,0,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET whatsapp_consent=1,marketing_consent=MAX(customer_contact_preferences.marketing_consent,excluded.marketing_consent),source=excluded.source,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE customer_contact_preferences.opt_out=0")
      .bind(customerId, definition.purpose === "marketing" ? 1 : 0, consentSource, input.actorId, now).run();
    // What the communication engine itself reads for its consent decision.
    if (definition.purpose === "marketing") await setCommunicationPreference(db, { customerId, marketing: true, source: `haptik_voice:${consentSource}` });
    else await setCommunicationPreference(db, { customerId, serviceUpdates: true, source: `haptik_voice:${consentSource}` });
  }

  // The engine refuses a city it has no communication policy for, and a voice bot passes through
  // whatever the customer said their area was. That must be a truthful refusal the agent can speak,
  // not a 500 that leaves the customer waiting for a message which will never arrive.
  let queued: Awaited<ReturnType<typeof enqueueCommunication>>;
  try {
    queued = await enqueueCommunication(db, {
      customerId, cityId: text(input.cityId) || "blr", channel: "whatsapp", purpose: definition.purpose,
      idempotencyKey: `interakt:${idempotencyKey}`, templateKey: template.templateKey,
      payload: { provider: "interakt", linkKey: definition.key, url, language: template.language, bodyValues: (input.bodyValues || []).map(v => text(v)).slice(0, 10), callRef: text(input.callRef) || null },
      createdBy: input.actorId, leadId: leadId || undefined,
    });
  } catch (error) {
    return record("blocked", `communication_engine_refused:${error instanceof Error ? error.message : "unknown"}`.slice(0, 200), { customerId, contactId, leadId, templateKey: template.templateKey });
  }
  if (queued.duplicatePrevented) {
    const messageId = text((queued.message as Row | undefined)?.id);
    return record("queued", "duplicate_message", { messageId, customerId, contactId, leadId, templateKey: template.templateKey });
  }
  const status = text(queued.status) === "suppressed" ? "suppressed" : text(queued.status);
  const reason = status === "suppressed" ? (queued.policy?.reasons || []).join(",") || "suppressed_by_policy" : null;
  return record(status, reason, { messageId: text(queued.messageId), customerId, contactId, leadId, templateKey: template.templateKey });
}

export type InteraktDispatchResult = { status: string; provider: "interakt"; externalDelivery: boolean; reason?: string; providerReference?: string; attempts?: number; nextAttemptAt?: number };

/**
 * Actually hand a queued WhatsApp message to Interakt. Mirrors the Meta dispatcher: verify the message
 * is queued, verify the recipient really belongs to the customer on the message, re-check consent at
 * send time, claim the outbox row atomically so two sweeps cannot double-send, then record the result
 * as a delivery event or a failed attempt the outbox will retry and eventually dead-letter.
 */
export async function dispatchInteraktMessage(db: Db, env: Env, input: { messageId: string; fetcher?: Fetcher }): Promise<InteraktDispatchResult> {
  await ensureInteraktTables(db);
  const message = await db.prepare("SELECT m.*,o.status outbox_status,o.next_attempt_at FROM communication_messages m JOIN communication_outbox o ON o.message_id=m.id WHERE m.id=?").bind(input.messageId).first<Row>();
  if (!message || text(message.channel) !== "whatsapp") return { status: "message_not_dispatchable", provider: "interakt", externalDelivery: false };
  if (!["queued", "retry_pending", "scheduled"].includes(text(message.outbox_status))) return { status: "already_dispatched", provider: "interakt", externalDelivery: false, reason: text(message.outbox_status) };
  const now = Date.now();
  if (Number(message.next_attempt_at) > now) return { status: "scheduled", provider: "interakt", externalDelivery: false, nextAttemptAt: Number(message.next_attempt_at) };
  if (!interaktConfigured(env)) return { status: "not_configured", provider: "interakt", externalDelivery: false };

  const customerId = text(message.customer_id), payload = parse<Record<string, unknown>>(message.payload_json, {});
  const customer = await db.prepare("SELECT primary_phone,secondary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<Row>().catch(() => null);
  const recipient = text(customer?.primary_phone);
  if (!recipient) return { status: "recipient_unknown", provider: "interakt", externalDelivery: false };
  const consent = await db.prepare("SELECT whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>().catch(() => null);
  if (!consent || Number(consent.whatsapp_consent) !== 1 || Number(consent.opt_out || 0) === 1) return { status: "consent_refused", provider: "interakt", externalDelivery: false };
  const templateKey = text(message.template_key), language = text(payload.language) || "en";
  const approved = await db.prepare("SELECT status,language FROM interakt_templates WHERE template_key=?").bind(templateKey).first<Row>().catch(() => null);
  if (!approved || text(approved.status) !== "approved") return { status: "approved_template_required", provider: "interakt", externalDelivery: false };

  const locked = await db.prepare("UPDATE communication_outbox SET status='dispatching',locked_at=?,updated_at=? WHERE message_id=? AND status IN ('queued','retry_pending','scheduled')").bind(now, now, input.messageId).run();
  if (Number(locked.meta?.changes || 0) !== 1) return { status: "dispatch_race_lost", provider: "interakt", externalDelivery: false };

  const bodyValues = Array.isArray(payload.bodyValues) ? (payload.bodyValues as unknown[]).map(v => text(v)) : [];
  const url = text(payload.url);
  const sent = await sendInteraktTemplate(env, { phone: recipient, templateKey, language, bodyValues, buttonValues: url ? { "0": [url] } : {}, fetcher: input.fetcher });
  if (!sent.connected) {
    const retry = await failOutboxAttempt(db, input.messageId, "interakt_send_failed");
    await db.prepare("UPDATE interakt_sends SET status=?,reason=?,updated_at=? WHERE message_id=?").bind(text(retry.status) || "retry_pending", sent.reason.slice(0, 240), Date.now(), input.messageId).run().catch(() => null);
    return { ...retry, status: text(retry.status), provider: "interakt", externalDelivery: false, reason: sent.reason };
  }
  await db.prepare("UPDATE communication_messages SET provider='interakt',provider_reference=?,updated_at=? WHERE id=?").bind(sent.providerReference, Date.now(), input.messageId).run();
  await recordDeliveryEvent(db, { messageId: input.messageId, provider: "interakt", eventId: `accepted:${sent.providerReference}`, eventType: "accepted", detail: { providerReference: sent.providerReference, linkKey: text(payload.linkKey) } });
  await db.prepare("UPDATE interakt_sends SET status='provider_accepted',reason=NULL,updated_at=? WHERE message_id=?").bind(Date.now(), input.messageId).run().catch(() => null);
  return { status: "provider_accepted", provider: "interakt", externalDelivery: true, providerReference: sent.providerReference };
}

/**
 * Drain the queued Interakt messages. Safe for the background scheduler: a no-op when Interakt is not
 * connected, bounded per run, and every send it does make has already been through the engine's
 * consent and quiet-hours decision at enqueue time and is re-checked at dispatch.
 */
export async function runInteraktDispatchSweep(db: Db, input: { limit?: number; env?: Env; fetcher?: Fetcher } = {}) {
  await ensureInteraktTables(db).catch(() => {});
  let env: Env = input.env || {};
  if (!input.env) { try { const mod = await import("cloudflare:workers"); env = (mod as unknown as { env: Env }).env || {}; } catch { env = {}; } }
  if (!interaktConfigured(env)) return { configured: false, dispatched: 0, failed: 0, skipped: 0, reason: "Interakt is not connected" };
  const limit = Math.max(1, Math.min(Number(input.limit) || 50, 200)), now = Date.now();
  const rows = await db.prepare("SELECT s.message_id FROM interakt_sends s JOIN communication_outbox o ON o.message_id=s.message_id WHERE s.message_id IS NOT NULL AND o.status IN ('queued','retry_pending','scheduled') AND o.next_attempt_at<=? ORDER BY o.next_attempt_at ASC LIMIT ?").bind(now, limit).all<Row>().catch(() => ({ results: [] as Row[] }));
  let dispatched = 0, failed = 0, skipped = 0;
  for (const row of rows.results) {
    const result = await dispatchInteraktMessage(db, env, { messageId: text(row.message_id), fetcher: input.fetcher }).catch(() => null);
    if (!result) { failed++; continue; }
    if (result.externalDelivery) dispatched++;
    else if (["retry_pending", "dead_letter"].includes(result.status)) failed++;
    else skipped++;
  }
  return { configured: true, dispatched, failed, skipped, considered: rows.results.length };
}

/** Ops view: what the bot promised on calls and whether it actually reached WhatsApp. */
export async function listInteraktSends(db: Db, input: { linkKey?: string; limit?: number } = {}) {
  await ensureInteraktTables(db);
  const limit = Math.max(1, Math.min(Number(input.limit) || 100, 500)), linkKey = text(input.linkKey);
  const rows = await db.prepare("SELECT s.id,s.link_key,s.template_key,s.purpose,s.lead_id,s.customer_id,s.phone,s.call_ref,s.status,s.reason,s.requested_by,s.created_at,m.status message_status,m.provider_reference FROM interakt_sends s LEFT JOIN communication_messages m ON m.id=s.message_id WHERE (?='' OR s.link_key=?) ORDER BY s.created_at DESC LIMIT ?").bind(linkKey, linkKey, limit).all<Row>().catch(() => ({ results: [] as Row[] }));
  // Never render a full customer number back into an ops list - the last four is enough to identify a
  // row against a call recording, and the console is a wide-access surface.
  return rows.results.map(r => ({ id: text(r.id), linkKey: text(r.link_key), templateKey: text(r.template_key), purpose: text(r.purpose), leadId: text(r.lead_id) || null, customerId: text(r.customer_id) || null, phoneLast4: last10(r.phone).slice(-4), callRef: text(r.call_ref) || null, status: text(r.status), reason: text(r.reason) || null, messageStatus: text(r.message_status) || null, providerReference: text(r.provider_reference) || null, requestedBy: text(r.requested_by), createdAt: Number(r.created_at) }));
}
