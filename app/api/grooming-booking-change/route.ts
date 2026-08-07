import{authError,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";

type Db=Awaited<ReturnType<typeof database>>;
type Row=Record<string,unknown>;
type Input={bookingId:string;customerId:string;action:"cancel"|"reschedule";reason?:string;scheduledStart?:string;scheduledEnd?:string};

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}
async function ensureTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'reserved',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,service_package_code TEXT NOT NULL,total_sessions INTEGER NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 0,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_booking_id TEXT NOT NULL UNIQUE,catalogue_version TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);}
async function event(db:Db,bookingId:string,eventType:string,actorId:string,detail:unknown,now:number){await db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,eventType,"booking",bookingId,actorId,JSON.stringify(detail),now).run();}

export async function POST(request:Request){
  try{
    const input=await request.json() as Input;
    if(!input.bookingId||!input.customerId||!input.action)return json({error:"Booking, customer and action are required"},400);
    const db=await database();await ensureTables(db);
    const actor=await resolveActor(request);requirePermission(actor,"scheduling.book");
    const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=? AND service_code='grooming'").bind(input.bookingId).first<Row>();
    if(!booking)return json({error:"Grooming booking not found"},404);
    if(String(booking.customer_id)!==input.customerId)return json({error:"This customer does not own the booking"},403);
    await requireCustomerOwnership(db,actor,input.customerId);
    const status=String(booking.status);
    if(["completed","cancelled"].includes(status))return json({error:`Booking cannot be changed from ${status}`},409);
    const work=await db.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").bind(input.bookingId).first<Row>();
    const payment=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>();
    if(!work||!payment)return json({error:"Booking work order or payment record is missing"},409);
    const now=Date.now(),auditActor=actor.email;

    if(input.action==="cancel"){
      const reason=(input.reason||"Customer cancelled from PawSpace").trim();
      const captured=["captured","paid"].includes(String(payment.status));
      const refundId=captured?crypto.randomUUID():null;
      const usage=await db.prepare("SELECT * FROM booking_subscription_usage WHERE booking_id=?").bind(input.bookingId).first<Row>();
      const reservedSessions=usage?Number(usage.sessions_reserved||0):0;
      const subscriptionId=usage?String(usage.plan_code):"";
      const subscription=subscriptionId?await db.prepare("SELECT * FROM customer_grooming_subscriptions WHERE id=?").bind(subscriptionId).first<Row>():null;
      const statements=[
        db.prepare("UPDATE canonical_bookings SET status='cancelled',updated_at=? WHERE id=?").bind(now,input.bookingId),
        db.prepare("UPDATE provider_work_orders SET status='cancelled',updated_at=? WHERE booking_id=?").bind(now,input.bookingId),
        db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=?").bind(booking.schedule_group_id),
        db.prepare("UPDATE scheduling_assignment_decisions SET status='cancelled',actor_id=?,reason=?,updated_at=? WHERE group_id=?").bind(auditActor,reason,now,booking.schedule_group_id),
        db.prepare("UPDATE booking_payments SET status=?,detail_json=json_set(detail_json,'$.cancelReason',?),updated_at=? WHERE booking_id=?").bind(captured?"refund_pending":"cancelled",reason,now,input.bookingId),
        db.prepare("UPDATE booking_subscription_usage SET sessions_reserved=0,status=CASE WHEN sessions_consumed=0 THEN 'reversed' ELSE status END,updated_at=? WHERE booking_id=?").bind(now,input.bookingId),
      ];
      if(subscriptionId&&reservedSessions>0)statements.push(db.prepare("UPDATE customer_grooming_subscriptions SET sessions_reserved=MAX(0,sessions_reserved-?),status=CASE WHEN source_booking_id=? THEN ? ELSE status END,updated_at=? WHERE id=?").bind(reservedSessions,input.bookingId,captured?"refund_pending":"cancelled",now,subscriptionId));
      if(refundId)statements.push(db.prepare("INSERT OR IGNORE INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,'requested',?,?,?)").bind(refundId,input.bookingId,payment.id,Number(payment.amount||0),reason,auditActor,now,now));
      await db.batch(statements);
      await event(db,input.bookingId,"booking_cancelled",auditActor,{customerId:input.customerId,reason,capacityReleased:true,paymentStatus:captured?"refund_pending":"cancelled",refundCaseId:refundId,subscriptionId:subscription?.id??null,subscriptionSessionsReleased:reservedSessions,subscriptionStatus:subscription?captured?"refund_pending":"cancelled":null},now);
      await securityAudit(db,actor,"grooming.cancel","booking",input.bookingId,"completed",{customerId:input.customerId,refundCaseId:refundId,subscriptionId:subscription?.id??null,reservedSessions});
      return json({data:{bookingId:input.bookingId,status:"cancelled",paymentStatus:captured?"refund_pending":"cancelled",refundCaseId:refundId,capacityReleased:true,subscriptionSessionsReleased:reservedSessions}});
    }

    if(!input.scheduledStart||!input.scheduledEnd)return json({error:"New start and end times are required"},400);
    const start=new Date(input.scheduledStart),end=new Date(input.scheduledEnd);
    if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start)return json({error:"A valid future time range is required"},400);
    const providerId=String(work.provider_id);
    const conflicts=await db.prepare("SELECT id,group_id FROM scheduling_reservations WHERE provider_id=? AND group_id!=? AND status!='cancelled' AND scheduled_start<? AND scheduled_end>? LIMIT 1").bind(providerId,booking.schedule_group_id,end.toISOString(),start.toISOString()).first<Row>();
    if(conflicts)return json({error:"The assigned provider is no longer available for that slot"},409);
    const oldStart=String(booking.scheduled_start),oldEnd=String(booking.scheduled_end);
    await db.batch([
      db.prepare("UPDATE canonical_bookings SET scheduled_start=?,scheduled_end=?,status='assigned',updated_at=? WHERE id=?").bind(start.toISOString(),end.toISOString(),now,input.bookingId),
      db.prepare("UPDATE provider_work_orders SET scheduled_start=?,scheduled_end=?,status='assigned',updated_at=? WHERE booking_id=?").bind(start.toISOString(),end.toISOString(),now,input.bookingId),
      db.prepare("UPDATE scheduling_reservations SET scheduled_start=?,scheduled_end=?,status='assigned' WHERE group_id=?").bind(start.toISOString(),end.toISOString(),booking.schedule_group_id),
      db.prepare("UPDATE scheduling_assignment_decisions SET status='assigned',actor_id=?,reason=?,updated_at=? WHERE group_id=?").bind(auditActor,input.reason||"Customer rescheduled",now,booking.schedule_group_id),
    ]);
    await event(db,input.bookingId,"booking_rescheduled",auditActor,{customerId:input.customerId,from:{scheduledStart:oldStart,scheduledEnd:oldEnd},to:{scheduledStart:start.toISOString(),scheduledEnd:end.toISOString()},providerId,capacityRevalidated:true},now);
    await securityAudit(db,actor,"grooming.reschedule","booking",input.bookingId,"completed",{customerId:input.customerId,providerId});
    return json({data:{bookingId:input.bookingId,status:"assigned",scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),providerId}});
  }catch(error){return authError(error,"Unable to change Grooming booking");}
}
