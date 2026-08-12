import{authError,authorize,database,resolveActor,requirePermission,securityAudit}from"../../../lib/server-auth";
import{employeeSelfServiceView,applyForLeave,selfRecordAttendance}from"../../../lib/employee-self-service";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin self-service write blocked",{status:403});}

export async function GET(request:Request){try{const actor=await authorize(request,"self_service.view");const db=await database();return Response.json({data:await employeeSelfServiceView(db,{email:actor.email}),productionReady:false});}catch(error){return authError(error,"Unable to load your self-service view");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"self_service.view");const db=await database();const body=await request.json() as Row,action=text(body.action);let result:unknown;
 if(action==="apply_leave")result=await applyForLeave(db,{email:actor.email,leaveCode:text(body.leaveCode),startDate:text(body.startDate),endDate:text(body.endDate),units:Number(body.units),reason:text(body.reason)});
 else if(action==="check_in"||action==="check_out")result=await selfRecordAttendance(db,{email:actor.email,eventType:action,occurredAt:Number(body.occurredAt)||Date.now(),idempotencyKey:text(body.idempotencyKey)||`self:${actor.email}:${action}:${new Date().toISOString().slice(0,10)}`});
 else return Response.json({error:"Unknown self-service action"},{status:400});
 await securityAudit(db,actor,`self_service.${action}`,"employee_self_service",actor.email,"completed");
 return Response.json({data:result,productionReady:false});}catch(error){return authError(error,"Self-service request failed");}}
