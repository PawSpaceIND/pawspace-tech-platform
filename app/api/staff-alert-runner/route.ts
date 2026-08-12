import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{runStaffAlertSweep}from"../../../lib/staff-alert-center";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function POST(request:Request){try{const actor=await authorize(request,"settings.manage"),db=await database(),body=await request.json().catch(()=>({})) as Row;
 // A non-numeric asOf previously became NaN, every due_at<=NaN comparison went false and the sweep
 // silently did nothing while reporting success. Reject it loudly instead.
 if(body.asOf!=null&&!Number.isFinite(Number(body.asOf)))return json({error:"asOf must be a finite epoch-milliseconds number"},400);
 const data=await runStaffAlertSweep(db,{actorId:actor.email,asOf:body.asOf==null?undefined:Number(body.asOf)});await securityAudit(db,actor,"staff_alert.runner","staff_alert","governed-runner","completed",data);return json({data,backgroundSchedulerConfigured:false,externalDelivery:false,productionReady:false});}catch(error){return authError(error,"Unable to run governed staff alert sweep");}}
