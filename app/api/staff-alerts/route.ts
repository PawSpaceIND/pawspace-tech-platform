import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{runStaffAlertSweep,staffAlertDirectory,updateStaffAlert}from"../../../lib/staff-alert-center";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){try{await authorize(request,"reports.view");const db=await database();return json({directory:await staffAlertDirectory(db),productionReady:false});}catch(error){return authError(error,"Unable to load staff alerts");}}

export async function POST(request:Request){try{const actor=await authorize(request,"customers.manage"),db=await database(),body=await request.json() as Row,action=String(body.action||"").trim();
 if(action==="sweep"){const data=await runStaffAlertSweep(db,{actorId:actor.email,asOf:body.asOf==null?undefined:Number(body.asOf)});await securityAudit(db,actor,"staff_alert.sweep","staff_alert","scheduler","completed",data);return json({data,productionReady:false});}
 if(action==="acknowledge"||action==="resolve"){const data=await updateStaffAlert(db,{alertId:String(body.alertId||""),action,actorId:actor.email});await securityAudit(db,actor,`staff_alert.${action}`,"staff_alert",String(body.alertId||""),"completed",{});return json({data,productionReady:false});}
 return json({error:"Unknown staff alert action"},400);
}catch(error){return authError(error,"Unable to update staff alerts");}}
