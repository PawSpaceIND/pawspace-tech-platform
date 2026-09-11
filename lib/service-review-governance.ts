import{remainingPayableForCredit}from"./booking-credit-application";
/**
 * Universal post-service feedback. Every completed booking can receive five 1-5 questions. Completing
 * PawSpace feedback earns a customer-owned master reward independent of score. Public Google/App review
 * links are optional and backend-configurable, but public reviews never earn money, coupons or services.
 * Low internal feedback still opens a governed recovery case.
 */

import { createUnifiedCase } from "./unified-case-center";
import { getActiveReviewConfig, DEFAULT_GOOGLE_REVIEW_LINK, DEFAULT_APP_REVIEW_LINK, DEFAULT_FEEDBACK_COMPLETION_DISCOUNT, DEFAULT_PUBLIC_REVIEW_DESTINATION, DEFAULT_FEEDBACK_QUESTIONS } from "./review-configuration-governance";

export class ServiceReviewError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = "ServiceReviewError"; this.status = status; }
}

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
    db.prepare("CREATE TABLE IF NOT EXISTS review_reward_codes (code TEXT PRIMARY KEY,customer_id TEXT NOT NULL,reward_kind TEXT NOT NULL,discount_amount REAL NOT NULL,applied_amount REAL,service_scope TEXT NOT NULL DEFAULT 'any',status TEXT NOT NULL DEFAULT 'issued',source_booking_id TEXT,expires_at INTEGER NOT NULL,redeemed_booking_id TEXT,redeemed_at INTEGER,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_feedback_addons (reward_code TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,addon_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'reserved',created_at INTEGER NOT NULL,UNIQUE(booking_id,addon_code,reward_code))"),
  ]);
  await db.prepare("ALTER TABLE review_reward_codes ADD COLUMN applied_amount REAL").run().catch((error)=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error});

}

async function completedReviewBooking(db: Db, bookingId: string, customerId: string, serviceCode: string) {
  const booking = await db.prepare("SELECT customer_id,provider_id,service_code,status FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
  if (!booking || String(booking.customer_id) !== customerId || String(booking.service_code) !== serviceCode) throw new ServiceReviewError("Review booking does not match the customer and service", 403);
  if (booking.status !== "completed") throw new ServiceReviewError("Only completed bookings can be reviewed", 409);
  return booking;
}

/**
 * Raise a review request for a completed service, respecting the service's configured cadence.
 * For every_n_sessions services (e.g. training every 3), pass completedSessionCount. Idempotent.
 */
export async function requestServiceReview(db: Db, input: { bookingId: string; serviceCode: string; customerId: string; completedSessionCount?: number }) {
  await ensureServiceReviewTables(db);
  await completedReviewBooking(db, input.bookingId, input.customerId, input.serviceCode);
  const configured = await getActiveReviewConfig(db, input.serviceCode);
  const config = configured || {
    questions:[...DEFAULT_FEEDBACK_QUESTIONS],questionCount:5,triggerType:"every_service",triggerInterval:1,channels:["notification"],
    googleReviewLink:DEFAULT_GOOGLE_REVIEW_LINK,appReviewLink:DEFAULT_APP_REVIEW_LINK,publicReviewDestination:DEFAULT_PUBLIC_REVIEW_DESTINATION,
  };
  let sequence = 1;
  if (config.triggerType === "every_n_sessions") {
    const done = Number(input.completedSessionCount || 0), n = Math.max(1, config.triggerInterval);
    if (done <= 0 || done % n !== 0) return { requested: false, reason: "cadence_not_reached", completedSessionCount: done, interval: n };
    sequence = done / n;
  }
  const requestKey = `${input.bookingId}:${sequence}`;
  const existing = await db.prepare("SELECT id FROM review_requests WHERE request_key=?").bind(requestKey).first<Row>();
  if (existing) return { requested: false, reason: "already_requested", requestId: String(existing.id) };
  const configuredQuestions=(config.questions as Array<Record<string, unknown>>);
  const questions=[...configuredQuestions,...DEFAULT_FEEDBACK_QUESTIONS.filter(d=>!configuredQuestions.some(q=>String(q.id)===d.id))].slice(0,5);
  const id = uid("REVREQ");
  await db.prepare("INSERT INTO review_requests (id,booking_id,service_code,customer_id,request_key,questions_json,channels_json,status,created_at) VALUES (?,?,?,?,?,?,?, 'sent',?)")
    .bind(id, input.bookingId, input.serviceCode, input.customerId, requestKey, JSON.stringify(questions), JSON.stringify(config.channels), Date.now()).run();
  // channels are recorded as the send intent; actual WhatsApp/notification delivery is the (sandbox) comms layer's job.
  return { requested: true, requestId: id, sequence, questions, channels: config.channels };
}

/** Customer submits the five-question PawSpace feedback. The reward is for completing feedback, never for a public review. */
export async function submitServiceReview(db: Db, input: { requestId: string; customerId: string; stars?: number; answers?: Record<string, unknown> }) {
  await ensureServiceReviewTables(db);
  const req = await db.prepare("SELECT * FROM review_requests WHERE id=?").bind(input.requestId).first<Row>();
  if (!req) throw new ServiceReviewError("Review request not found", 404);
  if (String(req.customer_id) !== input.customerId) throw new ServiceReviewError("You can only submit your own review", 403);
  const booking = await completedReviewBooking(db, String(req.booking_id), input.customerId, String(req.service_code));
  const done = await db.prepare("SELECT id FROM service_reviews WHERE request_id=?").bind(input.requestId).first<Row>();
  if (done) throw new ServiceReviewError("This review has already been submitted", 409);
  const questions=JSON.parse(String(req.questions_json||"[]")) as Array<{id?:string}>;
  const answers=input.answers||{};
  const scored=questions.map(q=>Number(answers[String(q.id||"")])).filter(v=>Number.isInteger(v)&&v>=1&&v<=5);
  if(questions.length>0&&scored.length!==questions.length)throw new ServiceReviewError("Please rate all five feedback questions from 1 to 5",400);
  const fallback=Number(input.stars);
  if(!scored.length&&(!Number.isInteger(fallback)||fallback<1||fallback>5))throw new ServiceReviewError("Rating must be a whole number from 1 to 5",400);
  const average=scored.length?Math.round((scored.reduce((a,b)=>a+b,0)/scored.length)*100)/100:fallback;
  const stars=Math.max(1,Math.min(5,Math.round(average)));
  const config=await getActiveReviewConfig(db,String(req.service_code));
  const rewardKind=String(config?.feedbackRewardKind||"coupon")==="addon"?"addon":"coupon",rewardValue=rewardKind==="coupon"?Number(config?.feedbackRewardValue??DEFAULT_FEEDBACK_COMPLETION_DISCOUNT):0,addonCode=rewardKind==="addon"?String(config?.feedbackAddonCode||""):null;
  const reviewId = uid("REV"), now = Date.now();
  const rewardCode=`FB-${crypto.randomUUID().slice(0,8).toUpperCase()}`,expiresAt=now+REWARD_VALID_DAYS*86_400_000,rewardStorageKind=rewardKind==="addon"?`feedback_addon:${addonCode}`:"feedback_completion";
  const statements = [
    db.prepare("INSERT INTO service_reviews (id,request_id,booking_id,customer_id,stars,answers_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(reviewId,input.requestId,String(req.booking_id),input.customerId,stars,JSON.stringify({...answers,__average:average}),now),
    db.prepare("UPDATE review_requests SET status='reviewed' WHERE id=?").bind(input.requestId),
    db.prepare("INSERT INTO review_reward_codes (code,customer_id,reward_kind,discount_amount,service_scope,status,source_booking_id,expires_at,created_at) VALUES (?,?,?,?, 'any','issued',?,?,?)").bind(rewardCode,input.customerId,rewardStorageKind,rewardValue,String(req.booking_id),expiresAt,now),
  ];
  if (average <= 2) {
    await createUnifiedCase(db,{idempotencyKey:`low-service-review:${input.requestId}`,caseType:"customer_complaint",severity:"high",title:`${average}-star service feedback`,description:`Customer feedback for booking ${String(req.booking_id)} averaged ${average} out of 5. Contact the customer for service recovery.`,customerId:input.customerId,bookingId:String(req.booking_id),providerId:booking.provider_id==null?null:String(booking.provider_id),sourceType:"service_review",sourceId:reviewId,ownerTeam:"customer_support",actorId:input.customerId},statements);
  } else await db.batch(statements);
  const destination=String((config as Row|null)?.publicReviewDestination||DEFAULT_PUBLIC_REVIEW_DESTINATION);
  return{submitted:true,stars,average,bookingId:String(req.booking_id),feedbackReward:{code:rewardCode,kind:rewardKind,discount:rewardValue,addonCode,scope:"any"},publicReviewPrompt:{eligible:true,destination,googleReviewLink:config?.googleReviewLink||DEFAULT_GOOGLE_REVIEW_LINK,appReviewLink:config?.appReviewLink||DEFAULT_APP_REVIEW_LINK},highSatisfaction:average>=4.5};
}

/** Record a customer-declared public review for audit/analytics only. Public reviews never create rewards. */
export async function claimPublicReview(db: Db, input: { bookingId: string; customerId: string; platform: string; actorId: string }) {
  await ensureServiceReviewTables(db);
  const platform=String(input.platform).toLowerCase();
  if(!PLATFORMS.includes(platform))throw new Error("Platform must be 'google' or 'app'");
  const booking=await db.prepare("SELECT customer_id FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if(!booking)throw new Error("Booking not found");
  if(String(booking.customer_id)!==input.customerId)throw new Error("You can only record a review for your own order");
  const result=await db.prepare("INSERT OR IGNORE INTO review_public_claims (id,booking_id,customer_id,platform,verification_status,reward_code,created_at) VALUES (?,?,?,?, 'self_declared',NULL,?)").bind(uid("RPC"),input.bookingId,input.customerId,platform,Date.now()).run();
  if(!Number(result.meta.changes))throw new Error("A review on this platform is already recorded for this order");
  return{platform,recorded:true,reward:null,policy:"public reviews are never incentivised"};
}

/** Optional staff verification of a self-declared public review claim (for audit / anti-abuse). */
export async function verifyPublicReview(db: Db, input: { claimId: string; actor: string; verified: boolean }) {
  await ensureServiceReviewTables(db);
  const claim = await db.prepare("SELECT id,reward_code FROM review_public_claims WHERE id=?").bind(input.claimId).first<Row>();
  if (!claim) throw new Error("Public review claim not found");
  await db.prepare("UPDATE review_public_claims SET verification_status=? WHERE id=?").bind(input.verified ? "verified" : "rejected", input.claimId).run();
  // Rejecting a claim used to leave its reward code live, so a claim staff had found to be false
  // still bought a discount. Void the reward if it has not already been spent (a spent one needs the
  // explicit refund/adjustment path, not a silent status flip).
  let rewardVoided = false;
  if (!input.verified && claim.reward_code) {
    const voided = await db.prepare("UPDATE review_reward_codes SET status='void' WHERE code=? AND status='issued'").bind(String(claim.reward_code)).run();
    rewardVoided = Number(voided.meta.changes) > 0;
  }
  return { claimId: input.claimId, verificationStatus: input.verified ? "verified" : "rejected", rewardCode: claim.reward_code ? String(claim.reward_code) : null, rewardVoided };
}

/** Redeem a review reward code against a real customer-owned booking (grooming-only for double-review). */
export async function redeemReviewReward(db: Db, input: { code: string; customerId: string; bookingId: string; actorId: string }) {
  await ensureServiceReviewTables(db);
  const reward = await db.prepare("SELECT * FROM review_reward_codes WHERE code=?").bind(input.code.trim()).first<Row>();
  if (!reward) throw new Error("Reward code not found");
  if (String(reward.customer_id) !== input.customerId) throw new Error("This reward belongs to another account");
  if (String(reward.status) !== "issued") throw new Error("This reward has already been used");
  if (Number(reward.expires_at) < Date.now()) throw new Error("This reward has expired");
  const booking = await db.prepare("SELECT customer_id,service_code,total_amount,status FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if (!booking) throw new Error("Booking not found");
  if (String(booking.customer_id) !== input.customerId) throw new Error("You can only apply your reward to your own booking");
  if (String(reward.service_scope) === "grooming" && String(booking.service_code) !== "grooming") throw new Error("This reward is valid on grooming only");
  const addOnCode=String(reward.reward_kind).startsWith("feedback_addon:")?String(reward.reward_kind).slice("feedback_addon:".length):null;
  const discount=addOnCode?0:Math.min(Number(reward.discount_amount||0),await remainingPayableForCredit(db,input.bookingId,Number(booking.total_amount||0)));
  if(!addOnCode&&!(discount>0))throw new Error("This booking has no remaining amount for the reward to cover");
  // The status='issued' guard is only half the protection: its result has to be checked, or two
  // concurrent redemptions both report the discount as applied while one row actually moved.
  const claim = await db.prepare("UPDATE review_reward_codes SET status='redeemed',redeemed_booking_id=?,redeemed_at=?,applied_amount=? WHERE code=? AND status='issued'").bind(input.bookingId, Date.now(),discount,String(reward.code)).run();
  if (!Number(claim.meta.changes)) {
    const winner = await db.prepare("SELECT redeemed_booking_id FROM review_reward_codes WHERE code=?").bind(String(reward.code)).first<Row>();
    if (winner && String(winner.redeemed_booking_id) === input.bookingId) return { code: String(reward.code), bookingId: input.bookingId, discountApplied: Number((await db.prepare("SELECT applied_amount FROM review_reward_codes WHERE code=?").bind(String(reward.code)).first<Row>())?.applied_amount||0), addOnCode, serviceScope: String(reward.service_scope), duplicatePrevented: true };
    throw new Error("This reward has already been used");
  }
  if(addOnCode)await db.prepare("INSERT OR IGNORE INTO booking_feedback_addons (reward_code,booking_id,customer_id,addon_code,status,created_at) VALUES (?,?,?,?, 'reserved',?)").bind(String(reward.code),input.bookingId,input.customerId,addOnCode,Date.now()).run();
  return { code: String(reward.code), bookingId: input.bookingId, discountApplied: discount, addOnCode, serviceScope: String(reward.service_scope), duplicatePrevented: false };
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


export async function listCustomerPendingServiceReviews(db:Db,customerId:string){
  await ensureServiceReviewTables(db);
  const bookings=await db.prepare("SELECT id,service_code,package_name,scheduled_start FROM canonical_bookings WHERE customer_id=? AND status='completed' ORDER BY scheduled_start DESC LIMIT 30").bind(customerId).all<Row>();
  for(const booking of bookings.results){
    await requestServiceReview(db,{bookingId:String(booking.id),serviceCode:String(booking.service_code),customerId}).catch(()=>null);
  }
  const rows=await db.prepare("SELECT r.id request_id,r.booking_id,r.service_code,r.questions_json,r.created_at,b.package_name,b.scheduled_start FROM review_requests r JOIN canonical_bookings b ON b.id=r.booking_id WHERE r.customer_id=? AND r.status='sent' ORDER BY r.created_at DESC LIMIT 20").bind(customerId).all<Row>();
  return rows.results.map(row=>({requestId:String(row.request_id),bookingId:String(row.booking_id),serviceCode:String(row.service_code),packageName:String(row.package_name||""),scheduledStart:String(row.scheduled_start||""),questions:JSON.parse(String(row.questions_json||"[]"))}));
}
export async function listReviewRewards(db: Db, customerId: string) {
  await ensureServiceReviewTables(db);
  const rows = await db.prepare("SELECT code,reward_kind,discount_amount,service_scope,expires_at FROM review_reward_codes WHERE customer_id=? AND status='issued' AND expires_at>=? ORDER BY created_at DESC").bind(customerId, Date.now()).all<Row>();
  return rows.results.map((r: Row) => ({ code: String(r.code), rewardKind: String(r.reward_kind), discount: Number(r.discount_amount), scope: String(r.service_scope), expiresAt: Number(r.expires_at) }));
}
