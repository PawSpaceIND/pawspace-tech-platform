import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{getSittingOpsSnapshot,mutateSittingOps,type SittingOpsInput}from"../../../lib/sitting-ops-governance";
import{finalizeSittingRecoveryAcceptance}from"../../../lib/sitting-recovery-finalizer";

type Body=Omit<SittingOpsInput,"actorId">;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"bookings.view");const db=await database(),data=await getSittingOpsSnapshot(db);return json({data,sandboxOnly:true});}catch(error){return authError(error,"Unable to load Sitting Operations queue");}}

export async function POST(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"bookings.manage");const body=await request.json() as Body,bookingId=String(body.bookingId||"").trim(),action=body.action,idempotencyKey=String(body.idempotencyKey||"").trim();if(!bookingId||!action||!idempotencyKey)return json({error:"Booking, action and idempotency key are required"},400);if(!["assign_replacement","close_recovery","add_note"].includes(String(action)))return json({error:"Unsupported Sitting Operations action"},400);const db=await database();if(action==="close_recovery")await finalizeSittingRecoveryAcceptance(db,bookingId,actor.email);const result=await mutateSittingOps(db,{...body,bookingId,action,idempotencyKey,actorId:actor.email});await securityAudit(db,actor,`sitting.ops.${action}`,"canonical_booking",bookingId,"completed",{sandboxOnly:true,duplicatePrevented:Boolean((result as Record<string,unknown>).duplicatePrevented)});return json({data:result,sandboxOnly:true},action==="assign_replacement"?202:200);}catch(error){return authError(error,"Unable to update Sitting Operations queue");}}
