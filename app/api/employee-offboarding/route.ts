import {authError,authorize,database,requirePermission} from "../../../lib/server-auth";
import {approveEmployeeExit,cancelEmployeeExit,closeEmployeeExitSandbox,employeeExitDirectory,employeeExitSettlement,executeEmployeeExit,requestEmployeeExit} from "../../../lib/employee-offboarding";
const text=(v:unknown)=>typeof v==="string"?v.trim():"";
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store"}});
export async function GET(request:Request){
 try{const actor=await authorize(request,"people.manage"),db=await database(),id=new URL(request.url).searchParams.get("caseId");requirePermission(actor,"users.manage");
  if(id){requirePermission(actor,"payroll.view");return json({data:await employeeExitSettlement(db,id)});}
  const data=await employeeExitDirectory(db);return json({data:{...data,capabilities:{identity:actor.permissions.includes("*")||actor.permissions.includes("users.manage"),settlement:actor.permissions.includes("*")||actor.permissions.includes("payroll.approve"),salaryView:actor.permissions.includes("*")||actor.permissions.includes("payroll.view")}}});
 }catch(error){return authError(error,"Unable to load employee exit review");}
}
export async function POST(request:Request){
 try{
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return json({error:"Cross-origin employee exit write blocked"},403);
  const actor=await authorize(request,"people.manage"),body=await request.json().catch(()=>null);
  if(!body||typeof body!=="object"||Array.isArray(body))return json({error:"An employee exit action is required"},400);
  requirePermission(actor,"users.manage");
  const db=await database(),action=text(body.action),caseId=text(body.caseId),actorId=actor.email;
  if(action==="settle_sandbox"){
   requirePermission(actor,"payroll.approve");requirePermission(actor,"payroll.view");
   return json({data:await closeEmployeeExitSandbox(db,{caseId,actorId,revision:text(body.revision),clearanceReference:text(body.clearanceReference),policyReviewReference:text(body.policyReviewReference),confirmSandbox:body.confirmSandbox===true})});
  }
  if(!["request","approve","cancel","execute"].includes(action))return json({error:"Unsupported employee exit action"},400);
  requirePermission(actor,"users.manage");
  if(action==="request")return json({data:await requestEmployeeExit(db,{employeeId:text(body.employeeId),accessEndsAt:Number(body.accessEndsAt),reason:text(body.reason),idempotencyKey:text(body.idempotencyKey),actorId})},201);
  if(action==="approve")return json({data:await approveEmployeeExit(db,{caseId,actorId})});
  if(action==="cancel")return json({data:await cancelEmployeeExit(db,{caseId,actorId,reason:text(body.reason)})});
  return json({data:await executeEmployeeExit(db,{caseId,actorId})});
 }catch(error){return authError(error,"Employee exit update failed");}
}
