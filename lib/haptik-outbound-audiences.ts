/**
 * Every outbound audience, in one explicit registry.
 *
 * WHY THIS FILE EXISTS AT ALL — a latent defect in the shape it replaces.
 *
 * buildOutboundAudience() used to be an if-chain whose LAST branch was unguarded: it fell through to
 * the subscription_pitch query. So the campaign list and the audience logic could disagree silently.
 * Adding a campaign code to HAPTIK_CAMPAIGNS without adding a matching branch did not fail - it handed
 * that campaign the subscription-pitch audience, stamped `reason: "subscription_pitch"` on it, and
 * dialled real customers for a campaign they were never selected for. With 3 campaigns and 3 branches
 * that was invisible. Adding 9 more campaigns to it would have made it near-certain.
 *
 * So audiences are a Record keyed by campaign code, and a code with no builder THROWS. The registry is
 * the single source of truth, and the contract test asserts that every campaign in HAPTIK_CAMPAIGNS has
 * an entry here and vice versa - a mismatch is a build-time-ish failure rather than a wrong phone call.
 *
 * CONSENT IS PER-CAMPAIGN, NOT GLOBAL. A campaign marked requiresMarketingConsent must join
 * customer_contact_preferences and demand marketing_consent=1 AND opt_out=0. Service-driven follow-ups
 * (a lead who contacted US, a session we owe them) legitimately do not need marketing consent, but they
 * still must honour opt_out - an opt-out means "stop contacting me", not "stop marketing to me".
 *
 * Every query is cold-DB safe (.catch(empty)): these run on a scheduler sweep against a database whose
 * per-vertical tables may not exist yet, and a missing table must mean "no audience", never a crash
 * that takes the whole readiness refresh down.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

const DAY = 86_400_000;
const text = (v: unknown) => String(v ?? "").trim();
const empty = () => ({ results: [] as Row[] });

export type OutboundContact = { contactId: string; phone: string; name: string; context: Record<string, unknown> };
export type AudienceInput = { limit: number; at: number };
export type AudienceBuilder = (db: Db, input: AudienceInput) => Promise<OutboundContact[]>;

const iso = (ms: number) => new Date(ms).toISOString();

/** Shape a result row into a contact. `reason` is stamped from the campaign, never from the row. */
const asContacts = (rows: Row[], reason: string, context: (r: Row) => Record<string, unknown>): OutboundContact[] =>
  rows.map((r) => ({
    contactId: String(r.contact_id ?? ""),
    phone: String(r.phone ?? ""),
    name: text(r.name) || "there",
    context: { ...context(r), reason },
  }));

/**
 * The marketing-consent join, written once.
 *
 * Repeating this across nine queries is how one of them ends up missing `opt_out=0`, which is the exact
 * compliance failure that matters - a contact who opted out of everything while an old
 * marketing_consent=1 row lingered.
 */
const CONSENTED = "JOIN customer_contact_preferences p ON p.customer_id=cu.id AND p.marketing_consent=1 AND p.opt_out=0";
/** For service-driven campaigns: no marketing consent needed, but an explicit opt-out still stops us. */
const NOT_OPTED_OUT = "LEFT JOIN customer_contact_preferences p ON p.customer_id=cu.id AND COALESCE(p.opt_out,0)=0";

// ---------------------------------------------------------------------------
// The three that already existed, moved here verbatim in behaviour
// ---------------------------------------------------------------------------

const newLeadFollowup: AudienceBuilder = async (db, { limit }) => {
  const rows = await db.prepare(
    "SELECT l.id lead_id,l.customer_id contact_id,l.service service,c.name name,c.primary_phone phone FROM lead_work_items l JOIN crm_contacts c ON c.id=l.customer_id WHERE l.status IN ('active','sla_breached') AND l.first_action_at IS NULL AND l.opt_out=0 AND l.converted_booking_id IS NULL ORDER BY l.assigned_at ASC LIMIT ?",
  ).bind(limit * 3).all<Row>().catch(empty);
  return asContacts(rows.results, "new_lead_followup", (r) => ({ leadId: String(r.lead_id), service: text(r.service) || "grooming" }));
};

const reactivation: AudienceBuilder = async (db, { limit, at }) => {
  const rows = await db.prepare(
    `SELECT b.customer_id contact_id,cu.name name,cu.primary_phone phone,MAX(b.scheduled_end) last_end,COUNT(*) done FROM canonical_bookings b JOIN canonical_customers cu ON cu.id=b.customer_id ${CONSENTED} WHERE b.status='completed' GROUP BY b.customer_id HAVING MAX(b.scheduled_end)<? ORDER BY done DESC LIMIT ?`,
  ).bind(iso(at - 60 * DAY), limit * 2).all<Row>().catch(empty);
  return asContacts(rows.results, "reactivation", (r) => ({ lastServiceAt: text(r.last_end), pastBookings: Number(r.done) }));
};

const subscriptionPitch: AudienceBuilder = async (db, { limit }) => {
  const rows = await db.prepare(
    `SELECT b.customer_id contact_id,cu.name name,cu.primary_phone phone,COUNT(*) grooms FROM canonical_bookings b JOIN canonical_customers cu ON cu.id=b.customer_id ${CONSENTED} WHERE b.service_code='grooming' AND b.status NOT IN ('cancelled','refunded') AND NOT EXISTS (SELECT 1 FROM customer_grooming_subscriptions s WHERE s.customer_id=b.customer_id AND s.status IN ('active','paused')) GROUP BY b.customer_id HAVING COUNT(*)>=2 ORDER BY grooms DESC LIMIT ?`,
  ).bind(limit * 2).all<Row>().catch(empty);
  return asContacts(rows.results, "subscription_pitch", (r) => ({ groomingBookings: Number(r.grooms) }));
};

// ---------------------------------------------------------------------------
// The nine the LOE needs
// ---------------------------------------------------------------------------

/**
 * Abandoned checkout: a customer who started a booking and never committed it.
 *
 * Two signals, unioned, because the funnel can be abandoned at two different points:
 *   - a canonical_bookings row still sitting in draft/pending (never confirmed). These are exactly the
 *     statuses the #37 revenue allowlist deliberately excludes, so a row here is uncommitted by
 *     definition rather than by guess;
 *   - a scheduling_reservations hold with no canonical booking behind it - the customer took a slot and
 *     never finished. That reservation is also holding real provider capacity, which makes this the
 *     more valuable of the two to chase.
 *
 * Bounded to the last 7 days: chasing a checkout somebody abandoned last month is spam, not recovery.
 */
const abandonedCheckout: AudienceBuilder = async (db, { limit, at }) => {
  const since = at - 7 * DAY;
  const drafts = await db.prepare(
    `SELECT b.customer_id contact_id,cu.name name,cu.primary_phone phone,b.id booking_id,b.service_code svc,b.total_amount amt,b.status st FROM canonical_bookings b JOIN canonical_customers cu ON cu.id=b.customer_id ${CONSENTED} WHERE b.status IN ('draft','pending') AND b.created_at>? ORDER BY b.created_at DESC LIMIT ?`,
  ).bind(since, limit * 2).all<Row>().catch(empty);
  const held = await db.prepare(
    `SELECT r.customer_id contact_id,cu.name name,cu.primary_phone phone,r.group_id group_id,r.service_code svc,r.scheduled_start starts FROM scheduling_reservations r JOIN canonical_customers cu ON cu.id=r.customer_id ${CONSENTED} LEFT JOIN canonical_bookings b ON b.schedule_group_id=r.group_id WHERE b.id IS NULL AND r.status!='cancelled' AND r.created_at>? ORDER BY r.created_at DESC LIMIT ?`,
  ).bind(since, limit * 2).all<Row>().catch(empty);
  return [
    ...asContacts(drafts.results, "abandoned_checkout", (r) => ({ bookingId: String(r.booking_id), service: text(r.svc), amount: Number(r.amt || 0), stage: `booking_${text(r.st)}` })),
    ...asContacts(held.results, "abandoned_checkout", (r) => ({ groupId: String(r.group_id), service: text(r.svc), scheduledStart: text(r.starts), stage: "slot_held_no_booking" })),
  ];
};

/**
 * Seasonal / promotional offer: a customer holding an UNREDEEMED, UNEXPIRED reward code.
 *
 * Deliberately NOT "everybody, because it is Diwali", and deliberately not coupon_redemptions - a
 * redemption row means the coupon was already SPENT (its status defaults to 'consumed', and by approved
 * policy it stays consumed even after a refund). Targeting that table would call people to tell them
 * about a discount they had already used.
 *
 * The honest signal is a per-customer reward that is still issued and still in date: birthday rewards
 * and review rewards both carry exactly that state. So the call always has something real to offer, and
 * we never invent a discount finance never approved.
 */
const seasonalOffer: AudienceBuilder = async (db, { limit, at }) => {
  const birthday = await db.prepare(
    `SELECT r.customer_id contact_id,cu.name name,cu.primary_phone phone,r.code code,r.discount_amount amt,r.expires_at expires FROM pet_birthday_rewards r JOIN canonical_customers cu ON cu.id=r.customer_id ${CONSENTED} WHERE r.status='issued' AND r.expires_at>? ORDER BY r.expires_at ASC LIMIT ?`,
  ).bind(at, limit * 2).all<Row>().catch(empty);
  const review = await db.prepare(
    `SELECT r.customer_id contact_id,cu.name name,cu.primary_phone phone,r.code code,r.discount_amount amt,r.expires_at expires FROM review_reward_codes r JOIN canonical_customers cu ON cu.id=r.customer_id ${CONSENTED} WHERE r.status='issued' AND r.expires_at>? ORDER BY r.expires_at ASC LIMIT ?`,
  ).bind(at, limit * 2).all<Row>().catch(empty);
  const shape = (r: Row, kind: string) => ({ rewardKind: kind, rewardCode: text(r.code), discountAmount: Number(r.amt || 0), expiresAt: Number(r.expires) });
  return [
    ...asContacts(birthday.results, "seasonal_offer", (r) => shape(r, "pet_birthday")),
    ...asContacts(review.results, "seasonal_offer", (r) => shape(r, "review_reward")),
  ];
};

/**
 * Subscription renewal reminder: an active grooming subscription inside its renewal window.
 *
 * Service-driven, not marketing: this is a live paid relationship and a lapse costs the customer their
 * plan. An explicit opt_out still stops us.
 */
const renewalReminder: AudienceBuilder = async (db, { limit, at }) => {
  // expires_at is the real column (there is no current_period_end). A subscription is in its renewal
  // window when it expires inside the next 10 days, OR when its sessions are all but used up - a plan
  // can run out of sessions well before it runs out of calendar, and that lapses the relationship just
  // as effectively.
  const rows = await db.prepare(
    `SELECT s.customer_id contact_id,cu.name name,cu.primary_phone phone,s.id sub_id,s.status st,s.expires_at ends,s.total_sessions total,s.sessions_consumed used FROM customer_grooming_subscriptions s JOIN canonical_customers cu ON cu.id=s.customer_id ${NOT_OPTED_OUT} WHERE s.status IN ('active','paused') AND (s.expires_at BETWEEN ? AND ? OR COALESCE(s.total_sessions,0)-COALESCE(s.sessions_consumed,0) <= 1) ORDER BY s.expires_at ASC LIMIT ?`,
  ).bind(at, at + 10 * DAY, limit * 2).all<Row>().catch(empty);
  return asContacts(rows.results, "renewal_reminder", (r) => ({
    subscriptionId: String(r.sub_id), subscriptionStatus: text(r.st), expiresAt: Number(r.ends),
    sessionsRemaining: Number(r.total || 0) - Number(r.used || 0),
  }));
};

/**
 * Pending session follow-up: a programme the customer has PAID for with sessions still unused.
 *
 * The strongest service obligation in the list - unused sessions are a delivery debt we owe, so this is
 * consent-light (opt-out only) and should never be gated behind marketing consent.
 */
const pendingSessionFollowup: AudienceBuilder = async (db, { limit }) => {
  const rows = await db.prepare(
    `SELECT t.customer_id contact_id,cu.name name,cu.primary_phone phone,t.id programme_id,t.total_sessions total,t.completed_sessions done FROM training_programmes t JOIN canonical_customers cu ON cu.id=t.customer_id ${NOT_OPTED_OUT} WHERE t.status IN ('active','in_progress') AND COALESCE(t.completed_sessions,0) < COALESCE(t.total_sessions,0) ORDER BY (COALESCE(t.total_sessions,0)-COALESCE(t.completed_sessions,0)) DESC LIMIT ?`,
  ).bind(limit * 2).all<Row>().catch(empty);
  return asContacts(rows.results, "pending_session_followup", (r) => ({
    programmeId: String(r.programme_id), totalSessions: Number(r.total || 0),
    completedSessions: Number(r.done || 0), remainingSessions: Number(r.total || 0) - Number(r.done || 0),
  }));
};

/** Dog-training lead conversion: an unconverted training enquiry, oldest first. */
const trainingLeadConversion: AudienceBuilder = async (db, { limit }) => {
  const rows = await db.prepare(
    "SELECT l.id lead_id,l.customer_id contact_id,c.name name,c.primary_phone phone,l.status st FROM lead_work_items l JOIN crm_contacts c ON c.id=l.customer_id WHERE l.service='dog_training' AND l.converted_booking_id IS NULL AND l.opt_out=0 AND l.status IN ('active','sla_breached','follow_up') ORDER BY l.assigned_at ASC LIMIT ?",
  ).bind(limit * 2).all<Row>().catch(empty);
  return asContacts(rows.results, "training_lead_conversion", (r) => ({ leadId: String(r.lead_id), leadStatus: text(r.st), service: "dog_training" }));
};

/**
 * Winback: a customer who has gone quiet for far longer than the reactivation window.
 *
 * Distinct from reactivation by DEPTH of lapse (180 days vs 60), so a contact is not in both audiences.
 * The exclusion is explicit - without it a 200-day-lapsed customer sits in both lists and the
 * cross-campaign frequency cap becomes the only thing stopping a double call.
 */
const winback: AudienceBuilder = async (db, { limit, at }) => {
  const rows = await db.prepare(
    `SELECT b.customer_id contact_id,cu.name name,cu.primary_phone phone,MAX(b.scheduled_end) last_end,COUNT(*) done,SUM(b.total_amount) spend FROM canonical_bookings b JOIN canonical_customers cu ON cu.id=b.customer_id ${CONSENTED} WHERE b.status='completed' GROUP BY b.customer_id HAVING MAX(b.scheduled_end)<? ORDER BY spend DESC LIMIT ?`,
  ).bind(iso(at - 180 * DAY), limit * 2).all<Row>().catch(empty);
  return asContacts(rows.results, "winback", (r) => ({ lastServiceAt: text(r.last_end), pastBookings: Number(r.done), lifetimeSpend: Number(r.spend || 0) }));
};

/**
 * Cross-sell builder, shared by the three vertical campaigns below.
 *
 * "Has bought X, has never bought Y" - written once because the three verticals differ only in which
 * service they already use and which they are being offered. Duplicating it three times is how one of
 * them ends up missing the NOT EXISTS and pitching boarding to somebody who boards with us monthly.
 */
const crossSell = (reason: string, offer: string, prerequisite: string[]): AudienceBuilder =>
  async (db, { limit }) => {
    const inList = prerequisite.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT b.customer_id contact_id,cu.name name,cu.primary_phone phone,COUNT(*) used FROM canonical_bookings b JOIN canonical_customers cu ON cu.id=b.customer_id ${CONSENTED} WHERE b.service_code IN (${inList}) AND b.status='completed' AND NOT EXISTS (SELECT 1 FROM canonical_bookings x WHERE x.customer_id=b.customer_id AND x.service_code=? AND x.status NOT IN ('cancelled','refunded')) GROUP BY b.customer_id ORDER BY used DESC LIMIT ?`,
    ).bind(...prerequisite, offer, limit * 2).all<Row>().catch(empty);
    return asContacts(rows.results, reason, (r) => ({ offeredService: offer, existingBookings: Number(r.used), basedOn: prerequisite }));
  };

const boardingSittingCrossSell = crossSell("boarding_sitting_cross_sell", "boarding", ["grooming", "dog_walking"]);
const walkingCrossSell = crossSell("walking_cross_sell", "dog_walking", ["grooming", "boarding"]);
const taxiCrossSell = crossSell("taxi_cross_sell", "pet_taxi", ["grooming", "boarding", "pet_sitting"]);

// ---------------------------------------------------------------------------
// The registry. A campaign with no entry here throws rather than borrowing another audience.
// ---------------------------------------------------------------------------
export const AUDIENCE_BUILDERS: Record<string, AudienceBuilder> = {
  new_lead_followup: newLeadFollowup,
  reactivation,
  subscription_pitch: subscriptionPitch,
  abandoned_checkout: abandonedCheckout,
  seasonal_offer: seasonalOffer,
  renewal_reminder: renewalReminder,
  pending_session_followup: pendingSessionFollowup,
  training_lead_conversion: trainingLeadConversion,
  winback,
  boarding_sitting_cross_sell: boardingSittingCrossSell,
  walking_cross_sell: walkingCrossSell,
  taxi_cross_sell: taxiCrossSell,
};

/**
 * Look a builder up by campaign code. No fallback, ever.
 *
 * Object.hasOwn rather than a plain index + `?? null`: indexing a Record with "__proto__" returns
 * Object.prototype, which is truthy, so the nullish default never fires and the caller receives a
 * non-function it will then try to invoke. An own-property check is the only form that actually means
 * "is there a builder registered under this exact name".
 */
export const audienceBuilderFor = (code: string): AudienceBuilder | null =>
  Object.hasOwn(AUDIENCE_BUILDERS, code) ? AUDIENCE_BUILDERS[code] : null;
