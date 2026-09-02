/**
 * Haptik OUTBOUND trigger side - the direction the engagement says is "the client's responsibility":
 * PawSpace decides WHO to call and asks Haptik to place the voice call. This is the sensitive half of
 * the integration, so it is wrapped in responsible-outbound guardrails:
 *
 *   - fail-closed: dials nothing until HAPTIK_OUTBOUND_API_KEY + HAPTIK_OUTBOUND_URL are configured;
 *   - consent: marketing campaigns require marketing_consent and are never sent to opted-out contacts;
 *   - quiet hours: no calls placed 21:00-09:00 IST;
 *   - frequency cap: a phone is not dialled again within 7 days across all campaigns;
 *   - idempotency: one call per (campaign, contact, day) - re-running the trigger never double-dials;
 *   - human-launched: the scheduler sweep only refreshes audience *readiness* counts, it NEVER dials.
 *     Placing calls happens only through the explicit, permission-gated POST trigger (a human presses go).
 *
 * Audiences reuse the real book of record (leads, bookings, subscriptions, target scores). Cold-DB safe.
 */

import { haptikOutboundConfigured, triggerHaptikCall } from "./haptik-outbound-client";
import { audienceBuilderFor, AUDIENCE_BUILDERS } from "./haptik-outbound-audiences";
import { dispatchInteraktMessage, interaktEnabled } from "./interakt-whatsapp";
import { enqueueCommunication } from "./communication-engine";

type Db = D1Database;
type HEnv = Record<string, unknown>;
type Row = Record<string, unknown>;
const DAY = 86_400_000;
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const digits = (s: string) => String(s || "").replace(/[^0-9]/g, "");
const text = (v: unknown) => String(v ?? "").trim();
const empty = () => ({ results: [] as Row[] });

export const FREQUENCY_CAP_DAYS = 7;
const QUIET_START_HOUR = 21; // 21:00 IST
const QUIET_END_HOUR = 9;    //  09:00 IST
const IST_OFFSET_MS = 5.5 * 3600_000;

/**
 * A campaign declares its channels explicitly.
 *
 * `whatsappTemplate` is what makes 8 of the LOE's 12 use cases possible: those need a link delivered
 * (package, subscription, renewal, website), which a voice call cannot do. A campaign with no template
 * is voice-only, and a campaign with one sends BOTH - the call opens the conversation, the message
 * carries the link. The template name is the Meta-approved template, required because these sends are
 * outside the 24-hour customer-service window by construction.
 */
export type OutboundCampaign = { code: string; label: string; requiresMarketingConsent: boolean; description: string; whatsappTemplate?: string };
export const HAPTIK_CAMPAIGNS: OutboundCampaign[] = [
  // --- the three that already existed ---
  { code: "new_lead_followup", label: "New grooming lead follow-up", requiresMarketingConsent: false, description: "Call back a fresh inbound lead that hasn't been actioned yet (they reached out to us).", whatsappTemplate: "ps_lead_followup_v1" },
  { code: "reactivation", label: "Lapsed customer reactivation", requiresMarketingConsent: true, description: "Win back a customer whose last service was over 60 days ago.", whatsappTemplate: "ps_reactivation_v1" },
  { code: "subscription_pitch", label: "Grooming subscription pitch", requiresMarketingConsent: true, description: "Offer a grooming subscription to an active customer who doesn't have one yet.", whatsappTemplate: "ps_subscription_link_v1" },
  // --- the nine the LOE requires ---
  { code: "abandoned_checkout", label: "Abandoned checkout recovery", requiresMarketingConsent: true, description: "A booking left in draft/pending, or a held slot with no booking behind it, in the last 7 days.", whatsappTemplate: "ps_resume_booking_v1" },
  { code: "seasonal_offer", label: "Seasonal / promotional offer", requiresMarketingConsent: true, description: "Customers holding an unredeemed, unexpired reward code (birthday or review).", whatsappTemplate: "ps_offer_link_v1" },
  { code: "renewal_reminder", label: "Subscription renewal reminder", requiresMarketingConsent: false, description: "An active/paused grooming subscription expiring within 10 days, or down to its last session.", whatsappTemplate: "ps_renewal_link_v1" },
  { code: "pending_session_followup", label: "Pending session follow-up", requiresMarketingConsent: false, description: "A paid training programme with sessions still unused - a delivery debt we owe.", whatsappTemplate: "ps_pending_session_v1" },
  { code: "training_lead_conversion", label: "Dog training lead conversion", requiresMarketingConsent: false, description: "An unconverted dog-training enquiry, oldest first.", whatsappTemplate: "ps_training_info_v1" },
  { code: "winback", label: "Deep winback", requiresMarketingConsent: true, description: "A customer quiet for over 180 days, highest lifetime spend first.", whatsappTemplate: "ps_winback_v1" },
  { code: "boarding_sitting_cross_sell", label: "Boarding / sitting cross-sell", requiresMarketingConsent: true, description: "Uses grooming or walking, has never booked boarding.", whatsappTemplate: "ps_boarding_info_v1" },
  { code: "walking_cross_sell", label: "Dog walking cross-sell", requiresMarketingConsent: true, description: "Uses grooming or boarding, has never booked dog walking.", whatsappTemplate: "ps_walking_info_v1" },
  { code: "taxi_cross_sell", label: "Pet taxi cross-sell", requiresMarketingConsent: true, description: "Uses grooming, boarding or sitting, has never booked pet taxi.", whatsappTemplate: "ps_taxi_info_v1" },
];

/**
 * The campaign list and the audience registry must agree exactly.
 *
 * This is asserted at module load, not just in a test, because the failure it prevents is a campaign
 * that dials a real audience it was never scoped for. A mismatch is a coding error, and it should stop
 * the module rather than quietly ship.
 */
const CAMPAIGN_CODES = HAPTIK_CAMPAIGNS.map(c => c.code);
{
  const missingBuilder = CAMPAIGN_CODES.filter(code => !AUDIENCE_BUILDERS[code]);
  const orphanBuilder = Object.keys(AUDIENCE_BUILDERS).filter(code => !CAMPAIGN_CODES.includes(code));
  if (missingBuilder.length) throw new Error(`Outbound campaigns with no audience builder: ${missingBuilder.join(", ")}`);
  if (orphanBuilder.length) throw new Error(`Audience builders with no campaign: ${orphanBuilder.join(", ")}`);
}

const campaignByCode = (code: string) => HAPTIK_CAMPAIGNS.find(c => c.code === code) || null;

/** True when the local wall-clock in IST falls inside the quiet window (21:00-09:00). */
export function isQuietHours(at: number): boolean {
  const istHour = new Date(at + IST_OFFSET_MS).getUTCHours();
  return istHour >= QUIET_START_HOUR || istHour < QUIET_END_HOUR;
}

export async function ensureHaptikOutboundTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS haptik_outbound_calls (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,campaign TEXT NOT NULL,contact_id TEXT NOT NULL,phone TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',call_ref TEXT,reason TEXT,context_json TEXT NOT NULL DEFAULT '{}',requested_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_haptik_outbound_phone ON haptik_outbound_calls(phone,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_haptik_outbound_campaign ON haptik_outbound_calls(campaign,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS haptik_outbound_readiness (campaign TEXT PRIMARY KEY,ready_count INTEGER NOT NULL DEFAULT 0,refreshed_at INTEGER NOT NULL)"),
  ]);
}

export type OutboundContact = { contactId: string; phone: string; name: string; context: Record<string, unknown> };

/**
 * Build the outbound audience for a campaign. Consent-filtered, cold-DB safe, and FAIL-CLOSED.
 *
 * The builder is looked up by code in an explicit registry. There is no fallthrough: a campaign with no
 * builder throws instead of borrowing another campaign's audience, which is what the previous if-chain
 * did silently (see lib/haptik-outbound-audiences.ts for the full account).
 */
export async function buildOutboundAudience(db: Db, input: { campaign: string; limit?: number; at?: number }): Promise<OutboundContact[]> {
  const campaign = campaignByCode(input.campaign);
  if (!campaign) throw new Error(`Unknown outbound campaign: ${input.campaign}`);
  const builder = audienceBuilderFor(campaign.code);
  if (!builder) throw new Error(`Outbound campaign ${campaign.code} has no audience builder`);
  const at = input.at ?? Date.now();
  const limit = Math.max(1, Math.min(Number(input.limit) || 100, 5000));
  const rows = await builder(db, { limit, at });
  // Dedupe on the phone number, not the contact id: the same handset can appear under two contact rows
  // (a crm_contact and a canonical_customer), and dialling it twice for one campaign is the visible
  // failure. Applied here rather than per-builder so every campaign gets it for free.
  const seen = new Set<string>();
  return rows.filter(r => { const k = digits(r.phone); if (!k || k.length < 8 || seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}

export type WhatsAppOutcome = { status: "sent" | "skipped" | "refused"; reason?: string; messageId?: string; providerMessageId?: string | null };
export type OutboundResult = { connected: boolean; campaign: string; dialled: number; skipped: number; failed: number; audience: number; whatsappSent: number; whatsappSkipped: number; reason?: string; calls: Array<{ contactId: string; phone: string; status: string; callRef?: string; reason?: string; whatsapp?: WhatsAppOutcome }> };

/**
 * Send the campaign's WhatsApp message for one contact, through Interakt.
 *
 * Returns an outcome instead of throwing, because one contact's consent problem must not abort the
 * batch - a campaign of 500 where contact 3 has opted out has to keep going for the other 497.
 *
 * It does NOT weaken the Interakt ownership guard to make lead-based campaigns work. That guard needs
 * the contact to be a canonical customer (it verifies the phone against canonical_customers), and a
 * fresh CRM lead is not one yet. Rather than relax it - which would let a caller-supplied phone plus a
 * real id deliver somebody else's link - those contacts are skipped with an explicit reason. Voice
 * still reaches them; only the link-carrying message waits until they are a customer.
 */
async function sendCampaignWhatsApp(db: Db, env: HEnv, campaign: OutboundCampaign, contact: OutboundContact, actorId: string, at: number): Promise<WhatsAppOutcome> {
  const template = text(campaign.whatsappTemplate);
  if (!template) return { status: "skipped", reason: "campaign_is_voice_only" };
  if (!interaktEnabled(env)) return { status: "skipped", reason: "interakt_not_configured" };

  const canonical = await db.prepare("SELECT id FROM canonical_customers WHERE id=?").bind(contact.contactId).first<Row>().catch(() => null);
  if (!canonical) return { status: "skipped", reason: "contact_is_not_a_canonical_customer" };

  // The message is enqueued first so the send is traceable to a governed request, and so the outbox -
  // not this function - owns retry. The idempotency key is the same (campaign, contact, IST day) triple
  // the voice cap uses, so re-running the trigger cannot double-message either.
  const dayKey = new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10);
  const idempotencyKey = `wa:${campaign.code}:${contact.contactId}:${dayKey}`;
  let messageId: string;
  try {
    const queued = await enqueueCommunication(db, {
      customerId: contact.contactId, cityId: text(contact.context.cityId) || "blr",
      channel: "whatsapp", purpose: campaign.requiresMarketingConsent ? "marketing" : "lifecycle",
      idempotencyKey, templateKey: template,
      payload: { campaign: campaign.code, name: contact.name, ...contact.context },
      createdBy: actorId,
    }) as { duplicatePrevented: boolean; messageId?: string; message?: Row };
    if (queued.duplicatePrevented) return { status: "skipped", reason: "already_messaged_today" };
    messageId = String(queued.messageId ?? "");
    if (!messageId) return { status: "skipped", reason: "enqueue_returned_no_message_id" };
  } catch (error) {
    return { status: "skipped", reason: `enqueue_failed: ${error instanceof Error ? error.message : "unknown"}` };
  }

  try {
    const sent = await dispatchInteraktMessage(db, env, {
      messageId, customerId: contact.contactId, recipient: contact.phone,
      // Outside the 24-hour window by construction, so an approved template is mandatory. bodyValues
      // carry only the customer's own name - never another customer's data.
      send: { withinSession: false, templateKey: template, language: "en", bodyValues: [contact.name] },
    });
    return { status: sent.status === "sent" ? "sent" : "refused", reason: sent.reason, messageId, providerMessageId: sent.providerMessageId };
  } catch (error) {
    // A 403 (wrong number) or 409 (no consent) from the dispatcher is a per-contact refusal, recorded
    // and stepped over.
    return { status: "refused", reason: error instanceof Error ? error.message : "whatsapp_refused", messageId };
  }
}

/** Place outbound voice calls for a campaign - the human-launched action. Fail-closed + fully guardrailed. */
export async function triggerOutboundCampaign(db: Db, env: HEnv, input: { campaign: string; limit?: number; actorId: string; at?: number; force?: boolean }): Promise<OutboundResult> {
  await ensureHaptikOutboundTables(db);
  const campaign = campaignByCode(input.campaign);
  if (!campaign) throw new Error(`Unknown outbound campaign: ${input.campaign}`);
  const at = input.at ?? Date.now();
  const base: OutboundResult = { connected: false, campaign: campaign.code, dialled: 0, skipped: 0, failed: 0, audience: 0, whatsappSent: 0, whatsappSkipped: 0, calls: [] };
  if (!haptikOutboundConfigured(env)) return { ...base, reason: "Haptik outbound is not connected (HAPTIK_OUTBOUND_API_KEY / HAPTIK_OUTBOUND_URL not configured). No calls placed." };
  if (!input.force && isQuietHours(at)) return { ...base, connected: true, reason: "Quiet hours (21:00-09:00 IST): no outbound calls placed. Pass force to override for an urgent callback." };
  const audience = await buildOutboundAudience(db, { campaign: campaign.code, limit: input.limit, at });
  base.audience = audience.length;
  const dayKey = new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10);
  const capBefore = at - FREQUENCY_CAP_DAYS * DAY;
  const calls: OutboundResult["calls"] = [];
  let dialled = 0, skipped = 0, failed = 0, whatsappSent = 0, whatsappSkipped = 0;
  for (const c of audience) {
    const phone = digits(c.phone);
    // idempotency - one attempt per (campaign, contact, IST day). Catches same-day repeats even when the
    // earlier attempt FAILED (so we don't hammer a contact whose call errored), which the cap can't see.
    const key = `${campaign.code}:${c.contactId}:${dayKey}`;
    const already = await db.prepare("SELECT status FROM haptik_outbound_calls WHERE idempotency_key=?").bind(key).first<Row>().catch(() => null);
    if (already) { skipped++; calls.push({ contactId: c.contactId, phone, status: "skipped", reason: "already_dialled_today" }); continue; }
    // frequency cap - already successfully dialled within the 7-day window on ANY campaign
    const recent = await db.prepare("SELECT COUNT(*) n FROM haptik_outbound_calls WHERE phone=? AND status='dialled' AND created_at>?").bind(phone, capBefore).first<Row>().catch(() => null);
    if (recent && Number(recent.n) > 0) { skipped++; calls.push({ contactId: c.contactId, phone, status: "skipped", reason: "frequency_cap" }); continue; }
    const id = uid("HOC");
    const claim = await db.prepare("INSERT OR IGNORE INTO haptik_outbound_calls (id,idempotency_key,campaign,contact_id,phone,status,context_json,requested_by,created_at,updated_at) VALUES (?,?,?,?,?, 'pending',?,?,?,?)").bind(id, key, campaign.code, c.contactId, phone, JSON.stringify(c.context), input.actorId, at, at).run();
    if (Number(claim.meta?.changes || 0) === 0) { skipped++; calls.push({ contactId: c.contactId, phone, status: "skipped", reason: "already_dialled_today" }); continue; }
    const outcome = await triggerHaptikCall(env, { phone: c.phone, campaign: campaign.code, context: { ...c.context, name: c.name } });
    // The WhatsApp message is attempted whether or not the call connected. The two channels carry
    // different things - the call opens a conversation, the message carries the link the LOE needs - so
    // a failed dial must not also cost the customer their package/renewal link.
    const whatsapp = await sendCampaignWhatsApp(db, env, campaign, c, input.actorId, at);
    if (whatsapp.status === "sent") whatsappSent++; else whatsappSkipped++;
    if (outcome.connected) { dialled++; await db.prepare("UPDATE haptik_outbound_calls SET status='dialled',call_ref=?,updated_at=? WHERE id=?").bind(outcome.callRef, at, id).run(); calls.push({ contactId: c.contactId, phone, status: "dialled", callRef: outcome.callRef, whatsapp }); }
    else { failed++; await db.prepare("UPDATE haptik_outbound_calls SET status='failed',reason=?,updated_at=? WHERE id=?").bind(outcome.reason, at, id).run(); calls.push({ contactId: c.contactId, phone, status: "failed", reason: outcome.reason, whatsapp }); }
  }
  return { ...base, connected: true, dialled, skipped, failed, whatsappSent, whatsappSkipped, calls };
}

/** Scheduler sweep - refreshes audience READINESS counts only. It NEVER places a call (outreach is
 * always human-launched). No-op when outbound is not configured. Cold-DB safe. */
export async function runHaptikOutboundSweep(db: Db, input: { asOf?: number } = {}) {
  await ensureHaptikOutboundTables(db).catch(() => {});
  const at = input.asOf ?? Date.now();
  let env: HEnv = {};
  try { const mod = await import("cloudflare:workers"); env = (mod as unknown as { env: HEnv }).env || {}; } catch { env = {}; }
  const configured = haptikOutboundConfigured(env);
  const readiness: Array<{ campaign: string; ready: number }> = [];
  for (const c of HAPTIK_CAMPAIGNS) {
    const audience = await buildOutboundAudience(db, { campaign: c.code, limit: 5000, at }).catch(() => []);
    readiness.push({ campaign: c.code, ready: audience.length });
    await db.prepare("INSERT INTO haptik_outbound_readiness (campaign,ready_count,refreshed_at) VALUES (?,?,?) ON CONFLICT(campaign) DO UPDATE SET ready_count=excluded.ready_count,refreshed_at=excluded.refreshed_at").bind(c.code, audience.length, at).run().catch(() => {});
  }
  // deliberately does NOT dial - placing calls is a human-launched, permission-gated action.
  return { configured, dialled: 0, dialledSkippedReason: "outbound calling is human-launched only", readiness, refreshedAt: at };
}

/** Ops view: recent outbound call attempts (audit trail of who was called and the result). */
export async function listOutboundCalls(db: Db, input: { campaign?: string; limit?: number } = {}) {
  await ensureHaptikOutboundTables(db);
  const limit = Math.max(1, Math.min(Number(input.limit) || 200, 1000));
  const campaign = text(input.campaign);
  const rows = await db.prepare(`SELECT id,campaign,contact_id,phone,status,call_ref,reason,requested_by,created_at FROM haptik_outbound_calls WHERE (?='' OR campaign=?) ORDER BY created_at DESC LIMIT ${limit}`).bind(campaign, campaign).all<Row>().catch(empty);
  return rows.results.map((r: Row) => ({ id: String(r.id), campaign: String(r.campaign), contactId: String(r.contact_id), phone: String(r.phone), status: String(r.status), callRef: r.call_ref ? String(r.call_ref) : null, reason: r.reason ? String(r.reason) : null, requestedBy: String(r.requested_by), createdAt: Number(r.created_at) }));
}

/** Readiness snapshot for the ops dashboard - how many contacts are ready per campaign right now. */
export async function outboundReadiness(db: Db) {
  await ensureHaptikOutboundTables(db);
  const rows = await db.prepare("SELECT campaign,ready_count,refreshed_at FROM haptik_outbound_readiness").all<Row>().catch(empty);
  const by = new Map(rows.results.map(r => [String(r.campaign), r]));
  return HAPTIK_CAMPAIGNS.map(c => { const r = by.get(c.code); return { campaign: c.code, label: c.label, requiresMarketingConsent: c.requiresMarketingConsent, ready: r ? Number(r.ready_count) : 0, refreshedAt: r ? Number(r.refreshed_at) : null }; });
}
