import{authError,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{consumeCouponQuote,listCouponCampaigns,quoteCoupon,saveCouponCampaign,type CouponCampaign,type CouponQuoteInput}from"../../../lib/coupon-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}
async function couponsLiveApproved(){const{env}=await import("cloudflare:workers");return String((env as unknown as Record<string,unknown>).PAWSPACE_COUPONS_LIVE_APPROVED||"").trim().toLowerCase()==="true";}

export async function GET(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"pricing.view");const db=await database();return json({data:await listCouponCampaigns(db),testOnly:true,liveMoney:false,productionReady:false});}catch(error){return authError(error,"Unable to load coupon governance");}}

export async function POST(request:Request){try{const body=await request.json() as Record<string,unknown>,action=String(body.action||"");const actor=await resolveActor(request),db=await database();
  if(action==="quote"){
    requirePermission(actor,"scheduling.book");const input=body.input as CouponQuoteInput|undefined;if(!input?.customerId)return json({error:"Customer is required"},400);await requireCustomerOwnership(db,actor,input.customerId);const liveApproved=await couponsLiveApproved();const result=await quoteCoupon(db,input,{liveApproved});await securityAudit(db,actor,"coupon.quote","coupon",String(input.code||""),result.valid?"completed":"rejected",{customerId:input.customerId,serviceCode:input.serviceCode,cityId:input.cityId,channel:input.channel,packageCode:input.packageCode,testOnly:result.valid?result.testOnly:null});return json({data:result,testOnly:result.valid?result.testOnly:null,liveMoney:result.valid?result.liveMoney:false},result.valid?200:409);
  }
  if(action==="consume"){
    requirePermission(actor,"bookings.manage");const quoteId=String(body.quoteId||""),bookingId=String(body.bookingId||""),customerId=String(body.customerId||""),idempotencyKey=String(body.idempotencyKey||"");const result=await consumeCouponQuote(db,{quoteId,bookingId,customerId,idempotencyKey});await securityAudit(db,actor,"coupon.consume","booking",bookingId,"completed",{quoteId,customerId,testOnly:true,duplicatePrevented:result.duplicatePrevented});return json({data:result,testOnly:true,liveMoney:false});
  }
  if(action==="save_campaign"){
    requirePermission(actor,"pricing.manage");const campaign=body.campaign as Omit<CouponCampaign,"createdAt"|"updatedAt"|"testOnly">&{id?:string;live?:boolean};const liveApproved=await couponsLiveApproved();const saved=await saveCouponCampaign(db,campaign,{liveApproved});await securityAudit(db,actor,"coupon.save_campaign","coupon",saved.id,saved.testOnly?"completed":"completed",{code:saved.code,status:saved.status,testOnly:saved.testOnly,live:!saved.testOnly});return json({data:saved,testOnly:saved.testOnly,liveMoney:!saved.testOnly});
  }
  return json({error:"Unsupported coupon action"},400);
}catch(error){return authError(error,"Unable to update coupon governance");}}
