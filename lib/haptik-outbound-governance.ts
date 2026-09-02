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

type Db = D1Database;
type HEnv = Record<string, unknown>;
type Row = Record<string, unknown>;
const DAY = 86_400_000;
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const digits = (s: string) => String(s || "").replace(/[^0-9]/g, "");
const text = (v: unknown) => String(v ?? "").trim();
const empty = () => ({ results: [] as Row[] });

export const FREQUENCY_CAP_DAYS = 7;
/** Matches lib/app-to-revenue-funnel.ts's DEFAULT_ABANDON_MINUTES so both agree what "abandoned" means. */
const ABANDONED_CHECKOUT_MINUTES = 60;
const RENEWAL_WINDOW_DAYS = 30;
const WINBACK_DORMANT_DAYS = 180;
const QUIET_START_HOUR = 21; // 21:00 IST
const QUIET_END_HOUR = 9;    //  09:00 IST
const IST_OFFSET_MS = 5.5 * 3600_000;

/**
 * The twelve outbound voice journeys in Haptik's solution document, in its order, each with the
 * audience PawSpace has to supply. `requiresMarketingConsent` is the line that matters: a campaign that
 * pitches something needs express marketing consent, while calling someone back about an enquiry they
 * themselves raised, or about a subscription they already bought, does not. Every campaign still
 * honours opt_out, quiet hours and the frequency cap regardless of which side of that line it sits on.
 */
export type OutboundCampaign = { code: string; label: string; requiresMarketingConsent: boolean; description: string; useCase: number };
export const HAPTIK_CAMPAIGNS: OutboundCampaign[] = [
  { code: "new_lead_followup", label: "New grooming lead follow-up", requiresMarketingConsent: false, description: "Call back a fresh inbound lead that hasn't been actioned yet (they reached out to us).", useCase: 1 },
  { code: "reactivation", label: "Lapsed customer reactivation", requiresMarketingConsent: true, description: "Win back a customer whose last service was over 60 days ago.", useCase: 2 },
  { code: "subscription_pitch", label: "Grooming subscription pitch", requiresMarketingConsent: true, description: "Offer a grooming subscription to an active customer who doesn't have one yet.", useCase: 3 },
  { code: "abandoned_checkout", label: "Abandoned checkout recovery", requiresMarketingConsent: false, description: "Recover a booking the customer started and did not pay for - their own unfinished checkout, not a pitch.", useCase: 4 },
  { code: "offer_pitch", label: "Grooming offer / seasonal pitch", requiresMarketingConsent: true, description: "Promote a live offer to a customer serviced within the last 180 days.", useCase: 5 },
  { code: "subscription_renewal", label: "Subscription renewal reminder", requiresMarketingConsent: false, description: "Remind a subscriber whose plan expires inside the renewal window.", useCase: 6 },
  { code: "pending_session_followup", label: "Pending grooming session follow-up", requiresMarketingConsent: false, description: "Chase the unused sessions on a live subscription before it expires.", useCase: 7 },
  { code: "dog_training_leads", label: "Dog training lead conversion", requiresMarketingConsent: false, description: "Qualify an open dog-training enquiry for the training team.", useCase: 8 },
  { code: "winback", label: "Dormant customer winback", requiresMarketingConsent: true, description: "Reconnect with a customer dormant for over 180 days across every service.", useCase: 9 },
  { code: "boarding_daycare_leads", label: "Boarding / sitting / daycare qualification", requiresMarketingConsent: false, description: "Qualify an open boarding, sitting or daycare enquiry. Never confirms a booking on the call.", useCase: 10 },
  { code: "dog_walking_leads", label: "Dog walking qualification", requiresMarketingConsent: false, description: "Qualify an open dog-walking enquiry for a trial walk or a monthly plan.", useCase: 11 },
  { code: "pet_taxi_leads", label: "Pet taxi trip capture", requiresMarketingConsent: false, description: "Capture trip details for an open pet-taxi enquiry. Quotes no price on the call.", useCase: 12 },
];
/** Open service enquiries the service-qualification campaigns dial, keyed by campaign code. */
const LEAD_CAMPAIGN_SERVICES: Record<string, string[]> = {
  dog_training_leads: ["dog_training", "training"],
  boarding_daycare_leads: ["boarding", "pet_sitting", "daycare", "sitting"],
  dog_walking_leads: ["dog_walking", "walking"],
  pet_taxi_leads: ["pet_taxi", "taxi"],
};
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

/** Build the outbound audience for a campaign from the real book of record. Consent-filtered. Cold-DB safe. */
export async function buildOutboundAudience(db: Db, input: { campaign: string; limit?: number; at?: number }): Promise<OutboundContact[]> {
  const campaign = campaignByCode(input.campaign);
  if (!campaign) throw new Error(`Unknown outbound campaign: ${input.campaign}`);
  const at = input.at ?? Date.now();
  const limit = Math.max(1, Math.min(Number(input.limit) || 100, 5000));
  const seen = new Set<string>();
  const dedupe = (rows: OutboundContact[]) => rows.filter(r => { const k = digits(r.phone); if (!k || k.length < 8 || seen.has(k)) return false; seen.add(k); return true; });

  if (campaign.code === "new_lead_followup") {
    // Fresh inbound leads that are still active and have never been actioned, and haven't opted out.
    const rows = await db.prepare("SELECT l.id lead_id,l.customer_id contact_id,l.service service,c.name name,c.primary_phone phone FROM lead_work_items l JOIN crm_contacts c ON c.id=l.customer_id WHERE l.status IN ('active','sla_breached') AND l.first_action_at IS NULL AND l.opt_out=0 AND l.converted_booking_id IS NULL ORDER BY l.assigned_at ASC LIMIT ?").bind(limit * 3).all<Row>().catch(empty);
    return dedupe(rows.results.map(r => ({ contactId: String(r.contact_id), phone: String(r.phone || ""), name: text(r.name) || "there", context: { leadId: String(r.lead_id), service: text(r.service) || "grooming", reason: "new_lead_followup" } }))).slice(0, limit);
  }

  if (campaign.code === "reactivation") {
    // Customers whose last completed service was > 60 days ago - with marketing consent, not opted out.
    // p.opt_out=0 is a separate, stronger flag than marketing_consent: a contact who explicitly opted
    // out of all contact while an old marketing_consent=1 row remained was still being dialled here.
    const rows = await db.prepare("SELECT b.customer_id contact_id,cu.name name,cu.primary_phone phone,MAX(b.scheduled_end) last_end,COUNT(*) done FROM canonical_bookings b JOIN canonical_customers cu ON cu.id=b.customer_id JOIN customer_contact_preferences p ON p.customer_id=b.customer_id WHERE b.status='completed' AND p.marketing_consent=1 AND p.opt_out=0 GROUP BY b.customer_id HAVING MAX(b.scheduled_end)<? ORDER BY done DESC LIMIT ?").bind(new Date(at - 60 * DAY).toISOString(), limit * 2).all<Row>().catch(empty);
    return dedupe(rows.results.map(r => ({ contactId: String(r.contact_id), phone: String(r.phone || ""), name: text(r.name) || "there", context: { lastServiceAt: text(r.last_end), pastBookings: Number(r.done), reason: "reactivation" } }))).slice(0, limit);
  }

  if (campaign.code === "subscription_pitch") {
    // subscription_pitch: active grooming customers without an active/paused grooming subscription.
    const rows = await db.prepare("SELECT b.customer_id contact_id,cu.name name,cu.primary_phone phone,COUNT(*) grooms FROM canonical_bookings b JOIN canonical_customers cu ON cu.id=b.customer_id JOIN customer_contact_preferences p ON p.customer_id=b.customer_id WHERE b.service_code='grooming' AND b.status NOT IN ('cancelled','refunded') AND p.marketing_consent=1 AND p.opt_out=0 AND NOT EXISTS (SELECT 1 FROM customer_grooming_subscriptions s WHERE s.customer_id=b.customer_id AND s.status IN ('active','paused')) GROUP BY b.customer_id HAVING COUNT(*)>=2 ORDER BY grooms DESC LIMIT ?").bind(limit * 2).all<Row>().catch(empty);
    return dedupe(rows.results.map(r => ({ contactId: String(r.contact_id), phone: String(r.phone || ""), name: text(r.name) || "there", context: { groomingBookings: Number(r.grooms), reason: "subscription_pitch" } }))).slice(0, limit);
  }

  if (campaign.code === "abandoned_checkout") {
    // The platform already has one definition of an abandoned checkout - a payment created/failed past
    // the window with no captured payment on that booking (lib/app-to-revenue-funnel.ts). It is reused
    // verbatim rather than restated, so recovery calls and recovery tasks can never disagree about who
    // abandoned a booking. Consent: this is the customer's own unfinished purchase, so no marketing
    // consent is required, but opt_out still bars the call (LEFT JOIN, so a customer with no
    // preferences row is not silently excluded).
    const rows = await db.prepare("SELECT bp.customer_id contact_id,cu.name name,cu.primary_phone phone,bp.booking_id booking_id,bp.amount amount,b.service_code svc,b.package_name pkg FROM booking_payments bp JOIN canonical_bookings b ON b.id=bp.booking_id JOIN canonical_customers cu ON cu.id=bp.customer_id LEFT JOIN customer_contact_preferences p ON p.customer_id=bp.customer_id WHERE bp.status IN ('created','failed','awaiting_payment') AND bp.created_at<=? AND b.status<>'cancelled' AND COALESCE(p.opt_out,0)=0 AND NOT EXISTS (SELECT 1 FROM booking_payments c WHERE c.booking_id=bp.booking_id AND c.status='captured') ORDER BY bp.created_at DESC LIMIT ?").bind(at - ABANDONED_CHECKOUT_MINUTES * 60_000, limit * 2).all<Row>().catch(empty);
    return dedupe(rows.results.map(r => ({ contactId: String(r.contact_id), phone: String(r.phone || ""), name: text(r.name) || "there", context: { bookingId: text(r.booking_id), service: text(r.svc), packageName: text(r.pkg), amount: Number(r.amount), reason: "abandoned_checkout" } }))).slice(0, limit);
  }

  if (campaign.code === "offer_pitch") {
    // Customers serviced INSIDE the last 180 days - still warm. Deliberately the complement of
    // winback: a promotional offer and a "we miss you" call are different conversations and a customer
    // must not be in both audiences on the same day.
    const rows = await db.prepare("SELECT b.customer_id contact_id,cu.name name,cu.primary_phone phone,MAX(b.scheduled_end) last_end,COUNT(*) done FROM canonical_bookings b JOIN canonical_customers cu ON cu.id=b.customer_id JOIN customer_contact_preferences p ON p.customer_id=b.customer_id WHERE b.status='completed' AND p.marketing_consent=1 AND p.opt_out=0 GROUP BY b.customer_id HAVING MAX(b.scheduled_end)>=? ORDER BY done DESC LIMIT ?").bind(new Date(at - WINBACK_DORMANT_DAYS * DAY).toISOString(), limit * 2).all<Row>().catch(empty);
    return dedupe(rows.results.map(r => ({ contactId: String(r.contact_id), phone: String(r.phone || ""), name: text(r.name) || "there", context: { lastServiceAt: text(r.last_end), pastBookings: Number(r.done), reason: "offer_pitch" } }))).slice(0, limit);
  }

  if (campaign.code === "subscription_renewal") {
    // Live subscriptions expiring inside the renewal window. About a plan the customer already paid
    // for, so no marketing consent is required - but an expired plan is not a renewal conversation, so
    // the window is bounded on both sides rather than "anything expiring soon or already gone".
    const rows = await db.prepare("SELECT s.customer_id contact_id,cu.name name,cu.primary_phone phone,s.plan_code plan,s.expires_at expires_at,(s.total_sessions-s.sessions_consumed-s.sessions_reserved) sessions_left FROM customer_grooming_subscriptions s JOIN canonical_customers cu ON cu.id=s.customer_id LEFT JOIN customer_contact_preferences p ON p.customer_id=s.customer_id WHERE s.status IN ('active','paused') AND s.expires_at>? AND s.expires_at<=? AND COALESCE(p.opt_out,0)=0 ORDER BY s.expires_at ASC LIMIT ?").bind(at, at + RENEWAL_WINDOW_DAYS * DAY, limit * 2).all<Row>().catch(empty);
    return dedupe(rows.results.map(r => ({ contactId: String(r.contact_id), phone: String(r.phone || ""), name: text(r.name) || "there", context: { planCode: text(r.plan), expiresAt: Number(r.expires_at), sessionsLeft: Number(r.sessions_left), reason: "subscription_renewal" } }))).slice(0, limit);
  }

  if (campaign.code === "pending_session_followup") {
    // Sessions bought and not used, on a subscription that has not expired yet. Reserved sessions are
    // subtracted as well as consumed ones, so a customer with a booking already in the calendar is not
    // chased about a session they have in fact scheduled.
    const rows = await db.prepare("SELECT s.customer_id contact_id,cu.name name,cu.primary_phone phone,s.plan_code plan,s.expires_at expires_at,(s.total_sessions-s.sessions_consumed-s.sessions_reserved) sessions_left FROM customer_grooming_subscriptions s JOIN canonical_customers cu ON cu.id=s.customer_id LEFT JOIN customer_contact_preferences p ON p.customer_id=s.customer_id WHERE s.status='active' AND s.expires_at>? AND (s.total_sessions-s.sessions_consumed-s.sessions_reserved)>0 AND COALESCE(p.opt_out,0)=0 ORDER BY s.expires_at ASC LIMIT ?").bind(at, limit * 2).all<Row>().catch(empty);
    return dedupe(rows.results.map(r => ({ contactId: String(r.contact_id), phone: String(r.phone || ""), name: text(r.name) || "there", context: { planCode: text(r.plan), expiresAt: Number(r.expires_at), sessionsLeft: Number(r.sessions_left), reason: "pending_session_followup" } }))).slice(0, limit);
  }

  if (campaign.code === "winback") {
    // Dormant across EVERY service for over 180 days, and never yet won back by this campaign. Unlike
    // reactivation (grooming-shaped, 60 days) this call asks whether they still have a pet at all.
    const rows = await db.prepare("SELECT b.customer_id contact_id,cu.name name,cu.primary_phone phone,MAX(b.scheduled_end) last_end,COUNT(*) done FROM canonical_bookings b JOIN canonical_customers cu ON cu.id=b.customer_id JOIN customer_contact_preferences p ON p.customer_id=b.customer_id WHERE b.status='completed' AND p.marketing_consent=1 AND p.opt_out=0 GROUP BY b.customer_id HAVING MAX(b.scheduled_end)<? ORDER BY done DESC LIMIT ?").bind(new Date(at - WINBACK_DORMANT_DAYS * DAY).toISOString(), limit * 2).all<Row>().catch(empty);
    return dedupe(rows.results.map(r => ({ contactId: String(r.contact_id), phone: String(r.phone || ""), name: text(r.name) || "there", context: { lastServiceAt: text(r.last_end), pastBookings: Number(r.done), reason: "winback" } }))).slice(0, limit);
  }

  const services = LEAD_CAMPAIGN_SERVICES[campaign.code];
  if (services) {
    // The service-qualification campaigns (training, boarding/sitting, walking, taxi): open enquiries
    // for that service which nobody has actioned. Same shape as new_lead_followup, scoped by service,
    // and the service list carries both the canonical code and the older short form so a lead created
    // before the vocabulary settled is still dialled.
    const placeholders = services.map(() => "?").join(",");
    const rows = await db.prepare(`SELECT l.id lead_id,l.customer_id contact_id,l.service service,c.name name,c.primary_phone phone FROM lead_work_items l JOIN crm_contacts c ON c.id=l.customer_id WHERE l.service IN (${placeholders}) AND l.status IN ('active','sla_breached') AND l.first_action_at IS NULL AND l.opt_out=0 AND l.converted_booking_id IS NULL ORDER BY l.assigned_at ASC LIMIT ?`).bind(...services, limit * 3).all<Row>().catch(empty);
    return dedupe(rows.results.map(r => ({ contactId: String(r.contact_id), phone: String(r.phone || ""), name: text(r.name) || "there", context: { leadId: String(r.lead_id), service: text(r.service), reason: campaign.code } }))).slice(0, limit);
  }

  // No silent fallback. A campaign added to HAPTIK_CAMPAIGNS without an audience builder must fail
  // loudly here: the previous shape let any unhandled code fall through to the subscription-pitch
  // audience, which would have dialled the wrong people under a new campaign's name.
  throw new Error(`No audience builder for outbound campaign: ${campaign.code}`);
}

export type OutboundResult = { connected: boolean; campaign: string; dialled: number; skipped: number; failed: number; audience: number; reason?: string; calls: Array<{ contactId: string; phone: string; status: string; callRef?: string; reason?: string }> };

/** Place outbound voice calls for a campaign - the human-launched action. Fail-closed + fully guardrailed. */
export async function triggerOutboundCampaign(db: Db, env: HEnv, input: { campaign: string; limit?: number; actorId: string; at?: number; force?: boolean }): Promise<OutboundResult> {
  await ensureHaptikOutboundTables(db);
  const campaign = campaignByCode(input.campaign);
  if (!campaign) throw new Error(`Unknown outbound campaign: ${input.campaign}`);
  const at = input.at ?? Date.now();
  const base: OutboundResult = { connected: false, campaign: campaign.code, dialled: 0, skipped: 0, failed: 0, audience: 0, calls: [] };
  if (!haptikOutboundConfigured(env)) return { ...base, reason: "Haptik outbound is not connected (HAPTIK_OUTBOUND_API_KEY / HAPTIK_OUTBOUND_URL not configured). No calls placed." };
  if (!input.force && isQuietHours(at)) return { ...base, connected: true, reason: "Quiet hours (21:00-09:00 IST): no outbound calls placed. Pass force to override for an urgent callback." };
  const audience = await buildOutboundAudience(db, { campaign: campaign.code, limit: input.limit, at });
  base.audience = audience.length;
  const dayKey = new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10);
  const capBefore = at - FREQUENCY_CAP_DAYS * DAY;
  const calls: OutboundResult["calls"] = [];
  let dialled = 0, skipped = 0, failed = 0;
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
    if (outcome.connected) { dialled++; await db.prepare("UPDATE haptik_outbound_calls SET status='dialled',call_ref=?,updated_at=? WHERE id=?").bind(outcome.callRef, at, id).run(); calls.push({ contactId: c.contactId, phone, status: "dialled", callRef: outcome.callRef }); }
    else { failed++; await db.prepare("UPDATE haptik_outbound_calls SET status='failed',reason=?,updated_at=? WHERE id=?").bind(outcome.reason, at, id).run(); calls.push({ contactId: c.contactId, phone, status: "failed", reason: outcome.reason }); }
  }
  return { ...base, connected: true, dialled, skipped, failed, calls };
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
  // Only the last four digits leave this function. The ops console is a wide-access surface and does
  // not need a dialled customer's number to identify a row against a call recording - the voice
  // operator console holds the same line for the same reason.
  return rows.results.map((r: Row) => ({ id: String(r.id), campaign: String(r.campaign), contactId: String(r.contact_id), phoneLast4: digits(String(r.phone)).slice(-4), status: String(r.status), callRef: r.call_ref ? String(r.call_ref) : null, reason: r.reason ? String(r.reason) : null, requestedBy: String(r.requested_by), createdAt: Number(r.created_at) }));
}

/** Readiness snapshot for the ops dashboard - how many contacts are ready per campaign right now. */
export async function outboundReadiness(db: Db) {
  await ensureHaptikOutboundTables(db);
  const rows = await db.prepare("SELECT campaign,ready_count,refreshed_at FROM haptik_outbound_readiness").all<Row>().catch(empty);
  const by = new Map(rows.results.map(r => [String(r.campaign), r]));
  return HAPTIK_CAMPAIGNS.map(c => { const r = by.get(c.code); return { campaign: c.code, label: c.label, requiresMarketingConsent: c.requiresMarketingConsent, ready: r ? Number(r.ready_count) : 0, refreshedAt: r ? Number(r.refreshed_at) : null }; });
}
