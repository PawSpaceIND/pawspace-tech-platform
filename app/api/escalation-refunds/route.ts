import{authError,authFailure,database,requirePermission,resolveActor,type AuthenticatedActor}from"../../../lib/server-auth";
import{hasPermission}from"../../../lib/platform-security";
import{governedJsonError}from"../../../lib/governed-http-error";
import{OPERATIONS_MANAGER_DOMAIN,requireManagerDomain,resolveManagerOrganizationalScope}from"../../../lib/organizational-scope";
import { ensureCanonicalBookingCoreTables } from "../../../lib/canonical-booking-core-schema";
import{decideEscalationRefund,escalationRefundPosition,escalationRefundQueue,escalationRefundsForBooking,requestEscalationRefund}from"../../../lib/escalation-refunds";

/*
 * Refunds after completion (owner decision D, 27 Sept 2026). Operations asks (bookings.manage) from the Booking Command
 * Center; Finance approves or rejects (finance.manage, a different person). The money, the credit note, the TCS base and the
 * provider payout are handled by lib/escalation-refunds.ts; this route only authorises and hands over.
 *   GET ?bookingId=&percent=  bookings.manage  what can be refunded on the booking and the rupee preview
 *   GET                       finance.view     the Finance queue, recent decisions and the credit notes
 *   POST request              bookings.manage  { bookingId, percent, reason, customerNote?, manualNote?, idempotencyKey? }
 *     manualNote is required, at least 10 characters, only when the booking was completed before the 26 Sept 2026
 *     model (position.legacyModel from the GET preview): no completion tax record means no credit note is issued.
 *   POST approve | reject     finance.manage   { requestId, reason }
 */
type Db=Awaited<ReturnType<typeof database>>;
type Body={action?:string;bookingId?:string;percent?:unknown;reason?:string;customerNote?:string;manualNote?:string;idempotencyKey?:string;requestId?:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw governedJsonError({error:"Cross-origin refund write blocked"},403);}
/** An Operations manager acts only on bookings in their own city, exactly as in the Booking Command Center. */
async function requireBookingInScope(db:Db,actor:AuthenticatedActor,bookingId:string){
 const scope=await resolveManagerOrganizationalScope(db,actor);requireManagerDomain(scope,OPERATIONS_MANAGER_DOMAIN);
 if(!scope)return;
 await ensureCanonicalBookingCoreTables(db);
 const booking=await db.prepare("SELECT city_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Record<string,unknown>>();
 if(booking&&String(booking.city_id).toLowerCase()!==scope.cityId)throw authFailure("Booking is outside the manager's city scope",403);
}

export async function GET(request:Request){
 try{
  const actor=await resolveActor(request),url=new URL(request.url),bookingId=String(url.searchParams.get("bookingId")||"").trim();
  if(bookingId){
   requirePermission(actor,"bookings.manage");
   const db=await database();await requireBookingInScope(db,actor,bookingId);
   const percent=url.searchParams.get("percent"),position=await escalationRefundPosition(db,{bookingId,percent:percent==null||percent===""?null:Number(percent)});
   if(!position.found)return json({error:"Booking not found"},404);
   return json({data:{position,requests:await escalationRefundsForBooking(db,bookingId)}});
  }
  requirePermission(actor,"finance.view");
  return json({data:await escalationRefundQueue(await database(),{limit:Number(url.searchParams.get("limit")||50)})});
 }catch(error){return authError(error,"Unable to load refunds after completion");}
}

export async function POST(request:Request){
 try{
  sameOrigin(request);
  const actor=await resolveActor(request);
  // Either permission lets a caller in; each action then requires its own.
  if(!hasPermission(actor.permissions,"bookings.manage")&&!hasPermission(actor.permissions,"finance.manage"))throw authFailure("Permission denied",403);
  const body=await request.json().catch(()=>({})) as Body,action=String(body.action||""),db=await database();
  if(action==="request"){
   requirePermission(actor,"bookings.manage");
   const bookingId=String(body.bookingId||"").trim();
   await requireBookingInScope(db,actor,bookingId);
   const data=await requestEscalationRefund(db,{bookingId,percent:body.percent,reason:String(body.reason||""),customerNote:body.customerNote==null?null:String(body.customerNote),manualNote:body.manualNote==null?null:String(body.manualNote),idempotencyKey:body.idempotencyKey==null?null:String(body.idempotencyKey)},actor);
   return json({data},data.duplicatePrevented?200:201);
  }
  if(action==="approve"||action==="reject"){
   requirePermission(actor,"finance.manage");
   const{env}=await import("cloudflare:workers");
   const data=await decideEscalationRefund(db,env as unknown as Record<string,unknown>,{requestId:String(body.requestId||""),decision:action,reason:body.reason==null?null:String(body.reason)},actor);
   return json({data});
  }
  return json({error:"Choose request, approve or reject"},400);
 }catch(error){return authError(error,"Unable to update the refund after completion");}
}
