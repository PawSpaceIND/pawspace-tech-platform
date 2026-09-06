import{authError,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{hasPermission}from"../../../lib/platform-security";
import{getStayPaymentSchedule,payStayBalance,sweepOverdueStayBalances}from"../../../lib/stay-split-payments";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function runtime(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}
async function database(){return (await runtime()).DB as D1Database;}

// 50/50 split payment balance surface. Gateway maps this route to "scheduling.book" (customer
// role has it); staff with bookings.manage may read/settle any booking. Per-record ownership for
// customers is enforced here via requireCustomerOwnership against the schedule's customer_id.

export async function GET(request:Request){try{
  const url=new URL(request.url),bookingId=String(url.searchParams.get("bookingId")||"").trim();
  if(!bookingId)return json({error:"bookingId is required"},400);
  const db=await database(),actor=await resolveActor(request);
  requirePermission(actor,"scheduling.book");
  const schedule=await getStayPaymentSchedule(db,bookingId);
  if(!schedule)return json({data:null});
  if(!hasPermission(actor.permissions,"bookings.manage"))await requireCustomerOwnership(db,actor,schedule.customerId);
  return json({data:schedule});
}catch(error){return authError(error,"Unable to load the stay payment schedule");}}

export async function POST(request:Request){try{
  const body=await request.json() as{action?:string;bookingId?:string;idempotencyKey?:string};
  const env=await runtime(),db=env.DB as D1Database,actor=await resolveActor(request);
  const action=String(body.action||"pay_balance");
  if(action==="sweep_overdue"){
    // Ops/cron surface: mark past-due balances overdue so alerts can act on them.
    requirePermission(actor,"bookings.manage");
    const result=await sweepOverdueStayBalances(db);
    await securityAudit(db,actor,"stay_balance.sweep_overdue","stay_payment_schedule","*","completed",{marked:result.marked,overdueCount:result.overdue.length});
    return json({data:{marked:result.marked,overdue:result.overdue}});
  }
  if(action!=="pay_balance")return json({error:"Unsupported stay balance action"},400);
  if(String(env.PAWSPACE_PAYMENT_ENV??"").trim().toLowerCase()==="production")throw new Response("Self-paid stay balance settlement is disabled in production",{status:503});
  requirePermission(actor,"scheduling.book");
  const bookingId=String(body.bookingId||"").trim(),idempotencyKey=String(body.idempotencyKey||"").trim();
  if(!bookingId||!idempotencyKey)return json({error:"bookingId and idempotencyKey are required"},400);
  const schedule=await getStayPaymentSchedule(db,bookingId);
  if(!schedule)return json({error:"No split payment schedule exists for this booking"},404);
  if(!hasPermission(actor.permissions,"bookings.manage"))await requireCustomerOwnership(db,actor,schedule.customerId);
  const result=await payStayBalance(db,{bookingId,actorId:actor.email,idempotencyKey});
  await securityAudit(db,actor,"stay_balance.pay","stay_payment_schedule",bookingId,"completed",{amount:result.schedule.balanceAmount,paymentRef:result.schedule.paymentRef,duplicatePrevented:result.duplicatePrevented,sandbox:true});
  return json({data:{...result.schedule,duplicatePrevented:result.duplicatePrevented}},result.duplicatePrevented?200:201);
}catch(error){return authError(error,"Unable to settle the stay balance");}}
