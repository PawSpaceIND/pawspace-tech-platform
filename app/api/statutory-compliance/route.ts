import{authError,authorize,securityAudit}from"../../../lib/server-auth";
import{statutoryCalendar,recordStatutoryFiling,recordBoardApproval,runStatutoryReminderSweep,type ObligationCode}from"../../../lib/statutory-compliance";
import{computeMonthlyTds,recordTdsDeposit,prepareTdsQuarterlyReturn,markTdsReturnFiled,tdsDashboard}from"../../../lib/tds-governance";
import{monthlyCloseView,closeMonth}from"../../../lib/finance-monthly-close";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}
const currentPeriod=()=>new Date(Date.now()+330*60_000).toISOString().slice(0,7); // IST month

export async function GET(request:Request){try{
 const actor=await authorize(request,"finance.view");
 const url=new URL(request.url),period=String(url.searchParams.get("period")||currentPeriod());
 const db=await database();
 const[calendar,close,tds]=await Promise.all([
  statutoryCalendar(db,period),
  monthlyCloseView(db,{period,actorId:actor.email}),
  tdsDashboard(db,period),
 ]);
 return json({data:{period,calendar,close,tds,filingMode:"manual_with_reminders",statutoryBasis:"India - GST monthly filer, TDS FY2025-26 rates/thresholds, Karnataka PT",productionReady:false}});
}catch(error){return authError(error,"Unable to load the statutory compliance dashboard");}}

type Body={action?:string;period?:string;obligationCode?:string;acknowledgementRef?:string;amount?:number;notes?:string;minutesReference?:string;resolutionText?:string;challanReference?:string;fyLabel?:string;quarter?:number;form?:string};

export async function POST(request:Request){try{
 const actor=await authorize(request,"finance.manage");
 const body=await request.json() as Body,db=await database();
 const action=String(body.action||""),period=String(body.period||currentPeriod());
 if(action==="compute_tds"){
  const result=await computeMonthlyTds(db,{period,actorId:actor.email});
  await securityAudit(db,actor,"statutory.compute_tds","tds_period",period,"completed",{totalTds:result.totalTds});
  return json({data:result});
 }
 if(action==="record_tds_deposit"){
  const result=await recordTdsDeposit(db,{period,challanReference:String(body.challanReference||""),amount:Number(body.amount),actorId:actor.email});
  await securityAudit(db,actor,"statutory.tds_deposit","tds_period",period,"completed",{amount:result.amount,duplicatePrevented:result.duplicatePrevented});
  return json({data:result},result.duplicatePrevented?200:201);
 }
 if(action==="prepare_tds_return"){
  const quarter=Number(body.quarter),form=String(body.form||"");
  if(![1,2,3,4].includes(quarter)||!["24Q","26Q"].includes(form))return json({error:"quarter (1-4) and form (24Q/26Q) are required"},400);
  const result=await prepareTdsQuarterlyReturn(db,{fyLabel:String(body.fyLabel||""),quarter:quarter as 1|2|3|4,form:form as "24Q"|"26Q",actorId:actor.email});
  await securityAudit(db,actor,"statutory.prepare_tds_return","tds_return",`${result.fyLabel}-Q${result.quarter}-${result.form}`,"completed",{totalTds:result.totalTds});
  return json({data:result});
 }
 if(action==="file_tds_return"){
  const quarter=Number(body.quarter),form=String(body.form||"");
  if(![1,2,3,4].includes(quarter)||!["24Q","26Q"].includes(form))return json({error:"quarter (1-4) and form (24Q/26Q) are required"},400);
  const result=await markTdsReturnFiled(db,{fyLabel:String(body.fyLabel||""),quarter:quarter as 1|2|3|4,form:form as "24Q"|"26Q",acknowledgementRef:String(body.acknowledgementRef||""),actorId:actor.email});
  await securityAudit(db,actor,"statutory.file_tds_return","tds_return",`${result.fyLabel}-Q${result.quarter}-${result.form}`,"completed",{acknowledgementRef:result.acknowledgementRef});
  return json({data:result},201);
 }
 if(action==="record_filing"){
  const result=await recordStatutoryFiling(db,{obligationCode:String(body.obligationCode||"") as ObligationCode,period,acknowledgementRef:String(body.acknowledgementRef||""),amount:body.amount==null?undefined:Number(body.amount),notes:body.notes,actorId:actor.email});
  await securityAudit(db,actor,"statutory.record_filing","statutory_filing",`${result.obligationCode}:${result.period}`,"completed",{acknowledgementRef:result.acknowledgementRef});
  return json({data:result},201);
 }
 if(action==="board_approve"){
  const result=await recordBoardApproval(db,{period,approvedBy:actor.email,approverRole:actor.roleCode,minutesReference:body.minutesReference,resolutionText:body.resolutionText});
  await securityAudit(db,actor,"statutory.board_approve","board_approval",period,"completed",{duplicatePrevented:result.duplicatePrevented});
  return json({data:result},result.duplicatePrevented?200:201);
 }
 if(action==="close_month"){
  const result=await closeMonth(db,{period,actorId:actor.email});
  await securityAudit(db,actor,"statutory.close_month","finance_close",period,"completed",{});
  return json({data:result},201);
 }
 if(action==="run_reminders"){
  const result=await runStatutoryReminderSweep(db,{});
  await securityAudit(db,actor,"statutory.run_reminders","statutory_sweep",result.periods.join(","),"completed",{created:result.created});
  return json({data:result});
 }
 return json({error:"Unsupported statutory compliance action"},400);
}catch(error){return authError(error,"Unable to complete the statutory compliance action");}}
