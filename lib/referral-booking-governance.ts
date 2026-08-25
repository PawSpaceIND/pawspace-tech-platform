import{ensureReferralTables,qualifyReferralClaim,reverseReferralReward,type ReferralService}from"./referral-governance";

type Db=D1Database;
type Row=Record<string,unknown>;

const normalizePhone=(value:unknown)=>String(value||"").replace(/\D/g,"");
const normalizeEmail=(value:unknown)=>String(value||"").trim().toLowerCase();
const readSnapshot=(value:unknown)=>{try{return JSON.parse(String(value||"{}")) as Record<string,unknown>}catch{return{} as Record<string,unknown>}};

export type ReferralBookingPreparation={
  claimId:string;
  programmeId:string;
  code:string;
  referrerCustomerId:string;
  referredCustomerId:string;
  serviceCode:ReferralService;
  cityId:string;
  baseAmount:number;
  baseAmountDueNow:number;
  discountAmount:number;
  totalAmount:number;
  amountDueNow:number;
  policySnapshot:Record<string,unknown>;
  testOnly:true;
  liveMoney:false;
};

export async function ensureReferralBookingTables(db:Db){await ensureReferralTables(db);await db.prepare("CREATE TABLE IF NOT EXISTS referral_claim_booking_links (claim_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,programme_id TEXT NOT NULL,referred_customer_id TEXT NOT NULL,applied_discount REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'bound',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS referral_first_booking_customer_programme_idx ON referral_claim_booking_links(programme_id,referred_customer_id)").run();}

export async function prepareReferralBooking(db:Db,input:{
  claimId:string;
  customer:{id:string;primaryPhone:string;email?:string};
  serviceCode:ReferralService;
  cityId:string;
  baseAmount:number;
  baseAmountDueNow:number;
  hasOtherOffer:boolean;
  isSubscription:boolean;
}) : Promise<ReferralBookingPreparation>{
  await ensureReferralBookingTables(db);
  if(!input.claimId.trim())throw new Error("Referral claim ID is required");
  if(input.isSubscription)throw new Error("Referral subscription eligibility is configuration_required");
  if(input.hasOtherOffer)throw new Error("Referral stacking with another coupon/offer is configuration_required");
  if(!["grooming","dog_training","boarding"].includes(input.serviceCode))throw new Error("Referral booking pricing for this service is configuration_required until its server price is canonical");
  if(!Number.isFinite(input.baseAmount)||input.baseAmount<0||!Number.isFinite(input.baseAmountDueNow)||input.baseAmountDueNow<0)throw new Error("Canonical referral pricing base is invalid");

  const claim=await db.prepare("SELECT * FROM referral_claims WHERE id=?").bind(input.claimId).first<Row>();
  if(!claim)throw new Error("Referral claim not found");
  if(String(claim.referred_customer_id)!==input.customer.id)throw new Error("Referral claim does not belong to this customer");
  if(String(claim.service_code)!==input.serviceCode||String(claim.city_id)!==input.cityId)throw new Error("Referral claim does not match this booking service/city");
  if(["rejected","qualified","cancellation_review"].includes(String(claim.status)))throw new Error("Referral claim is not available for a new booking");
  if(["hold","rejected","limit_reached"].includes(String(claim.fraud_state)))throw new Error("Referral claim requires review before booking");
  const existingLink=await db.prepare("SELECT booking_id FROM referral_claim_booking_links WHERE claim_id=? OR (programme_id=? AND referred_customer_id=?) LIMIT 1").bind(input.claimId,claim.programme_id,input.customer.id).first<Row>();
  if(existingLink)throw new Error("Referral claim is already bound to a canonical booking");
  const priorBookings=await db.prepare("SELECT COUNT(*) count FROM canonical_bookings WHERE customer_id=?").bind(input.customer.id).first<Row>();
  if(Number(priorBookings?.count||0)>0)throw new Error("Referral claim can only bind to the referred customer's first canonical booking");

  const referrer=await db.prepare("SELECT primary_phone,email FROM canonical_customers WHERE id=?").bind(claim.referrer_customer_id).first<Row>();
  if(!referrer)throw new Error("Referrer canonical customer is unavailable");
  const referrerPhone=normalizePhone(referrer.primary_phone),friendPhone=normalizePhone(input.customer.primaryPhone);
  const referrerEmail=normalizeEmail(referrer.email),friendEmail=normalizeEmail(input.customer.email);
  if(referrerPhone&&friendPhone&&referrerPhone===friendPhone){await db.prepare("UPDATE referral_claims SET status='held',fraud_state='hold',review_reason='Referrer and referred customer share the same booking phone',updated_at=? WHERE id=?").bind(Date.now(),input.claimId).run();throw new Error("Referral claim requires identity review");}
  if(referrerEmail&&friendEmail&&referrerEmail===friendEmail){await db.prepare("UPDATE referral_claims SET status='held',fraud_state='hold',review_reason='Referrer and referred customer share the same booking email',updated_at=? WHERE id=?").bind(Date.now(),input.claimId).run();throw new Error("Referral claim requires identity review");}

  // The PROGRAMME is re-read at redemption, not just at claim time. Expiry and shutdown used to be
  // enforced only when a claim was created and in the listing surfaces - never at the moment money is
  // given away - so a claim stayed redeemable forever: a paused programme, expired by 300 days and with
  // its friend discount set to 0, still handed out its original Rs 500. There is no claim-level expiry
  // column either, so marketing had no way to stop the bleed short of rejecting each claim by hand.
  //
  // Deliberately NOT changed: which AMOUNT applies. The frozen snapshot still sets the discount for a
  // LIVE programme - that is what the snapshot is for, and re-pricing an outstanding claim is a
  // marketing decision. Pausing exists to stop the bleed; that is all this restores.
  const programme=await db.prepare("SELECT status,valid_from,valid_until FROM referral_programmes WHERE id=?").bind(claim.programme_id).first<Row>();
  if(!programme)throw new Error("Referral programme is unavailable");
  if(String(programme.status)!=="active")throw new Error("Referral programme is paused; outstanding claims cannot be redeemed while it is not active");
  const redeemAt=Date.now();
  if(Number(programme.valid_from)>redeemAt||Number(programme.valid_until)<redeemAt)throw new Error("Referral programme validity window has elapsed; this claim can no longer be redeemed");
  const snapshot=readSnapshot(claim.policy_snapshot_json),configuredDiscount=Number(snapshot.friendDiscount);
  if(!Number.isFinite(configuredDiscount)||configuredDiscount<0)throw new Error("Referral friend discount is configuration_required");
  const discountAmount=Math.max(0,Math.min(configuredDiscount,input.baseAmount));
  const totalAmount=Math.max(0,input.baseAmount-discountAmount);
  const amountDueNow=Math.max(0,Math.min(input.baseAmountDueNow,totalAmount));
  return{claimId:input.claimId,programmeId:String(claim.programme_id),code:String(claim.code),referrerCustomerId:String(claim.referrer_customer_id),referredCustomerId:input.customer.id,serviceCode:input.serviceCode,cityId:input.cityId,baseAmount:input.baseAmount,baseAmountDueNow:input.baseAmountDueNow,discountAmount,totalAmount,amountDueNow,policySnapshot:snapshot,testOnly:true,liveMoney:false};
}

export function referralBookingLinkStatement(db:Db,input:{preparation:ReferralBookingPreparation;bookingId:string;now:number}){const p=input.preparation;return db.prepare("INSERT INTO referral_claim_booking_links (claim_id,booking_id,programme_id,referred_customer_id,applied_discount,status,created_at,updated_at) VALUES (?,?,?,?,?,'bound',?,?)").bind(p.claimId,input.bookingId,p.programmeId,p.referredCustomerId,p.discountAmount,input.now,input.now);}

export function referralClaimBoundStatement(db:Db,input:{claimId:string;now:number}){return db.prepare("UPDATE referral_claims SET status='pending_completion',fraud_state='clear',review_reason=NULL,updated_at=? WHERE id=? AND status IN ('pending_booking','pending_completion','pending_payment')").bind(input.now,input.claimId);}

export async function tryQualifyLinkedReferral(db:Db,input:{bookingId:string;actorId:string}){await ensureReferralBookingTables(db);const link=await db.prepare("SELECT * FROM referral_claim_booking_links WHERE booking_id=?").bind(input.bookingId).first<Row>();if(!link)return{applicable:false,status:"not_applicable"};const result=await qualifyReferralClaim(db,{claimId:String(link.claim_id),bookingId:input.bookingId,idempotencyKey:`referral-qualify:${input.bookingId}`,actorId:input.actorId});const status=(result as{qualified?:boolean;status?:string}).qualified?"qualified":String((result as{status?:string}).status||"pending");await db.prepare("UPDATE referral_claim_booking_links SET status=?,updated_at=? WHERE booking_id=?").bind(status,Date.now(),input.bookingId).run();return{applicable:true,...result};}

export async function handleReferralBookingCancellation(db:Db,input:{bookingId:string;actorId:string;reason:string}){await ensureReferralBookingTables(db);const link=await db.prepare("SELECT * FROM referral_claim_booking_links WHERE booking_id=?").bind(input.bookingId).first<Row>();if(!link)return{applicable:false,status:"not_applicable"};const reward=await db.prepare("SELECT * FROM referral_rewards WHERE claim_id=?").bind(link.claim_id).first<Row>();const now=Date.now();if(!reward){await db.batch([db.prepare("UPDATE referral_claim_booking_links SET status='cancellation_review',updated_at=? WHERE booking_id=?").bind(now,input.bookingId),db.prepare("UPDATE referral_claims SET status='cancellation_review',review_reason='Referral retry/reuse after cancellation is configuration_required',updated_at=? WHERE id=? AND status!='rejected'").bind(now,link.claim_id)]);return{applicable:true,status:"cancellation_review",configurationRequired:"Referral retry/reuse after cancellation"};}
  const snapshot=readSnapshot(reward.policy_snapshot_json);if(snapshot.reversalOnRefund===true){const reversed=await reverseReferralReward(db,{rewardId:String(reward.id),reason:input.reason,actorId:input.actorId});await db.prepare("UPDATE referral_claim_booking_links SET status='reward_reversed',updated_at=? WHERE booking_id=?").bind(now,input.bookingId).run();return{applicable:true,status:"reward_reversed",reversed};}
  if(snapshot.reversalOnRefund===false){await db.prepare("UPDATE referral_claim_booking_links SET status='cancelled_no_reward_reversal',updated_at=? WHERE booking_id=?").bind(now,input.bookingId).run();return{applicable:true,status:"cancelled_no_reward_reversal",policyApplied:true};}
  await db.prepare("UPDATE referral_claim_booking_links SET status='cancellation_review',updated_at=? WHERE booking_id=?").bind(now,input.bookingId).run();return{applicable:true,status:"cancellation_review",configurationRequired:"Referral refund/reversal policy"};}
