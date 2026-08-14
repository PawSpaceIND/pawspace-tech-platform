import{refuseUnlessGatewayPermits}from"../../../lib/api-gateway";
import{authError,requirePermission,requireProviderOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{assertServiceProofRef}from"../../../lib/service-media-security";
import{tryQualifyLinkedReferral}from"../../../lib/referral-booking-governance";

type Db=Awaited<ReturnType<typeof database>>;
type Row=Record<string,unknown>;

type LifecycleAction="accept"|"on_the_way"|"arrived"|"start_service"|"add_proof"|"complete"|"mark_paid";
type LifecycleInput={bookingId:string;action:LifecycleAction;actorId?:string;beforePhotoRef?:string;afterPhotoRef?:string;checklist?:string[];completionNotes?:string;paymentReference?:string};

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}

async function ensureTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_service_proof (booking_id TEXT PRIMARY KEY,before_photo_ref TEXT,after_photo_ref TEXT,checklist_json TEXT NOT NULL DEFAULT '[]',completion_notes TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'reserved',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,service_package_code TEXT NOT NULL,total_sessions INTEGER NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 0,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_booking_id TEXT NOT NULL UNIQUE,catalogue_version TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS repeat_booking_tasks (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,eligible_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_tax_readiness (booking_id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,gross_amount REAL NOT NULL,tax_amount REAL,tax_rule_status TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_settlement_readiness (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL,gross_booking_amount REAL NOT NULL,payout_amount REAL,status TEXT NOT NULL,eligible_after INTEGER NOT NULL,rule_version TEXT,reason TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);}

function transition(current:string,action:LifecycleAction){const map:Record<LifecycleAction,Record<string,string>>={
  accept:{awaiting_acceptance:"assigned",confirmed:"assigned"},
  on_the_way:{assigned:"on_the_way",confirmed:"on_the_way"},
  arrived:{on_the_way:"arrived"},
  start_service:{arrived:"in_service"},
  add_proof:{assigned:"assigned",on_the_way:"on_the_way",arrived:"arrived",in_service:"in_service"},
  complete:{in_service:"completed"},
  mark_paid:{confirmed:"confirmed",assigned:"assigned",on_the_way:"on_the_way",arrived:"arrived",in_service:"in_service",completed:"completed"},
};return map[action][current];}

async function event(db:Db,bookingId:string,eventType:string,actorId:string,detail:unknown,now:number){await db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,eventType,"booking",bookingId,actorId,JSON.stringify(detail),now).run();}
async function referralQualification(db:Db,bookingId:string,actorId:string){try{return await tryQualifyLinkedReferral(db,{bookingId,actorId});}catch(error){const reason=error instanceof Error?error.message:"Referral qualification requires review";await event(db,bookingId,"referral_qualification_review_required",actorId,{reason},Date.now());return{applicable:true,status:"review_required",reason};}}

async function bundle(db:Db,bookingId:string){const booking=await db.prepare("SELECT b.*,w.id work_order_id,w.provider_name,w.provider_model,w.status work_order_status,p.id payment_id,p.status payment_status,p.method payment_method,p.mode payment_mode,p.amount,p.amount_due_now FROM canonical_bookings b JOIN provider_work_orders w ON w.booking_id=b.id JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=?").bind(bookingId).first<Row>();if(!booking)return null;const[proof,invoice,usage,repeat,tax,payout,events]=await Promise.all([
  db.prepare("SELECT * FROM grooming_service_proof WHERE booking_id=?").bind(bookingId).first<Row>(),
  db.prepare("SELECT * FROM booking_invoices WHERE booking_id=?").bind(bookingId).first<Row>(),
  db.prepare("SELECT * FROM booking_subscription_usage WHERE booking_id=?").bind(bookingId).first<Row>(),
  db.prepare("SELECT * FROM repeat_booking_tasks WHERE booking_id=?").bind(bookingId).first<Row>(),
  db.prepare("SELECT * FROM booking_tax_readiness WHERE booking_id=?").bind(bookingId).first<Row>(),
  db.prepare("SELECT * FROM provider_settlement_readiness WHERE booking_id=?").bind(bookingId).first<Row>(),
  db.prepare("SELECT * FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at DESC LIMIT 50").bind(bookingId).all<Row>(),
]);return{booking,proof,invoice,subscriptionUsage:usage,repeatTask:repeat,taxReadiness:tax,payoutReadiness:payout,events:events.results};}

export async function GET(request:Request){const denied=await refuseUnlessGatewayPermits(request);if(denied)return denied;try{const bookingId=new URL(request.url).searchParams.get("bookingId");if(!bookingId)return json({error:"Booking ID is required"},400);const db=await database();await ensureTables(db);const actor=await resolveActor(request);requirePermission(actor,"bookings.view");const work=await db.prepare("SELECT provider_id FROM provider_work_orders WHERE booking_id=?").bind(bookingId).first<Row>();if(work)await requireProviderOwnership(db,actor,String(work.provider_id));const data=await bundle(db,bookingId);return data?json({data}):json({error:"Booking not found"},404);}catch(error){return authError(error,"Unable to load grooming lifecycle");}}

export async function POST(request:Request){const denied=await refuseUnlessGatewayPermits(request);if(denied)return denied;try{const input=await request.json() as LifecycleInput;if(!input.bookingId||!input.action)return json({error:"Booking ID and action are required"},400);const db=await database();await ensureTables(db);const actorIdentity=await resolveActor(request);if(input.action==="mark_paid")requirePermission(actorIdentity,"payments.manage");else requirePermission(actorIdentity,"bookings.view");const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=? AND service_code='grooming'").bind(input.bookingId).first<Row>();if(!booking)return json({error:"Grooming booking not found"},404);const work=await db.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").bind(input.bookingId).first<Row>();if(!work)return json({error:"Provider work order not found"},409);if(input.action!=="mark_paid")await requireProviderOwnership(db,actorIdentity,String(work.provider_id));const current=String(booking.status),next=transition(current,input.action);if(!next)return json({error:`Action ${input.action} is not allowed from ${current}`},409);const actor=actorIdentity.email,now=Date.now();

  if(input.action==="add_proof"){
    if(!input.beforePhotoRef&&!input.afterPhotoRef&&!(input.checklist?.length))return json({error:"Photo reference or checklist evidence is required"},400);
    await assertServiceProofRef(db,{ref:input.beforePhotoRef,bookingId:input.bookingId,providerId:String(work.provider_id),purpose:"before_service"});await assertServiceProofRef(db,{ref:input.afterPhotoRef,bookingId:input.bookingId,providerId:String(work.provider_id),purpose:"after_service"});
    await db.prepare("INSERT INTO grooming_service_proof (booking_id,before_photo_ref,after_photo_ref,checklist_json,completion_notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET before_photo_ref=COALESCE(excluded.before_photo_ref,before_photo_ref),after_photo_ref=COALESCE(excluded.after_photo_ref,after_photo_ref),checklist_json=CASE WHEN excluded.checklist_json!='[]' THEN excluded.checklist_json ELSE checklist_json END,completion_notes=COALESCE(excluded.completion_notes,completion_notes),updated_at=excluded.updated_at").bind(input.bookingId,input.beforePhotoRef??null,input.afterPhotoRef??null,JSON.stringify(input.checklist??[]),input.completionNotes??null,now,now).run();
    await event(db,input.bookingId,"service_proof_updated",actor,{providerId:work.provider_id,beforePhotoRef:input.beforePhotoRef,afterPhotoRef:input.afterPhotoRef,checklist:input.checklist??[]},now);
    await securityAudit(db,actorIdentity,"grooming.add_proof","booking",input.bookingId,"completed",{providerId:work.provider_id});
    return json({data:await bundle(db,input.bookingId)});
  }

  if(input.action==="mark_paid"){
    await db.prepare("UPDATE booking_payments SET status='captured',gateway=CASE WHEN gateway='uat_sandbox' THEN gateway ELSE gateway END,detail_json=json_set(detail_json,'$.paymentReference',?),updated_at=? WHERE booking_id=?").bind(input.paymentReference??"manual-reconciliation",now,input.bookingId).run();
    const referral=await referralQualification(db,input.bookingId,actor);
    await event(db,input.bookingId,"payment_captured",actor,{paymentReference:input.paymentReference??"manual-reconciliation",referral},now);
    await securityAudit(db,actorIdentity,"grooming.mark_paid","booking",input.bookingId,"completed",{paymentReference:input.paymentReference??"manual-reconciliation",referral});
    return json({data:await bundle(db,input.bookingId),referral});
  }

  if(input.action==="complete"){
    const proof=await db.prepare("SELECT * FROM grooming_service_proof WHERE booking_id=?").bind(input.bookingId).first<Row>();
    const checklist=proof?JSON.parse(String(proof.checklist_json||"[]")) as unknown[]:[];
    if(!proof?.before_photo_ref||!proof?.after_photo_ref||checklist.length===0)return json({error:"Before photo, after photo and completion checklist are required"},409);
    await assertServiceProofRef(db,{ref:String(proof.before_photo_ref),bookingId:input.bookingId,providerId:String(work.provider_id),purpose:"before_service"});await assertServiceProofRef(db,{ref:String(proof.after_photo_ref),bookingId:input.bookingId,providerId:String(work.provider_id),purpose:"after_service"});
    const payment=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>();
    const usage=await db.prepare("SELECT * FROM booking_subscription_usage WHERE booking_id=?").bind(input.bookingId).first<Row>();
    const invoiceId=`INV-${crypto.randomUUID().slice(0,8).toUpperCase()}`,invoiceNumber=`PS-${new Date(now).getUTCFullYear()}-${String(now).slice(-8)}`,eligibleAfter=now+24*60*60*1000;
    const sessionsToConsume=usage?Number(usage.sessions_reserved||0):0;
    const statements=[
      db.prepare("UPDATE canonical_bookings SET status='completed',updated_at=? WHERE id=?").bind(now,input.bookingId),
      db.prepare("UPDATE provider_work_orders SET status='completed',updated_at=? WHERE booking_id=?").bind(now,input.bookingId),
      db.prepare("INSERT OR IGNORE INTO booking_invoices (id,booking_id,customer_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(invoiceId,input.bookingId,booking.customer_id,invoiceNumber,"issued","INR",Number(booking.total_amount),0,Number(booking.total_amount),now,now,now),
      db.prepare("INSERT OR IGNORE INTO booking_tax_readiness (booking_id,invoice_id,gross_amount,tax_amount,tax_rule_status,reason,created_at,updated_at) VALUES (?,?,?,NULL,'configuration_required','Production GST/tax rule is not yet approved; UAT invoice must not be treated as a production tax invoice',?,?)").bind(input.bookingId,invoiceId,Number(booking.total_amount),now,now),
      db.prepare("INSERT OR IGNORE INTO provider_settlement_readiness (booking_id,provider_id,provider_model,gross_booking_amount,payout_amount,status,eligible_after,rule_version,reason,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?,NULL,?,?,?)").bind(input.bookingId,work.provider_id,work.provider_model,Number(booking.total_amount),String(work.provider_model)==="commission"?"rule_pending":"not_applicable",eligibleAfter,String(work.provider_model)==="commission"?"Provider payout percentage/travel/incentive/penalty rule must be approved before payout instruction":"Full-time provider does not use per-job commission payout in this UAT rule",now,now),
      db.prepare("INSERT OR IGNORE INTO repeat_booking_tasks (id,booking_id,customer_id,service_code,eligible_at,status,created_at,updated_at) VALUES (?,?,?,?,?,'open',?,?)").bind(crypto.randomUUID(),input.bookingId,booking.customer_id,"grooming",now+21*86_400_000,now,now),
    ];
    if(usage&&sessionsToConsume>0){statements.push(
      db.prepare("UPDATE booking_subscription_usage SET sessions_consumed=sessions_reserved,status='consumed',updated_at=? WHERE booking_id=? AND status='reserved'").bind(now,input.bookingId),
      // No status filter: a subscription paused or in expiry-grace AFTER the reservation must still
      // settle its reserved credits at completion, or sessions_reserved leaks forever (wallet drift).
      // Double-consumption stays impossible via the usage row's status='reserved' guard above; the
      // exhausted CASE only promotes active subscriptions.
      db.prepare("UPDATE customer_grooming_subscriptions SET sessions_reserved=MAX(0,sessions_reserved-?),sessions_consumed=sessions_consumed+?,status=CASE WHEN status='active' AND sessions_consumed+?>=total_sessions THEN 'exhausted' ELSE status END,updated_at=? WHERE id=?").bind(sessionsToConsume,sessionsToConsume,sessionsToConsume,now,usage.plan_code)
    );}
    await db.batch(statements);
    const referral=await referralQualification(db,input.bookingId,actor);
    await event(db,input.bookingId,"service_completed",actor,{providerId:work.provider_id,invoiceNumber,paymentStatus:String(payment?.status||"unknown"),subscriptionSessionsConsumed:sessionsToConsume,repeatEligibleAt:now+21*86_400_000,taxRuleStatus:"configuration_required",payoutReadiness:String(work.provider_model)==="commission"?"rule_pending":"not_applicable",referral},now);
    await securityAudit(db,actorIdentity,"grooming.complete","booking",input.bookingId,"completed",{providerId:work.provider_id,invoiceNumber,sessionsToConsume,referral});
    return json({data:await bundle(db,input.bookingId),referral});
  }

  await db.batch([
    db.prepare("UPDATE canonical_bookings SET status=?,updated_at=? WHERE id=?").bind(next,now,input.bookingId),
    db.prepare("UPDATE provider_work_orders SET status=?,updated_at=? WHERE booking_id=?").bind(next,now,input.bookingId),
  ]);
  await event(db,input.bookingId,`booking_${next}`,actor,{providerId:work.provider_id,from:current,to:next},now);
  await securityAudit(db,actorIdentity,`grooming.${input.action}`,"booking",input.bookingId,"completed",{providerId:work.provider_id,from:current,to:next});
  return json({data:await bundle(db,input.bookingId)});
}catch(error){return authError(error,"Unable to update grooming lifecycle");}}