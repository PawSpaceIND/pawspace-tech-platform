import {authError,database,requireCustomerOwnership,resolveActor} from "../../../lib/server-auth";
import {resolvePlatformSession} from "../../../lib/platform-session";
import {listAvailableCoupons,type CustomerOfferContext} from "../../../lib/customer-offers";

export async function GET(request:Request){try{
  const db=await database(),actor=await resolveActor(request),session=await resolvePlatformSession(db,request).catch(()=>null);
  const params=new URL(request.url).searchParams,customerId=String(params.get("customerId")||(session?.subjectType==="customer"?session.subjectId:"")).trim();
  if(!customerId)return Response.json({error:"Verified customer identity is required"},{status:401});
  await requireCustomerOwnership(db,actor,customerId);
  let context:CustomerOfferContext|undefined;
  const contextKeys=["serviceCode","cityId","channel","packageCode","orderValue","paymentMode","isSubscription"];
  if(contextKeys.some(key=>params.has(key))){
    const serviceCode=params.get("serviceCode"),channel=params.get("channel"),paymentMode=params.get("paymentMode"),orderValue=params.get("orderValue")||"";
    if(!contextKeys.every(key=>params.has(key))||!["grooming","dog_training","boarding","pet_sitting"].includes(serviceCode||"")||!["customer_app","website","assisted_staff","whatsapp","partner_app"].includes(channel||"")||!["full","partial","after_service"].includes(paymentMode||"")||!["true","false"].includes(params.get("isSubscription")||"")||!/^\d+(?:\.\d{1,2})?$/.test(orderValue)||!Number.isSafeInteger(Math.round(Number(orderValue)*100))||!params.get("cityId")?.trim()||!params.get("packageCode")?.trim())return Response.json({error:"Complete, valid offer context is required"},{status:400});
    context={serviceCode:serviceCode as CustomerOfferContext["serviceCode"],cityId:params.get("cityId")!.trim(),channel:channel as CustomerOfferContext["channel"],packageCode:params.get("packageCode")!.trim(),orderValue:Number(orderValue),paymentMode:paymentMode as CustomerOfferContext["paymentMode"],isSubscription:params.get("isSubscription")==="true"};
  }
  const {env}=await import("cloudflare:workers");
  const liveApproved=String((env as unknown as Record<string,unknown>).PAWSPACE_COUPONS_LIVE_APPROVED||"").trim().toLowerCase()==="true";
  const offers=await listAvailableCoupons(db,{customerId,context,liveApproved});
  return Response.json({data:offers},{headers:{"cache-control":"no-store"}});
}catch(error){return authError(error,"Unable to load offers");}}
