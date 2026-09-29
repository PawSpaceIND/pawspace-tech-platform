import{authError,authorize,database,securityAudit}from"../../../../lib/server-auth";
import{
 approveV2SalaryReleasePlan,applyApprovedV2Adjustments,createV2SalaryReleasePlan,decideV2Adjustment,
 deriveV2Lop,proposeV2AuthorizedDeduction,releaseHeldV2Salary,saveV2PayrollPolicy,setV2SalaryHold,
 queueDueV2SalaryInstructions,v2PayrollGovernanceDirectory
}from"../../../../lib/v2-payroll-governance";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const strings=(v:unknown)=>Array.isArray(v)?v.map(text).filter(Boolean):[];

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
  const hr=()=>authorize(request,"people.manage"),finance=()=>authorize(request,"payroll.approve"),manage=()=>authorize(request,"payroll.manage");
  let data:unknown;
  if(action==="save_policy"){
   const approved=await hr();
   data=await saveV2PayrollPolicy(db,{salaryDay:Number(body.salaryDay),cutoffDay:Number(body.cutoffDay),paidLeaveCodes:strings(body.paidLeaveCodes),unpaidLeaveCodes:strings(body.unpaidLeaveCodes),lopDeductibleComponentCodes:strings(body.lopDeductibleComponentCodes),authorizedDeductionEnabled:Boolean(body.authorizedDeductionEnabled),authorizedDeductionPolicyReference:text(body.authorizedDeductionPolicyReference),maxAuthorizedDeductionPercent:Number(body.maxAuthorizedDeductionPercent),actorId:approved.email});
  }else if(action==="derive_lop"){
   const approved=await hr();data=await deriveV2Lop(db,{runId:text(body.runId),employeeId:text(body.employeeId),evidenceReference:text(body.evidenceReference),actorId:approved.email});
  }else if(action==="propose_authorized_deduction"){
   const approved=await hr();data=await proposeV2AuthorizedDeduction(db,{runId:text(body.runId),employeeId:text(body.employeeId),amount:Number(body.amount),reason:text(body.reason),evidenceReference:text(body.evidenceReference),actorId:approved.email});
  }else if(action==="decide_adjustment_hr"){
   const approved=await hr();data=await decideV2Adjustment(db,{adjustmentId:text(body.adjustmentId),stage:"hr",decision:text(body.decision)==="reject"?"reject":"approve",actorId:approved.email});
  }else if(action==="decide_adjustment_finance"){
   const approved=await finance();data=await decideV2Adjustment(db,{adjustmentId:text(body.adjustmentId),stage:"finance",decision:text(body.decision)==="reject"?"reject":"approve",actorId:approved.email});
  }else if(action==="apply_adjustments"){
   const approved=await manage();data=await applyApprovedV2Adjustments(db,{runId:text(body.runId),actorId:approved.email});
  }else if(action==="create_release_plan"){
   const approved=await manage();const items=Array.isArray(body.items)?body.items as Array<{employeeId:string;releaseAt?:number;batchCode?:string;hold?:boolean;holdReason?:string}>:[];
   data=await createV2SalaryReleasePlan(db,{runId:text(body.runId),salaryDate:Number(body.salaryDate),items,actorId:approved.email});
  }else if(action==="approve_release_plan_hr"){
   const approved=await hr();data=await approveV2SalaryReleasePlan(db,{runId:text(body.runId),stage:"hr",actorId:approved.email});
  }else if(action==="approve_release_plan_finance"){
   const approved=await finance();data=await approveV2SalaryReleasePlan(db,{runId:text(body.runId),stage:"finance",actorId:approved.email});
  }else if(action==="set_salary_hold"){
   const approved=await hr();data=await setV2SalaryHold(db,{runId:text(body.runId),employeeId:text(body.employeeId),hold:Boolean(body.hold),reason:text(body.reason),releaseAt:body.releaseAt==null?undefined:Number(body.releaseAt),actorId:approved.email});
  }else if(action==="release_held_salary"){
   const approved=await finance();data=await releaseHeldV2Salary(db,{runId:text(body.runId),employeeId:text(body.employeeId),releaseAt:Number(body.releaseAt),actorId:approved.email});
  }else if(action==="queue_due_salary"){
   const approved=await finance();data=await queueDueV2SalaryInstructions(db,{runId:text(body.runId),asOf:body.asOf==null?undefined:Number(body.asOf),actorId:approved.email});
  }else return Response.json({error:"Unknown V2 payroll governance action"},{status:400});
  await securityAudit(db,actor,`v2.payroll.${action}`,"v2_payroll",text(body.runId)||text(body.adjustmentId)||text(body.employeeId)||null,"completed");
  return Response.json({data,productionReady:false});
 }catch(error){return authError(error,"V2 payroll governance update failed");}
}
