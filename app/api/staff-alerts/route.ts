import{authError,authorize,database,requirePermission,securityAudit}from"../../../lib/server-auth";
import{runStaffAlertSweep,staffAlertDirectory,StaffAlertAuthorityError,updateStaffAlert}from"../../../lib/staff-alert-center";
import{backgroundSchedulerStatus}from"../../../lib/background-scheduler";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){try{await authorize(request,"reports.view");const db=await database(),directory=await staffAlertDirectory(db),scheduler=await backgroundSchedulerStatus(db);return json({directory:{...directory,truth:{...directory.truth,automaticMode:"scheduled_worker",runnerBoundary:"worker.scheduled + manual staff-alert sweep",backgroundSchedulerConfigured:true,schedulerProductionReady:true,productionReady:false}},scheduler,schedulerProductionReady:true,productionReady:false,externalDelivery:false});}catch(error){return authError(error,"Unable to load staff alerts");}}

// The door only establishes identity. Authority over an individual alert belongs to the team that
// owns it and is decided per alert in lib/staff-alert-authority.ts - gating the whole endpoint on
// `customers.manage` let a Manager close Finance's payment failures while locking Finance itself out,
// because the Finance role does not hold `customers.manage` (lib/platform-security.ts:26).
export async function POST(request:Request){try{const actor=await authorize(request,"reports.view"),db=await database(),body=await request.json() as Row,action=String(body.action||"").trim();
 if(action==="sweep"){requirePermission(actor,"customers.manage");if(body.asOf!=null&&!Number.isFinite(Number(body.asOf)))return json({error:"asOf must be a finite epoch-milliseconds number"},400);const data=await runStaffAlertSweep(db,{actorId:actor.email,asOf:body.asOf==null?undefined:Number(body.asOf)}),scheduler=await backgroundSchedulerStatus(db);await securityAudit(db,actor,"staff_alert.sweep","staff_alert","scheduler","completed",data);return json({data,scheduler,schedulerProductionReady:true,productionReady:false,externalDelivery:false});}
 if(action==="acknowledge"||action==="resolve"){const alertId=String(body.alertId||"");
  try{const data=await updateStaffAlert(db,{alertId,action,actorId:actor.email,actorPermissions:actor.permissions});await securityAudit(db,actor,`staff_alert.${action}`,"staff_alert",alertId,"completed",data);return json({data,schedulerProductionReady:true,productionReady:false,externalDelivery:false});}
  catch(error){if(!(error instanceof StaffAlertAuthorityError))throw error;await securityAudit(db,actor,`staff_alert.${action}`,"staff_alert",alertId,"denied",{reason:error.message,owner:error.owner});return json({error:error.message},403);}}
 return json({error:"Unknown staff alert action"},400);
}catch(error){return authError(error,"Unable to update staff alerts");}}
