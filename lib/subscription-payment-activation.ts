/**
 * Grooming subscription entitlement, gated on verified payment.
 *
 * A subscription purchase used to be the one place where LIVE money took the client's word for it. The
 * verify-first demotion in app/api/canonical-bookings carried an explicit `!isSubscription` exemption,
 * because the purchase gate demanded a captured payment before credits could be created — so demoting
 * the status would have made subscriptions unbuyable. The result was that posting a booking with
 * `{method:"upi",status:"captured"}` in LIVE created `customer_grooming_subscriptions` with
 * `status='active'` and its sessions reserved, from an assertion no gateway had verified. Ten grooming
 * sessions, redeemable immediately, for an HTTP request.
 *
 * The fix is not to demote the status and leave the gate — that really would break subscription
 * purchase. It is to separate the PURCHASE from the ENTITLEMENT:
 *
 *   booking + payment    created immediately, the payment awaiting gateway verification
 *   entitlement          written in `pending_payment` with ZERO sessions reserved, usable by nobody
 *   verified capture     activates it exactly once (this module), reserving the plan's sessions
 *   verified failure     closes it as `payment_failed`; no usable credits ever existed
 *
 * `pending_payment` is not a cosmetic label. mutateSubscriptionWallet only moves credits for a
 * subscription whose status is in ('active','exhausted'), so a pending entitlement cannot be reserved,
 * consumed or released, and coupon/reminder/BI reads that filter on 'active' do not see it either.
 *
 * Sandbox is unchanged and explicitly so: there the recorded payment status stays 'captured', the
 * entitlement is written active at purchase, and this module never has to run.
 */

type Db=D1Database;
type Row=Record<string,unknown>;

export const PENDING_PAYMENT_STATUS="pending_payment";

/** The sessions a plan reserves for its own purchase booking, taken from the purchase snapshot. */
function reservedSessionsOf(snapshot:Row|null,fallbackTotal:number){
 try{
  const config=JSON.parse(String(snapshot?.config_json||"{}")) as {reserveSessions?:unknown};
  const reserve=Number(config?.reserveSessions??NaN);
  if(Number.isFinite(reserve)&&reserve>=0)return Math.floor(reserve);
 }catch{/* a malformed snapshot must not strand a paid subscription */}
 return Math.max(0,Math.floor(fallbackTotal>0?1:0));
}

async function pendingSubscription(db:Db,bookingId:string){
 return db.prepare("SELECT id,customer_id,total_sessions,status FROM customer_grooming_subscriptions WHERE source_booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
}

/**
 * Activate the entitlement a verified capture has now paid for.
 *
 * ATOMIC and idempotent. The entitlement, its usage row and the audit event move in ONE db.batch — a
 * D1 transaction — so a failure in any dependent write rolls the whole thing back and leaves the
 * subscription cleanly `pending_payment` rather than half-activated (active entitlement, unreserved
 * usage). The earlier version updated the entitlement and then swallowed failures on the usage and
 * lifecycle writes, which could strand exactly that inconsistent state.
 *
 * Exactly once: the read-check short-circuits a replay after success (nothing to do), and every write in
 * the batch is guarded `WHERE status='pending_payment'`, so even a concurrent second capture cannot
 * reserve the sessions twice. If the batch throws, the caller sees it and the transition stays available
 * for the next verified capture / webhook redelivery to complete — money is never granted, never twice.
 */
export async function activateSubscriptionOnCapture(db:Db,input:{bookingId:string;eventId?:string;at?:number}):Promise<{outcome:"activated"|"already_active"|"none";subscriptionId?:string;sessionsReserved?:number}>{
 const bookingId=String(input.bookingId||"").trim();
 if(!bookingId)return{outcome:"none"};
 const subscription=await pendingSubscription(db,bookingId);
 if(!subscription)return{outcome:"none"};
 const subscriptionId=String(subscription.id);
 if(String(subscription.status)!==PENDING_PAYMENT_STATUS)return{outcome:"already_active",subscriptionId};
 const snapshot=await db.prepare("SELECT config_json FROM grooming_subscription_purchase_snapshots WHERE subscription_id=?").bind(subscriptionId).first<Row>().catch(()=>null);
 const reserve=reservedSessionsOf(snapshot,Number(subscription.total_sessions||0)),now=input.at??Date.now();
 const results=await db.batch([
  db.prepare("UPDATE customer_grooming_subscriptions SET status='active',sessions_reserved=?,updated_at=? WHERE id=? AND status=?").bind(reserve,now,subscriptionId,PENDING_PAYMENT_STATUS),
  db.prepare("UPDATE booking_subscription_usage SET status='reserved',sessions_reserved=?,updated_at=? WHERE booking_id=? AND plan_code=? AND status=?").bind(reserve,now,bookingId,subscriptionId,PENDING_PAYMENT_STATUS),
  db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,"subscription_activated","subscription",subscriptionId,"razorpay_webhook",JSON.stringify({sessionsReserved:reserve,eventId:input.eventId??null,verified:true}),now),
 ]);
 if(!Number(results?.[0]?.meta?.changes||0))return{outcome:"already_active",subscriptionId};
 return{outcome:"activated",subscriptionId,sessionsReserved:reserve};
}

/**
 * A verified payment failure on a subscription purchase. The pending entitlement closes; it never held
 * usable credits, and it must not be left looking like something a later manual step could activate.
 */
export async function failSubscriptionOnPaymentFailure(db:Db,input:{bookingId:string;eventId?:string;at?:number}):Promise<{outcome:"failed"|"ignored"|"none";subscriptionId?:string}>{
 const bookingId=String(input.bookingId||"").trim();
 if(!bookingId)return{outcome:"none"};
 const subscription=await pendingSubscription(db,bookingId);
 if(!subscription)return{outcome:"none"};
 const subscriptionId=String(subscription.id),now=input.at??Date.now();
 if(String(subscription.status)!==PENDING_PAYMENT_STATUS)return{outcome:"ignored",subscriptionId};
 // Atomic and idempotent, for the same reasons as activation: the entitlement, its usage row and the
 // audit event close together or not at all, and the guarded writes make a replay a no-op.
 const results=await db.batch([
  db.prepare("UPDATE customer_grooming_subscriptions SET status='payment_failed',sessions_reserved=0,updated_at=? WHERE id=? AND status=?").bind(now,subscriptionId,PENDING_PAYMENT_STATUS),
  db.prepare("UPDATE booking_subscription_usage SET status='payment_failed',sessions_reserved=0,updated_at=? WHERE booking_id=? AND plan_code=? AND status=?").bind(now,bookingId,subscriptionId,PENDING_PAYMENT_STATUS),
  db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,"subscription_payment_failed","subscription",subscriptionId,"razorpay_webhook",JSON.stringify({eventId:input.eventId??null}),now),
 ]);
 if(!Number(results?.[0]?.meta?.changes||0))return{outcome:"ignored",subscriptionId};
 return{outcome:"failed",subscriptionId};
}
