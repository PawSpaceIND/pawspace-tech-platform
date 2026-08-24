import{authError,authFailure,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{consumeCouponQuote,listCouponCampaigns,quoteCoupon,saveCouponCampaign,type CouponCampaign,type CouponQuoteInput}from"../../../lib/coupon-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}
async function couponsLiveApproved(){const{env}=await import("cloudflare:workers");return String((env as unknown as Record<string,unknown>).PAWSPACE_COUPONS_LIVE_APPROVED||"").trim().toLowerCase()==="true";}

// These are governed customer/operator outcomes, not internal exceptions. Only this exact allow-list
// may cross the HTTP boundary; SQL/stack/runtime messages continue through authError's generic 500.
const couponFailures=[
  {message:"Quote, booking, customer and idempotency key are required",status:400},
  {message:"Coupon quote not found",status:404},
  {message:"Coupon quote customer mismatch",status:403},
  {message:"Coupon quote is no longer open",status:409},
  {message:"Coupon quote has expired",status:409},
  {message:"Canonical booking does not belong to this customer",status:403},
  {message:"Canonical booking does not match the coupon quote context",status:409},
  {message:"Coupon campaign not found",status:404},
  {message:"Coupon total redemption limit reached",status:409},
  {message:"Customer coupon limit reached",status:409},
  {message:"Coupon idempotency key was already used for a different redemption",status:409},
  {message:"Coupon code and name are required",status:400},
  {message:"Coupon eligibility scope is required",status:400},
  {message:"Coupon discount and limits must be positive",status:400},
  {message:"Percentage discount cannot exceed 100",status:400},
  {message:"Maximum order cannot be below minimum order",status:400},
  {message:"Coupon validity window is invalid",status:400},
  {message:"Live coupons are not approved (set PAWSPACE_COUPONS_LIVE_APPROVED=\"true\" - in isolated staging first)",status:409},
]as const;
function governedCouponFailure(error:unknown){const detail=error instanceof Error?error.message:"";const rule=couponFailures.find(item=>item.message===detail);return rule?authFailure(rule.message,rule.status):null;}

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
}catch(error){return governedCouponFailure(error)??authError(error,"Unable to update coupon governance");}}
