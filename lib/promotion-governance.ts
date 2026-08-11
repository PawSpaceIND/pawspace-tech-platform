import { buildCustomer360 } from "./customer-360";

type Db=D1Database;
type Row=Record<string,unknown>;

const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
function bucket(customerId:string){let value=0;for(const c of customerId)value=(value*31+c.charCodeAt(0))%10000;return value%100;}

/**
 * The real Promotions backend the marketing-control panel's "Promotions" tab has always been
 * honestly labeled as missing ("PROMOTION CONTROL · NOT YET BUILT", createPromotion just notifying
 * "no backend exists" - confirmed directly in the panel's own source before building this). Mirrors
 * the exact same real lifecycle and audience-suppression pattern already proven for Campaigns
 * (draft -> approval_required -> approved -> active, real consent/complaint/duplicate/data-quality
 * suppression, real holdout bucketing) rather than inventing a parallel, less-trustworthy mechanism.
 */
export async function ensurePromotionGovernance(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS governed_marketing_promotions (id TEXT PRIMARY KEY,name TEXT NOT NULL,promotion_type TEXT NOT NULL,vertical TEXT NOT NULL,audience TEXT NOT NULL,value REAL NOT NULL,budget_cap REAL NOT NULL,margin_floor_percent REAL NOT NULL,holdout_percent INTEGER NOT NULL,coupon_policy TEXT NOT NULL DEFAULT 'exclusive',status TEXT NOT NULL DEFAULT 'draft',approval_status TEXT NOT NULL DEFAULT 'approval_required',approved_by TEXT,approved_at INTEGER,start_at TEXT,end_at TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS promotion_audience_snapshots (id TEXT PRIMARY KEY,promotion_id TEXT NOT NULL,snapshot_at INTEGER NOT NULL,total_candidates INTEGER NOT NULL,eligible_count INTEGER NOT NULL,holdout_count INTEGER NOT NULL,suppressed_count INTEGER NOT NULL,policy_json TEXT NOT NULL,created_by TEXT NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS promotion_audience_members (snapshot_id TEXT NOT NULL,promotion_id TEXT NOT NULL,customer_id TEXT NOT NULL,cohort TEXT NOT NULL,suppression_reason TEXT,PRIMARY KEY(snapshot_id,customer_id))"),
 db.prepare("CREATE TABLE IF NOT EXISTS promotion_redemptions (id TEXT PRIMARY KEY,promotion_id TEXT NOT NULL,customer_id TEXT NOT NULL,booking_id TEXT,discount_amount REAL NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS promotion_governance_events (id TEXT PRIMARY KEY,promotion_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_email TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);}

function validatePromotion(input:{name:string;promotionType:string;vertical:string;audience:string;value:number;budgetCap:number;marginFloorPercent:number;holdoutPercent:number}){
 if(!input.name.trim())throw new Error("Promotion name is required");
 if(!["percent_discount","flat_discount","free_addon","bundle"].includes(input.promotionType))throw new Error("Unsupported promotion type");
 if(!input.vertical.trim())throw new Error("Vertical is required");
 if(!input.audience.trim())throw new Error("Audience description is required");
 if(!Number.isFinite(input.value)||input.value<=0)throw new Error("A positive promotion value is required");
 if(input.promotionType==="percent_discount"&&input.value>=100)throw new Error("A percent discount of 100 or more is not a valid promotion");
 if(!Number.isFinite(input.budgetCap)||input.budgetCap<=0)throw new Error("A positive total budget cap is required");
 if(!Number.isFinite(input.marginFloorPercent)||input.marginFloorPercent<0||input.marginFloorPercent>100)throw new Error("Margin floor percent must be between 0 and 100");
 if(input.promotionType==="percent_discount"&&input.value>input.marginFloorPercent)throw new Error(`A ${input.value}% discount would breach the configured ${input.marginFloorPercent}% margin floor - lower the discount or raise the margin floor explicitly`);
 if(!Number.isInteger(input.holdoutPercent)||input.holdoutPercent<0||input.holdoutPercent>100)throw new Error("Holdout percent must be a whole number between 0 and 100");
}

export async function createPromotionDraft(db:Db,input:{name:string;promotionType:string;vertical:string;audience:string;value:number;budgetCap:number;marginFloorPercent:number;holdoutPercent:number;couponPolicy?:string;startAt?:string|null;endAt?:string|null;actor:string}){
 await ensurePromotionGovernance(db);
 validatePromotion(input);
 const id=uid("PROMO"),now=Date.now();
 await db.prepare("INSERT INTO governed_marketing_promotions (id,name,promotion_type,vertical,audience,value,budget_cap,margin_floor_percent,holdout_percent,coupon_policy,status,approval_status,start_at,end_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'draft','approval_required',?,?,?,?,?)")
   .bind(id,input.name.trim(),input.promotionType,input.vertical,input.audience,input.value,input.budgetCap,input.marginFloorPercent,input.holdoutPercent,input.couponPolicy||"exclusive",input.startAt||null,input.endAt||null,input.actor,now,now).run();
 await event(db,id,"created",input.actor,{value:input.value,budgetCap:input.budgetCap,marginFloorPercent:input.marginFloorPercent});
 return{id,status:"draft",approvalStatus:"approval_required"};
}

export async function approvePromotion(db:Db,input:{promotionId:string;actor:string;reason:string}){
 await ensurePromotionGovernance(db);
 if(input.reason.trim().length<8)throw new Error("A clear approval reason is required");
 const now=Date.now();
 const existingPromotion=await db.prepare("SELECT created_by FROM governed_marketing_promotions WHERE id=?").bind(input.promotionId).first<{created_by?:unknown}>();
 if(existingPromotion&&String(existingPromotion.created_by)===input.actor)throw new Error("Maker/checker: the promotion creator cannot approve their own promotion");
 const result=await db.prepare("UPDATE governed_marketing_promotions SET approval_status='approved',approved_by=?,approved_at=?,status=CASE WHEN status='draft' THEN 'approved' ELSE status END,updated_at=? WHERE id=? AND approval_status='approval_required'")
   .bind(input.actor,now,now,input.promotionId).run();
 if(!Number(result.meta?.changes||0))throw new Error("Promotion not found or already approved");
 await event(db,input.promotionId,"approved",input.actor,{reason:input.reason});
 return{id:input.promotionId,approvalStatus:"approved"};
}

/** Real audience eligibility - the exact same consent/complaint/duplicate/data-quality suppression already proven for Campaigns, plus a real frequency cap: a customer already redeeming a DIFFERENT active promotion this month is suppressed, preventing uncontrolled stacking across promotions. */
export async function snapshotPromotionAudience(db:Db,input:{promotionId:string;actor:string}){
 await ensurePromotionGovernance(db);
 const promotion=await db.prepare("SELECT * FROM governed_marketing_promotions WHERE id=?").bind(input.promotionId).first<Row>();
 if(!promotion)throw new Error("Promotion not found");
 if(!["draft","approved","paused"].includes(String(promotion.status)))throw new Error("Promotion audience cannot be snapshotted in the current state");
 const customers=await buildCustomer360(db),holdout=Math.max(0,Math.min(100,Number(promotion.holdout_percent))),snapshotId=uid("PROMOAUD"),now=Date.now();
 const monthStart=Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),1);
 let eligible=0,suppressed=0,held=0;const statements=[];
 for(const customer of customers){
   const reasons:string[]=[];
   if(!customer.consent.marketing)reasons.push("marketing_consent_missing");
   if(customer.openTicketCount>0)reasons.push("open_customer_experience_case");
   if(customer.dataQuality.issues.includes("possible_duplicate"))reasons.push("duplicate_review_required");
   if(customer.dataQuality.score<60)reasons.push("data_quality_low");
   const priorRedemption=await db.prepare("SELECT 1 FROM promotion_redemptions WHERE customer_id=? AND created_at>=? LIMIT 1").bind(customer.customerId,monthStart).first<Row>();
   if(priorRedemption)reasons.push("frequency_cap_reached");
   const cohort=reasons.length?"suppressed":bucket(customer.customerId)<holdout?"holdout":"eligible";
   if(cohort==="suppressed")suppressed++;else if(cohort==="holdout")held++;else eligible++;
   statements.push(db.prepare("INSERT INTO promotion_audience_members (snapshot_id,promotion_id,customer_id,cohort,suppression_reason) VALUES (?,?,?,?,?)").bind(snapshotId,input.promotionId,customer.customerId,cohort,reasons.length?reasons.join(","):null));
 }
 for(let i=0;i<statements.length;i+=25)await db.batch(statements.slice(i,i+25));
 await db.batch([
   db.prepare("INSERT INTO promotion_audience_snapshots (id,promotion_id,snapshot_at,total_candidates,eligible_count,holdout_count,suppressed_count,policy_json,created_by) VALUES (?,?,?,?,?,?,?,?,?)").bind(snapshotId,input.promotionId,now,customers.length,eligible,held,suppressed,JSON.stringify({marketingConsentRequired:true,openCxSuppressed:true,duplicateSuppressed:true,dataQualityMinimum:60,frequencyCapMonthly:1,holdoutPercent:holdout}),input.actor),
   db.prepare("INSERT INTO promotion_governance_events (id,promotion_id,event_type,actor_email,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(uid("PROMOEVT"),input.promotionId,"audience_snapshotted",input.actor,JSON.stringify({snapshotId,eligible,holdout:held,suppressed}),now),
 ]);
 return{snapshotId,total:customers.length,eligible,holdout:held,suppressed};
}

export async function activatePromotion(db:Db,input:{promotionId:string;actor:string}){
 await ensurePromotionGovernance(db);
 const row=await db.prepare("SELECT * FROM governed_marketing_promotions WHERE id=?").bind(input.promotionId).first<Row>();
 if(!row)throw new Error("Promotion not found");
 if(String(row.approval_status)!=="approved")throw new Error("Promotion requires explicit approval before activation");
 const snapshot=await db.prepare("SELECT id FROM promotion_audience_snapshots WHERE promotion_id=? ORDER BY snapshot_at DESC LIMIT 1").bind(input.promotionId).first<Row>();
 if(!snapshot)throw new Error("Promotion requires a governed audience snapshot before activation");
 const now=Date.now();
 await db.batch([
   db.prepare("UPDATE governed_marketing_promotions SET status='active',updated_at=? WHERE id=?").bind(now,input.promotionId),
   db.prepare("INSERT INTO promotion_governance_events (id,promotion_id,event_type,actor_email,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(uid("PROMOEVT"),input.promotionId,"activated",input.actor,JSON.stringify({snapshotId:snapshot.id}),now),
 ]);
 return{promotionId:input.promotionId,status:"active"};
}

/** Real redemption tracking against the real budget cap - a redemption that would exceed the cap is rejected, not silently allowed. */
export async function recordPromotionRedemption(db:Db,input:{promotionId:string;customerId:string;bookingId?:string|null;discountAmount:number;idempotencyKey:string}){
 await ensurePromotionGovernance(db);
 const prior=await db.prepare("SELECT id FROM promotion_redemptions WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
 if(prior)return{duplicatePrevented:true};
 const promotion=await db.prepare("SELECT budget_cap,status FROM governed_marketing_promotions WHERE id=?").bind(input.promotionId).first<Row>();
 if(!promotion)throw new Error("Promotion not found");
 if(String(promotion.status)!=="active")throw new Error("Promotion is not active");
 const spent=await db.prepare("SELECT COALESCE(SUM(discount_amount),0) total FROM promotion_redemptions WHERE promotion_id=?").bind(input.promotionId).first<Row>();
 if(Number(spent?.total||0)+input.discountAmount>Number(promotion.budget_cap))throw new Error("Redemption would exceed the promotion's real budget cap");
 const id=uid("PROMORED"),now=Date.now();
 await db.prepare("INSERT INTO promotion_redemptions (id,promotion_id,customer_id,booking_id,discount_amount,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)")
   .bind(id,input.promotionId,input.customerId,input.bookingId||null,input.discountAmount,input.idempotencyKey,now).run();
 return{id,duplicatePrevented:false};
}

export async function setPromotionStatus(db:Db,input:{promotionId:string;status:"paused"|"completed";actor:string}){
 await ensurePromotionGovernance(db);
 const now=Date.now();
 await db.prepare("UPDATE governed_marketing_promotions SET status=?,updated_at=? WHERE id=?").bind(input.status,now,input.promotionId).run();
 await event(db,input.promotionId,"status_changed",input.actor,{status:input.status});
 return{id:input.promotionId,status:input.status};
}

async function event(db:Db,promotionId:string,eventType:string,actor:string,detail:unknown){
 await db.prepare("INSERT INTO promotion_governance_events (id,promotion_id,event_type,actor_email,detail_json,created_at) VALUES (?,?,?,?,?,?)")
   .bind(uid("PROMOEVT"),promotionId,eventType,actor,JSON.stringify(detail),Date.now()).run();
}

export async function listPromotions(db:Db){
 await ensurePromotionGovernance(db);
 const rows=await db.prepare("SELECT * FROM governed_marketing_promotions ORDER BY updated_at DESC LIMIT 100").all<Row>();
 return rows.results;
}
