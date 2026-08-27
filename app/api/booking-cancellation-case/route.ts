import{authError,authorize,securityAudit}from"../../../lib/server-auth";
import{getCancellationCase,listCancellationCaseEvents,recordFinanceDecision,recordOpsDecision,resolveCancellationCasePolicy,type FinanceDecision,type OpsDecision}from"../../../lib/cancellation-case-governance";

/*
 * The Operations and Finance half of a post-start cancellation. [PTJA-W1-F24]
 *
 * A customer asking to cancel a job that has started opens a case; nothing else happens. This route is
 * where a human decides, and the two decisions are deliberately SEPARATE:
 *
 *   Operations decides whether the provider proceeds, stops or returns. Only a stop or return changes the
 *   booking, and it writes a DISTINCT terminal status - a job that ran and was halted must never be
 *   recorded as one that never happened, because payout, attendance and reporting all read that
 *   difference.
 *
 *   Finance decides the refund. Opening a case promises nothing, and an Operations stop does not imply a
 *   refund: provider payout stays a calculation from arrival, work performed, travel and fault
 *   attribution, not something an open case erases.
 *
 * Every decision carries an actor, a reason, a timestamp, evidence where the policy requires it, and the
 * customer/provider communication - all recorded on booking_cancellation_case_events.
 */
const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}

async function failure(error:unknown,message:string){
  if(error instanceof Response&&error.status>=400&&error.status<500){
    const body=await error.clone().text().catch(()=>"");
    try{return json(JSON.parse(body),error.status);}catch{return json({error:body||message},error.status);}
  }
  return authError(error,message);
}

export async function GET(request:Request){
  try{
    // Reading a case exposes the customer's stated reason and the provider's evidence, so it is staff-only.
    await authorize(request,"bookings.view");
    const db=await database();
    const caseId=String(new URL(request.url).searchParams.get("caseId")||"").trim();
    if(!caseId)return json({error:"A case id is required"},400);
    const record=await getCancellationCase(db,caseId);
    if(!record)return json({error:"Cancellation case not found"},404);
    const [events,policy]=await Promise.all([
      listCancellationCaseEvents(db,caseId),
      resolveCancellationCasePolicy(db,{serviceCode:record.serviceCode,cityId:record.cityId}),
    ]);
    return json({data:{case:record,events,availableOpsDecisions:policy.config.opsDecisionsByStatus[record.bookingStatusAtRequest]??[],
      refundApprovalPermissions:policy.config.refundApprovalPermissions,policyVersion:policy.policyVersion}});
  }catch(error){return failure(error,"Unable to load the cancellation case");}
}

export async function POST(request:Request){
  try{
    /*
     * bookings.view is the FLOOR, checked before any body work so an unauthenticated or unprivileged
     * caller is refused before it learns anything about the case. The decision-specific permissions -
     * who may stop a job, who may approve a refund - are policy, applied inside the governance module
     * against this actor's real permission set. tests/route-authorization-class.test.mjs enforces this
     * ordering for every guarded route.
     */
    const actor=await authorize(request,"bookings.view");
    const db=await database();
    const body=await request.json() as {caseId?:string;action?:"ops_decision"|"finance_decision";decision?:string;reason?:string;refundAmount?:number;evidence?:unknown;communication?:unknown};
    const caseId=String(body.caseId||"").trim();
    if(!caseId||!body.action)return json({error:"A case id and an action are required"},400);

    if(body.action==="ops_decision"){
      const decision=String(body.decision||"") as OpsDecision;
      if(!["proceed","stop","return"].includes(decision))return json({error:"Operations decision must be proceed, stop or return"},400);
      const result=await recordOpsDecision(db,{caseId,decision,actorId:actor.email,actorPermissions:actor.permissions,
        reason:String(body.reason||""),evidence:body.evidence,communication:body.communication});
      await securityAudit(db,actor,"booking.cancellation_case.ops_decision","cancellation_case",caseId,"completed",{decision,bookingId:result.case.bookingId,stoppedStatus:result.stoppedStatus});
      return json({data:{case:result.case,stoppedStatus:result.stoppedStatus,refundPromised:false}});
    }

    if(body.action==="finance_decision"){
      const decision=String(body.decision||"") as FinanceDecision;
      if(!["refund_full","refund_partial","no_refund"].includes(decision))return json({error:"Finance decision must be refund_full, refund_partial or no_refund"},400);
      const result=await recordFinanceDecision(db,{caseId,decision,refundAmount:Number(body.refundAmount||0),
        actorId:actor.email,actorPermissions:actor.permissions,reason:String(body.reason||""),communication:body.communication});
      await securityAudit(db,actor,"booking.cancellation_case.finance_decision","cancellation_case",caseId,"completed",{decision,refundAmountApproved:result.refundAmountApproved,bookingId:result.case.bookingId});
      return json({data:{case:result.case,refundAmountApproved:result.refundAmountApproved}});
    }

    return json({error:"Unknown action"},400);
  }catch(error){return failure(error,"Unable to record the cancellation case decision");}
}
