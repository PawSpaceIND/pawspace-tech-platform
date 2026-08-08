import{authError,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{claimReferral,ensureReferralCode,listReferralDirectory,qualifyReferralClaim,reserveReferralReward,reviewReferralClaim,reverseReferralReward,saveReferralProgramme,type ReferralClaimInput,type ReferralProgramme}from"../../../lib/referral-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}

export async function GET(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"pricing.view");const db=await database();return json({data:await listReferralDirectory(db),testOnly:true,liveMoney:false,productionReady:false});}catch(error){return authError(error,"Unable to load referral governance");}}

export async function POST(request:Request){try{const body=await request.json() as Record<string,unknown>,action=String(body.action||"");const actor=await resolveActor(request),db=await database();
  if(action==="claim"){
    requirePermission(actor,"scheduling.book");const input=body.input as ReferralClaimInput|undefined;if(!input?.referredCustomerId)return json({error:"Referred customer is required"},400);await requireCustomerOwnership(db,actor,input.referredCustomerId);const result=await claimReferral(db,input);await securityAudit(db,actor,"referral.claim","customer",input.referredCustomerId,result.matched&&!result.error?"completed":"denied",{claimId:result.claimId??null,code:input.code,serviceCode:input.serviceCode,cityId:input.cityId,testOnly:true});return json({data:result,testOnly:true,liveMoney:false},result.error?409:200);
  }
  if(action==="ensure_code"){
    requirePermission(actor,"scheduling.book");const programmeId=String(body.programmeId||"uat-referral-programme"),customerId=String(body.customerId||"");await requireCustomerOwnership(db,actor,customerId);const result=await ensureReferralCode(db,{programmeId,customerId});await securityAudit(db,actor,"referral.ensure_code","customer",customerId,"completed",{programmeId,codeId:result.codeId,testOnly:true});return json({data:result,testOnly:true,liveMoney:false});
  }
  if(action==="save_programme"){
    requirePermission(actor,"pricing.manage");const programme=body.programme as Omit<ReferralProgramme,"createdAt"|"updatedAt"|"testOnly"|"qualificationRule">;const saved=await saveReferralProgramme(db,programme);await securityAudit(db,actor,"referral.save_programme","referral_programme",saved.id,"completed",{status:saved.status,testOnly:true});return json({data:saved,testOnly:true,liveMoney:false});
  }
  if(action==="qualify"){
    requirePermission(actor,"bookings.manage");const claimId=String(body.claimId||""),bookingId=String(body.bookingId||""),idempotencyKey=String(body.idempotencyKey||"");const result=await qualifyReferralClaim(db,{claimId,bookingId,idempotencyKey,actorId:actor.email});await securityAudit(db,actor,"referral.qualify","booking",bookingId,"completed",{claimId,status:(result as {status?:string}).status??"qualified",testOnly:true});return json({data:result,testOnly:true,liveMoney:false});
  }
  if(action==="review"){
    requirePermission(actor,"bookings.manage");const claimId=String(body.claimId||""),decision=String(body.decision||"") as "clear"|"hold"|"reject",reason=String(body.reason||"");if(!["clear","hold","reject"].includes(decision))return json({error:"Invalid referral review decision"},400);const result=await reviewReferralClaim(db,{claimId,decision,reason});await securityAudit(db,actor,"referral.review","referral_claim",claimId,"completed",{decision,reason,testOnly:true});return json({data:result,testOnly:true,liveMoney:false});
  }
  if(action==="reserve_reward"){
    requirePermission(actor,"scheduling.book");const rewardId=String(body.rewardId||""),bookingId=String(body.bookingId||""),customerId=String(body.customerId||""),idempotencyKey=String(body.idempotencyKey||"");await requireCustomerOwnership(db,actor,customerId);const result=await reserveReferralReward(db,{rewardId,bookingId,customerId,idempotencyKey});await securityAudit(db,actor,"referral.reserve_reward","booking",bookingId,"completed",{rewardId,customerId,testOnly:true,bookingPricingAuthoritative:false});return json({data:result,testOnly:true,liveMoney:false});
  }
  if(action==="reverse_reward"){
    requirePermission(actor,"finance.manage");const rewardId=String(body.rewardId||""),reason=String(body.reason||"");const result=await reverseReferralReward(db,{rewardId,reason,actorId:actor.email});await securityAudit(db,actor,"referral.reverse_reward","referral_reward",rewardId,"completed",{reason,testOnly:true});return json({data:result,testOnly:true,liveMoney:false});
  }
  return json({error:"Unsupported referral action"},400);
}catch(error){return authError(error,"Unable to update referral governance");}}
