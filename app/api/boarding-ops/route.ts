import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{getBoardingOpsSnapshot,mutateBoardingOps,type BoardingOpsInput}from"../../../lib/boarding-ops-governance";
import{finalizeBoardingRecoveryAcceptance}from"../../../lib/boarding-recovery-finalizer";

type Body=Omit<BoardingOpsInput,"actorId">;
const json=(value:unknown,status=200)=>Response.json(value,{status});

export async function GET(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"bookings.manage");const db=await database(),data=await getBoardingOpsSnapshot(db);return json({data,sandboxOnly:true});}catch(error){return authError(error,"Unable to load Boarding Operations queue");}}

export async function POST(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"bookings.manage");const body=await request.json() as Body,stayId=String(body.stayId||"").trim(),action=body.action,idempotencyKey=String(body.idempotencyKey||"").trim();if(!stayId||!action||!idempotencyKey)return json({error:"Stay, action and idempotency key are required"},400);if(!["assign_replacement","close_recovery","add_note"].includes(String(action)))return json({error:"Unsupported Boarding Operations action"},400);const db=await database(),result=await mutateBoardingOps(db,{...body,stayId,action,idempotencyKey,actorId:actor.email});if(action==="close_recovery")await finalizeBoardingRecoveryAcceptance(db,stayId,actor.email);await securityAudit(db,actor,`boarding.ops.${action}`,"boarding_stay",stayId,"completed",{sandboxOnly:true,duplicatePrevented:Boolean((result as Record<string,unknown>).duplicatePrevented)});return json({data:result,sandboxOnly:true},action==="assign_replacement"?202:200);}catch(error){return authError(error,"Unable to update Boarding Operations queue");}}
