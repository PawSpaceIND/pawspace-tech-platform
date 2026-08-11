type Db=D1Database;
type Row=Record<string,unknown>;

export type SubscriptionWalletAction="reserve"|"consume"|"release"|"pause"|"resume"|"refresh_expiry";
export type SubscriptionWalletMutation={subscriptionId:string;action:SubscriptionWalletAction;idempotencyKey:string;bookingId?:string;credits?:number;reason?:string;pauseDays?:number;actorId:string};

const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??"")) as T}catch{return fallback}};

export async function ensureSubscriptionWalletTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,service_package_code TEXT NOT NULL,total_sessions INTEGER NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 0,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_booking_id TEXT NOT NULL UNIQUE,catalogue_version TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'reserved',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_subscription_purchase_snapshots (subscription_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,city_id TEXT NOT NULL,zone_id TEXT,plan_code TEXT NOT NULL,catalogue_version TEXT NOT NULL,config_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS subscription_wallet_events (id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL,booking_id TEXT,event_type TEXT NOT NULL,credits INTEGER NOT NULL DEFAULT 0,balance_after INTEGER NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS subscription_pause_periods (id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL,status TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER,requested_days INTEGER NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);}

async function snapshot(db:Db,subscriptionId:string){return db.prepare("SELECT config_json FROM grooming_subscription_purchase_snapshots WHERE subscription_id=?").bind(subscriptionId).first<{config_json:string}>();}

function configOf(row:{config_json?:string}|null){return parse<{pauseDays?:number;graceDays?:number;renewalWindowDays?:number;familyWallet?:boolean}>(row?.config_json,{});}

export async function readSubscriptionWallet(db:Db,subscriptionId:string){await ensureSubscriptionWalletTables(db);const subscription=await db.prepare("SELECT * FROM customer_grooming_subscriptions WHERE id=?").bind(subscriptionId).first<Row>();if(!subscription)return null;const [snap,usage,pauses,events]=await Promise.all([
  snapshot(db,subscriptionId),
  db.prepare("SELECT * FROM booking_subscription_usage WHERE plan_code=? ORDER BY created_at DESC").bind(subscriptionId).all<Row>(),
  db.prepare("SELECT * FROM subscription_pause_periods WHERE subscription_id=? ORDER BY created_at DESC LIMIT 20").bind(subscriptionId).all<Row>(),
  db.prepare("SELECT * FROM subscription_wallet_events WHERE subscription_id=? ORDER BY created_at DESC LIMIT 100").bind(subscriptionId).all<Row>(),
]);const cfg=configOf(snap),total=Number(subscription.total_sessions||0),reserved=Number(subscription.sessions_reserved||0),consumed=Number(subscription.sessions_consumed||0),available=Math.max(0,total-reserved-consumed),now=Date.now(),expiresAt=Number(subscription.expires_at||0),graceDays=Math.max(0,Number(cfg.graceDays||0)),graceEndsAt=expiresAt+graceDays*86_400_000,renewalWindowDays=Math.max(0,Number(cfg.renewalWindowDays||0)),renewalStartsAt=expiresAt-renewalWindowDays*86_400_000;return{subscription,balances:{total,reserved,consumed,available},policy:{pauseDays:Math.max(0,Number(cfg.pauseDays||0)),graceDays,renewalWindowDays,familyWallet:cfg.familyWallet!==false},readiness:{expired:now>graceEndsAt,inGrace:now>expiresAt&&now<=graceEndsAt,renewalDue:now>=renewalStartsAt,expiresAt,graceEndsAt,renewalStartsAt,autoRenewal:false,renewalPricing:"configuration_required"},usage:usage.results,pauses:pauses.results,events:events.results,testOnly:true,liveMoney:false};}

async function activeSubscription(db:Db,id:string){const row=await db.prepare("SELECT * FROM customer_grooming_subscriptions WHERE id=?").bind(id).first<Row>();if(!row)throw new Error("Subscription not found");return row;}
async function priorEvent(db:Db,key:string){return db.prepare("SELECT * FROM subscription_wallet_events WHERE idempotency_key=?").bind(key).first<Row>();}
function balance(row:Row){return Math.max(0,Number(row.total_sessions||0)-Number(row.sessions_reserved||0)-Number(row.sessions_consumed||0));}
async function addEvent(db:Db,input:SubscriptionWalletMutation,eventType:string,credits:number,balanceAfter:number,detail:Record<string,unknown>={}){await db.prepare("INSERT INTO subscription_wallet_events (id,subscription_id,booking_id,event_type,credits,balance_after,idempotency_key,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.subscriptionId,input.bookingId??null,eventType,credits,balanceAfter,input.idempotencyKey,input.actorId,JSON.stringify(detail),Date.now()).run();}

export async function mutateSubscriptionWallet(db:Db,input:SubscriptionWalletMutation){await ensureSubscriptionWalletTables(db);if(!input.subscriptionId||!input.action||!input.idempotencyKey||!input.actorId)throw new Error("Subscription, action, idempotency key and actor are required");const prior=await priorEvent(db,input.idempotencyKey);if(prior)return{duplicatePrevented:true,event:prior,wallet:await readSubscriptionWallet(db,input.subscriptionId)};const subscription=await activeSubscription(db,input.subscriptionId),now=Date.now(),snap=await snapshot(db,input.subscriptionId),cfg=configOf(snap),graceEndsAt=Number(subscription.expires_at)+Math.max(0,Number(cfg.graceDays||0))*86_400_000;

 if(input.action==="refresh_expiry"){const expired=now>graceEndsAt;if(expired&&!["exhausted","cancelled"].includes(String(subscription.status)))await db.prepare("UPDATE customer_grooming_subscriptions SET status='expired',updated_at=? WHERE id=?").bind(now,input.subscriptionId).run();const current=await activeSubscription(db,input.subscriptionId);await addEvent(db,input,"expiry_checked",0,balance(current),{expired,graceEndsAt});return{duplicatePrevented:false,wallet:await readSubscriptionWallet(db,input.subscriptionId)};}

 if(input.action==="pause"){if(String(subscription.status)!=="active")throw new Error("Only an active subscription can be paused");const allowed=Math.max(0,Number(cfg.pauseDays||0)),days=Math.floor(Number(input.pauseDays||0));if(allowed<1)throw new Error("This plan has no configured pause entitlement");if(days<1||days>allowed)throw new Error(`Pause must be between 1 and ${allowed} configured days`);const usedRow=await db.prepare("SELECT COALESCE(SUM(requested_days),0) used FROM subscription_pause_periods WHERE subscription_id=? AND status IN ('active','completed')").bind(input.subscriptionId).first<{used:number}>(),used=Number(usedRow?.used||0);if(used+days>allowed)throw new Error("Configured pause entitlement would be exceeded");if(!String(input.reason||"").trim())throw new Error("Pause reason is required");const pauseId=`SUBPAUSE-${crypto.randomUUID().slice(0,10).toUpperCase()}`;await db.batch([db.prepare("UPDATE customer_grooming_subscriptions SET status='paused',updated_at=? WHERE id=?").bind(now,input.subscriptionId),db.prepare("INSERT INTO subscription_pause_periods (id,subscription_id,status,start_at,end_at,requested_days,reason,actor_id,created_at,updated_at) VALUES (?,?,'active',?,NULL,?,?,?,?,?)").bind(pauseId,input.subscriptionId,now,days,String(input.reason).trim(),input.actorId,now,now)]);await addEvent(db,input,"paused",0,balance(subscription),{pauseId,requestedDays:days,expiryExtension:"policy_required"});return{duplicatePrevented:false,wallet:await readSubscriptionWallet(db,input.subscriptionId)};}

 if(input.action==="resume"){if(String(subscription.status)!=="paused")throw new Error("Only a paused subscription can be resumed");const pause=await db.prepare("SELECT * FROM subscription_pause_periods WHERE subscription_id=? AND status='active' ORDER BY created_at DESC LIMIT 1").bind(input.subscriptionId).first<Row>();if(!pause)throw new Error("Active pause record is missing");await db.batch([db.prepare("UPDATE customer_grooming_subscriptions SET status='active',updated_at=? WHERE id=?").bind(now,input.subscriptionId),db.prepare("UPDATE subscription_pause_periods SET status='completed',end_at=?,updated_at=? WHERE id=?").bind(now,now,pause.id)]);await addEvent(db,input,"resumed",0,balance(subscription),{pauseId:pause.id,expiryExtension:"policy_required"});return{duplicatePrevented:false,wallet:await readSubscriptionWallet(db,input.subscriptionId)};}

 if(!input.bookingId)throw new Error("Booking is required for credit movements");if(!["active","exhausted"].includes(String(subscription.status)))throw new Error(`Subscription is ${String(subscription.status)} and cannot move booking credits`);if(now>graceEndsAt)throw new Error("Subscription has expired beyond its configured grace period");const booking=await db.prepare("SELECT id,customer_id,service_code,package_code,status FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();if(!booking)throw new Error("Canonical booking not found");if(String(booking.customer_id)!==String(subscription.customer_id))throw new Error("Booking and subscription customer do not match");if(String(booking.service_code)!=="grooming")throw new Error("This UAT wallet currently supports Grooming bookings only");const credits=Math.floor(Number(input.credits||1));if(credits<1)throw new Error("Credits must be a positive integer");

 if(input.action==="reserve"){const existing=await db.prepare("SELECT * FROM booking_subscription_usage WHERE booking_id=?").bind(input.bookingId).first<Row>();if(existing)throw new Error("Booking already has a subscription reservation");const available=balance(subscription);if(available<credits)throw new Error("Subscription does not have enough available credits");if(["completed","cancelled"].includes(String(booking.status)))throw new Error("Credits cannot be reserved for a completed or cancelled booking");await db.batch([db.prepare("INSERT INTO booking_subscription_usage (id,booking_id,customer_id,plan_code,sessions_reserved,sessions_consumed,status,created_at,updated_at) VALUES (?,?,?,?,?,0,'reserved',?,?)").bind(crypto.randomUUID(),input.bookingId,subscription.customer_id,input.subscriptionId,credits,now,now),db.prepare("UPDATE customer_grooming_subscriptions SET sessions_reserved=sessions_reserved+?,updated_at=? WHERE id=? AND sessions_reserved+sessions_consumed+?<=total_sessions").bind(credits,now,input.subscriptionId,credits)]);const current=await activeSubscription(db,input.subscriptionId);await addEvent(db,input,"reserved",credits,balance(current),{bookingStatus:booking.status});return{duplicatePrevented:false,wallet:await readSubscriptionWallet(db,input.subscriptionId)};}

 const usage=await db.prepare("SELECT * FROM booking_subscription_usage WHERE booking_id=? AND plan_code=?").bind(input.bookingId,input.subscriptionId).first<Row>();if(!usage)throw new Error("Booking has no reservation against this subscription");if(input.action==="consume"){if(String(booking.status)!=="completed")throw new Error("Credits can only be consumed after canonical service completion");if(String(usage.status)==="consumed")throw new Error("Booking credits are already consumed");if(String(usage.status)!=="reserved")throw new Error(`Booking credit status ${String(usage.status)} cannot be consumed`);const reserved=Number(usage.sessions_reserved||0);await db.batch([db.prepare("UPDATE booking_subscription_usage SET sessions_consumed=sessions_reserved,status='consumed',updated_at=? WHERE booking_id=? AND status='reserved'").bind(now,input.bookingId),db.prepare("UPDATE customer_grooming_subscriptions SET sessions_reserved=MAX(0,sessions_reserved-?),sessions_consumed=sessions_consumed+?,status=CASE WHEN sessions_consumed+?>=total_sessions THEN 'exhausted' ELSE status END,updated_at=? WHERE id=?").bind(reserved,reserved,reserved,now,input.subscriptionId)]);const current=await activeSubscription(db,input.subscriptionId);await addEvent(db,input,"consumed",reserved,balance(current),{bookingStatus:booking.status});return{duplicatePrevented:false,wallet:await readSubscriptionWallet(db,input.subscriptionId)};}

 if(input.action==="release"){if(String(booking.status)==="completed")throw new Error("Consumed/completed service credits cannot be released");if(String(usage.status)!=="reserved")throw new Error(`Only reserved credits can be released; current status is ${String(usage.status)}`);const reserved=Number(usage.sessions_reserved||0);await db.batch([db.prepare("UPDATE booking_subscription_usage SET status='released',updated_at=? WHERE booking_id=? AND status='reserved'").bind(now,input.bookingId),db.prepare("UPDATE customer_grooming_subscriptions SET sessions_reserved=MAX(0,sessions_reserved-?),status=CASE WHEN status='exhausted' AND total_sessions-sessions_consumed>0 THEN 'active' ELSE status END,updated_at=? WHERE id=?").bind(reserved,now,input.subscriptionId)]);const current=await activeSubscription(db,input.subscriptionId);await addEvent(db,input,"released",reserved,balance(current),{bookingStatus:booking.status,reason:String(input.reason||"booking_credit_release")});return{duplicatePrevented:false,wallet:await readSubscriptionWallet(db,input.subscriptionId)};}

 throw new Error("Unsupported subscription wallet action");}

export async function listCustomerSubscriptionWallets(db:Db,customerId:string){await ensureSubscriptionWalletTables(db);const rows=await db.prepare("SELECT id FROM customer_grooming_subscriptions WHERE customer_id=? ORDER BY created_at DESC").bind(customerId).all<{id:string}>();const wallets=[];for(const row of rows.results){const wallet=await readSubscriptionWallet(db,row.id);if(wallet)wallets.push(wallet);}return wallets;}

/**
 * Real business-level subscription metrics for Founder BI - segments by real expiry proximity,
 * real utilisation (sessions_consumed/total_sessions), and real unused-credit liability computed
 * from each subscription's own real per-session plan price (price/session_count), not an assumed
 * average. A subscription whose plan_code no longer resolves to a real price is excluded from the
 * liability total rather than silently valued at zero - missing price data should shrink the
 * denominator, not understate the liability.
 */
export async function buildSubscriptionBusinessView(db:Db,asOf=Date.now()){
  await ensureSubscriptionWalletTables(db);
  const subs=await db.prepare("SELECT id,customer_id,plan_code,total_sessions,sessions_consumed,status,expires_at FROM customer_grooming_subscriptions").all<Row>();
  const planCodes=[...new Set(subs.results.map(s=>String(s.plan_code)))];
  const priceByPlan=new Map<string,{price:number;sessions:number}>();
  if(planCodes.length){
    const placeholders=planCodes.map(()=>"?").join(",");
    const plans=await db.prepare(`SELECT plan_code,price,session_count FROM grooming_subscription_plans WHERE plan_code IN (${placeholders}) AND active=1`).bind(...planCodes).all<Row>();
    for(const p of plans.results)if(!priceByPlan.has(String(p.plan_code)))priceByPlan.set(String(p.plan_code),{price:Number(p.price),sessions:Number(p.session_count)});
  }
  const day=86_400_000,segments={active:[] as Row[],renewalDue7:[] as Row[],expiring30:[] as Row[],expiredWinback:[] as Row[],paused:[] as Row[],cancelled:[] as Row[]};
  let priceKnown=0,priceUnknown=0,liability=0;
  for(const s of subs.results){
    const expiresAt=Number(s.expires_at),status=String(s.status),remaining=Math.max(0,Number(s.total_sessions)-Number(s.sessions_consumed));
    const plan=priceByPlan.get(String(s.plan_code));
    if(plan&&plan.sessions>0){priceKnown++;liability+=remaining*(plan.price/plan.sessions);}else priceUnknown++;
    if(status==="paused"){segments.paused.push(s);continue;}
    if(status==="cancelled"){segments.cancelled.push(s);continue;}
    if(expiresAt<asOf){segments.expiredWinback.push(s);continue;}
    if(expiresAt<=asOf+7*day){segments.renewalDue7.push(s);continue;}
    if(expiresAt<=asOf+30*day){segments.expiring30.push(s);continue;}
    segments.active.push(s);
  }
  const utilisation=(rows:Row[])=>{const totals=rows.reduce((acc:{total:number;consumed:number},s)=>({total:acc.total+Number(s.total_sessions),consumed:acc.consumed+Number(s.sessions_consumed)}),{total:0,consumed:0});return totals.total?Math.round((totals.consumed/totals.total)*1000)/10:null;};
  const households=(rows:Row[])=>new Set(rows.map(s=>String(s.customer_id))).size;
  return{
    asOf,
    liabilityStatus:priceUnknown>0?"partial_price_coverage":(priceKnown>0?"complete":"no_subscriptions"),
    unusedCreditLiability:priceKnown>0?Math.round(liability):null,
    priceCoverage:{known:priceKnown,unknown:priceUnknown},
    segments:{
      active:{count:segments.active.length,households:households(segments.active),utilisationPct:utilisation(segments.active)},
      renewalDue7:{count:segments.renewalDue7.length,households:households(segments.renewalDue7),utilisationPct:utilisation(segments.renewalDue7)},
      expiring30:{count:segments.expiring30.length,households:households(segments.expiring30),utilisationPct:utilisation(segments.expiring30)},
      expiredWinback:{count:segments.expiredWinback.length,households:households(segments.expiredWinback),utilisationPct:utilisation(segments.expiredWinback)},
      paused:{count:segments.paused.length,households:households(segments.paused)},
      cancelled:{count:segments.cancelled.length,households:households(segments.cancelled)},
    },
    pauseCancelRate:subs.results.length?Math.round(((segments.paused.length+segments.cancelled.length)/subs.results.length)*1000)/10:null,
  };
}
