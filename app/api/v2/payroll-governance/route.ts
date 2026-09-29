import{authError,authorize,database,requirePermission,securityAudit}from"../../../../lib/server-auth";
import{
 approveV2SalaryReleasePlan,applyApprovedV2Adjustments,createV2SalaryReleasePlan,decideV2Adjustment,
 deriveV2Lop,proposeV2AuthorizedDeduction,releaseHeldV2Salary,saveV2PayrollPolicy,setV2SalaryHold,
 queueDueV2SalaryInstructions,v2PayrollGovernanceDirectory
}from"../../../../lib/v2-payroll-governance";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const strings=(v:unknown)=>Array.isArray(v)?v.map(text).filter(Boolean):[];
const decision=(v:unknown)=>{const value=text(v);if(value!=="approve"&&value!=="reject")throw new Response("Decision must be approve or reject",{status:400});return value;};

export async function GET(request:Request){
 try{
  const actor=await authorize(request,"payroll.view"),db=await database(),url=new URL(request.url);
  const data=await v2PayrollGovernanceDirectory(db,url.searchParams.get("runId")||undefined);
  return Response.json({data,capabilities:{
   hr:actor.permissions.includes("*")||actor.permissions.includes("people.manage"),
   finance:actor.permissions.includes("*")||actor.permissions.includes("payroll.approve"),
   manage:actor.permissions.includes("*")||actor.permissions.includes("payroll.manage")
  },productionReady:false});
 }catch(error){return authError(error,"Unable to load V2 payroll governance");}
}

export async function POST(request:Request){
 try{
  const actor=await authorize(request,"payroll.view"),db=await database(),body=await request.json() as Row,action=text(body.action);
  const handlers:Record<string,()=>Promise<unknown>>={
   save_policy:async()=>{requirePermission(actor,"people.manage");return saveV2PayrollPolicy(db,{salaryDay:Number(body.salaryDay),cutoffDay:Number(body.cutoffDay),paidLeaveCodes:strings(body.paidLeaveCodes),unpaidLeaveCodes:strings(body.unpaidLeaveCodes),lopDeductibleComponentCodes:strings(body.lopDeductibleComponentCodes),authorizedDeductionEnabled:Boolean(body.authorizedDeductionEnabled),authorizedDeductionPolicyReference:text(body.authorizedDeductionPolicyReference),maxAuthorizedDeductionPercent:Number(body.maxAuthorizedDeductionPercent),actorId:actor.email});},
   derive_lop:async()=>{requirePermission(actor,"people.manage");return deriveV2Lop(db,{runId:text(body.runId),employeeId:text(body.employeeId),evidenceReference:text(body.evidenceReference),actorId:actor.email});},
   propose_authorized_deduction:async()=>{requirePermission(actor,"people.manage");return proposeV2AuthorizedDeduction(db,{runId:text(body.runId),employeeId:text(body.employeeId),amount:Number(body.amount),reason:text(body.reason),evidenceReference:text(body.evidenceReference),actorId:actor.email});},
   decide_adjustment_hr:async()=>{requirePermission(actor,"people.manage");return decideV2Adjustment(db,{adjustmentId:text(body.adjustmentId),stage:"hr",decision:decision(body.decision),actorId:actor.email});},
   decide_adjustment_finance:async()=>{requirePermission(actor,"payroll.approve");return decideV2Adjustment(db,{adjustmentId:text(body.adjustmentId),stage:"finance",decision:decision(body.decision),actorId:actor.email});},
   apply_adjustments:async()=>{requirePermission(actor,"payroll.manage");return applyApprovedV2Adjustments(db,{runId:text(body.runId),actorId:actor.email});},
   create_release_plan:async()=>{requirePermission(actor,"payroll.manage");const items=Array.isArray(body.items)?body.items as Array<{employeeId:string;releaseAt?:number;batchCode?:string;hold?:boolean;holdReason?:string}>:[];return createV2SalaryReleasePlan(db,{runId:text(body.runId),salaryDate:Number(body.salaryDate),items,actorId:actor.email});},
   approve_release_plan_hr:async()=>{requirePermission(actor,"people.manage");return approveV2SalaryReleasePlan(db,{runId:text(body.runId),stage:"hr",actorId:actor.email});},
   approve_release_plan_finance:async()=>{requirePermission(actor,"payroll.approve");return approveV2SalaryReleasePlan(db,{runId:text(body.runId),stage:"finance",actorId:actor.email});},
   set_salary_hold:async()=>{requirePermission(actor,"people.manage");return setV2SalaryHold(db,{runId:text(body.runId),employeeId:text(body.employeeId),hold:Boolean(body.hold),reason:text(body.reason),releaseAt:body.releaseAt==null?undefined:Number(body.releaseAt),actorId:actor.email});},
   release_held_salary:async()=>{requirePermission(actor,"payroll.approve");return releaseHeldV2Salary(db,{runId:text(body.runId),employeeId:text(body.employeeId),releaseAt:Number(body.releaseAt),actorId:actor.email});},
   queue_due_salary:async()=>{requirePermission(actor,"payroll.approve");return queueDueV2SalaryInstructions(db,{runId:text(body.runId),asOf:body.asOf==null?undefined:Number(body.asOf),actorId:actor.email});}
  };
  const handler=handlers[action];if(!handler)return Response.json({error:"Unknown V2 payroll governance action"},{status:400});
  const data=await handler();
  await securityAudit(db,actor,`v2.payroll.${action}`,"v2_payroll",text(body.runId)||text(body.adjustmentId)||text(body.employeeId)||null,"completed");
  return Response.json({data,productionReady:false});
 }catch(error){return authError(error,"V2 payroll governance update failed");}
}
