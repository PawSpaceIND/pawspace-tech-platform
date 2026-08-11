/**
 * Service review collection + public-review rewards, driven by the per-service Control config
 * (review-configuration-governance.ts).
 *
 * Flow: a completed service triggers a review request (respecting the config's cadence - every
 * service, or once per N sessions e.g. training every 3) on the configured channels. The customer
 * submits the review; a 5-star rating surfaces the Google + app review links. If the customer then
 * confirms they posted a public review, they earn a reward:
 *   - 1 public review on an order  -> Rs.250 coupon (any service)
 *   - both platforms on the same order -> an extra Rs.400 flat off the next grooming order
 * Rewards are single-use, expiring, redeemed against a real customer-owned booking.
 *
 * Tracking honesty: we cannot programmatically confirm a Google/app review without those platforms'
 * APIs (not connected), so a claim is 'self_declared'. verifyPublicReview lets staff mark a claim
 * verified (or it can be reconciled later); the reward is issued on claim to keep the delight
 * instant, but every claim is recorded and auditable.
 */

import { getActiveReviewConfig, DEFAULT_SINGLE_REVIEW_DISCOUNT, DEFAULT_DOUBLE_REVIEW_DISCOUNT, DEFAULT_GOOGLE_REVIEW_LINK, DEFAULT_APP_REVIEW_LINK } from "./review-configuration-governance";

type Db = D1Database;
type Row = Record<string, unknown>;

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const REWARD_VALID_DAYS = 60;
const PLATFORMS = ["google", "app"];

export async function ensureServiceReviewTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS review_requests (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,service_code TEXT NOT NULL,customer_id TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,questions_json TEXT NOT NULL,channels_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'sent',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS service_reviews (id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,stars INTEGER NOT NULL,answers_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS review_public_claims (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,platform TEXT NOT NULL,verification_status TEXT NOT NULL DEFAULT 'self_declared',reward_code TEXT,created_at INTEGER NOT NULL,UNIQUE(booking_id,platform))"),
    db.prepare("CREATE TABLE IF NOT EXISTS review_reward_codes (code TEXT PRIMARY KEY,customer_id TEXT NOT NULL,reward_kind TEXT NOT NULL,discount_amount REAL NOT NULL,service_scope TEXT NOT NULL DEFAULT 'any',status TEXT NOT NULL DEFAULT 'issued',source_booking_id TEXT,expires_at INTEGER NOT NULL,redeemed_booking_id TEXT,redeemed_at INTEGER,created_at INTEGER NOT NULL)"),
  ]);
}

/**
 * Raise a review request for a completed service, respecting the service's configured cadence.
 * For every_n_sessions services (e.g. training every 3), pass completedSessionCount. Idempotent.
 */
export async function requestServiceReview(db: Db, input: { bookingId: string; serviceCode: string; customerId: string; completedSessionCount?: number }) {
  await ensureServiceReviewTables(db);
  const config = await getActiveReviewConfig(db, input.serviceCode);
  if (!config) return { requested: false, reason: "no_active_review_config" };
  let sequence = 1;
  if (config.triggerType === "every_n_sessions") {
    const done = Number(input.completedSessionCount || 0), n = Math.max(1, config.triggerInterval);
    if (done <= 0 || done % n !== 0) return { requested: false, reason: "cadence_not_reached", completedSessionCount: done, interval: n };
    sequence = done / n;
  }
  const requestKey = `${input.bookingId}:${sequence}`;
  const existing = await db.prepare("SELECT id FROM review_requests WHERE request_key=?").bind(requestKey).first<Row>();
  if (existing) return { requested: false, reason: "already_requested", requestId: String(existing.id) };
  const questions = (config.questions as Array<Record<string, unknown>>).slice(0, config.questionCount);
  const id = uid("REVREQ");
  await db.prepare("INSERT INTO review_requests (id,booking_id,service_code,customer_id,request_key,questions_json,channels_json,status,created_at) VALUES (?,?,?,?,?,?,?, 'sent',?)")
    .bind(id, input.bookingId, input.serviceCode, input.customerId, requestKey, JSON.stringify(questions), JSON.stringify(config.channels), Date.now()).run();
  // channels are recorded as the send intent; actual WhatsApp/notification delivery is the (sandbox) comms layer's job.
  return { requested: true, requestId: id, sequence, questions, channels: config.channels };
}

/** Customer submits a review. A 5-star rating returns the public-review links + reward offer. */
export async function submitServiceReview(db: Db, input: { requestId: string; customerId: string; stars: number; answers?: Record<string, unknown> }) {
  await ensureServiceReviewTables(db);
  const stars = Number(input.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error("Rating must be a whole number from 1 to 5");
  const req = await db.prepare("SELECT * FROM review_requests WHERE id=?").bind(input.requestId).first<Row>();
  if (!req) throw new Error("Review request not found");
  if (String(req.customer_id) !== input.customerId) throw new Error("You can only submit your own review");
  const done = await db.prepare("SELECT id FROM service_reviews WHERE request_id=?").bind(input.requestId).first<Row>();
  if (done) throw new Error("This review has already been submitted");
  await db.prepare("INSERT INTO service_reviews (id,request_id,booking_id,customer_id,stars,answers_json,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(uid("REV"), input.requestId, String(req.booking_id), input.customerId, stars, JSON.stringify(input.answers || {}), Date.now()).run();
  await db.prepare("UPDATE review_requests SET status='reviewed' WHERE id=?").bind(input.requestId).run();
  const config = await getActiveReviewConfig(db, String(req.service_code));
  if (stars === 5) {
    return { submitted: true, stars, fiveStar: true, bookingId: String(req.booking_id), googleReviewLink: config?.googleReviewLink || DEFAULT_GOOGLE_REVIEW_LINK, appReviewLink: config?.appReviewLink || DEFAULT_APP_REVIEW_LINK, publicReviewRewardAvailable: true };
  }
  return { submitted: true, stars, fiveStar: false };
}

/**
 * The customer confirms they posted a public review (google | app) for an order. 1st claim on the
 * order earns the single-review reward (Rs.250, any service); the 2nd platform on the same order
 * earns the double-review reward (Rs.400 flat off the next grooming). Idempotent per (order,platform).
 */
export async function claimPublicReview(db: Db, input: { bookingId: string; customerId: string; platform: string; actorId: string }) {
  await ensureServiceReviewTables(db);
  const platform = String(input.platform).toLowerCase();
  if (!PLATFORMS.includes(platform)) throw new Error("Platform must be 'google' or 'app'");
  const booking = await db.prepare("SELECT customer_id,service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if (!booking) throw new Error("Booking not found");
  if (String(booking.customer_id) !== input.customerId) throw new Error("You can only claim a review reward on your own order");
  const dup = await db.prepare("SELECT id FROM review_public_claims WHERE booking_id=? AND platform=?").bind(input.bookingId, platform).first<Row>();
  if (dup) throw new Error("You have already claimed a reward for a review on this platform for this order");
  const priorCount = Number((await db.prepare("SELECT COUNT(*) c FROM review_public_claims WHERE booking_id=?").bind(input.bookingId).first<Row>())?.c || 0);
  const config = await getActiveReviewConfig(db, String(booking.service_code));
  const isSecond = priorCount >= 1;
  const rewardKind = isSecond ? "double_review" : "single_review";
  const discount = isSecond ? (config?.doubleReviewDiscount ?? DEFAULT_DOUBLE_REVIEW_DISCOUNT) : (config?.singleReviewDiscount ?? DEFAULT_SINGLE_REVIEW_DISCOUNT);
  const scope = isSecond ? "grooming" : "any";
  const code = `${isSecond ? "REV400" : "REV250"}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const now = Date.now(), expiresAt = now + REWARD_VALID_DAYS * 86_400_000;
  await db.batch([
    db.prepare("INSERT INTO review_public_claims (id,booking_id,customer_id,platform,verification_status,reward_code,created_at) VALUES (?,?,?,?, 'self_declared',?,?)").bind(uid("RPC"), input.bookingId, input.customerId, platform, code, now),
    db.prepare("INSERT INTO review_reward_codes (code,customer_id,reward_kind,discount_amount,service_scope,status,source_booking_id,expires_at,created_at) VALUES (?,?,?,?,?, 'issued',?,?,?)").bind(code, input.customerId, rewardKind, discount, scope, input.bookingId, expiresAt, now),
  ]);
  return { platform, claimNumber: priorCount + 1, reward: { code, discount, scope, rewardKind }, verification: "self_declared" };
}

/** Optional staff verification of a self-declared public review claim (for audit / anti-abuse). */
export async function verifyPublicReview(db: Db, input: { claimId: string; actor: string; verified: boolean }) {
  await ensureServiceReviewTables(db);
  const claim = await db.prepare("SELECT id FROM review_public_claims WHERE id=?").bind(input.claimId).first<Row>();
  if (!claim) throw new Error("Public review claim not found");
  await db.prepare("UPDATE review_public_claims SET verification_status=? WHERE id=?").bind(input.verified ? "verified" : "rejected", input.claimId).run();
  return { claimId: input.claimId, verificationStatus: input.verified ? "verified" : "rejected" };
}

/** Redeem a review reward code against a real customer-owned booking (grooming-only for double-review). */
export async function redeemReviewReward(db: Db, input: { code: string; customerId: string; bookingId: string; actorId: string }) {
  await ensureServiceReviewTables(db);
  const reward = await db.prepare("SELECT * FROM review_reward_codes WHERE code=?").bind(input.code.trim()).first<Row>();
  if (!reward) throw new Error("Reward code not found");
  if (String(reward.customer_id) !== input.customerId) throw new Error("This reward belongs to another account");
  if (String(reward.status) !== "issued") throw new Error("This reward has already been used");
  if (Number(reward.expires_at) < Date.now()) throw new Error("This reward has expired");
  const booking = await db.prepare("SELECT customer_id,service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if (!booking) throw new Error("Booking not found");
  if (String(booking.customer_id) !== input.customerId) throw new Error("You can only apply your reward to your own booking");
  if (String(reward.service_scope) === "grooming" && String(booking.service_code) !== "grooming") throw new Error("This reward is valid on grooming only");
  await db.prepare("UPDATE review_reward_codes SET status='redeemed',redeemed_booking_id=?,redeemed_at=? WHERE code=? AND status='issued'").bind(input.bookingId, Date.now(), String(reward.code)).run();
  return { code: String(reward.code), bookingId: input.bookingId, discountApplied: Number(reward.discount_amount), serviceScope: String(reward.service_scope) };
}

/**
 * Background sweep: for every service whose active config triggers on *every service*, raise a review
 * request for completed bookings that don't have one yet (grooming/boarding/sitting/taxi). Cadence
 * services (e.g. training every 3 sessions) are driven explicitly via requestServiceReview with a
 * session count, so they are intentionally left to their own trigger. Cold-DB safe: every query
 * tolerates missing tables so a fresh scheduler DB never makes the run partial.
 */
export async function runServiceReviewSweep(db: Db, input: { asOf?: number } = {}) {
  await ensureServiceReviewTables(db);
  const asOf = input.asOf ?? Date.now();
  const configs = await db.prepare("SELECT DISTINCT service_code FROM review_service_configs WHERE status='active' AND trigger_type='every_service'").all<Row>().catch(() => ({ results: [] as Row[] }));
  let requested = 0, scanned = 0;
  for (const cfg of configs.results) {
    const serviceCode = String(cfg.service_code);
    const due = await db.prepare("SELECT b.id id,b.customer_id customer_id FROM canonical_bookings b WHERE b.service_code=? AND b.status='completed' AND NOT EXISTS (SELECT 1 FROM review_requests r WHERE r.booking_id=b.id) LIMIT 200").bind(serviceCode).all<Row>().catch(() => ({ results: [] as Row[] }));
    for (const b of due.results) {
      scanned++;
      const customerId = String(b.customer_id || "").trim();
      if (!customerId) continue;
      const res = await requestServiceReview(db, { bookingId: String(b.id), serviceCode, customerId }).catch(() => null);
      if (res && (res as Row).requested) requested++;
    }
  }
  return { sweep: "service_reviews", asOf, scanned, requested };
}

export async function listReviewRewards(db: Db, customerId: string) {
  await ensureServiceReviewTables(db);
  const rows = await db.prepare("SELECT code,reward_kind,discount_amount,service_scope,expires_at FROM review_reward_codes WHERE customer_id=? AND status='issued' AND expires_at>=? ORDER BY created_at DESC").bind(customerId, Date.now()).all<Row>();
  return rows.results.map((r: Row) => ({ code: String(r.code), rewardKind: String(r.reward_kind), discount: Number(r.discount_amount), scope: String(r.service_scope), expiresAt: Number(r.expires_at) }));
}
