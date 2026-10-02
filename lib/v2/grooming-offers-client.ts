import { apiSend } from "../api-fetch";
import { groomingCouponPayable } from "./grooming-money";
import type { CustomerOffer } from "../customer-offers";
export type V2GroomingOffers = { coupons: CustomerOffer[]; normalCouponsAllowed: boolean; bookingCount: number; message?: string };
export async function loadV2GroomingOffers(input: {customerId:string;cityId:string;packageCode:string;orderValue:number;isSubscription?:boolean}, signal?:AbortSignal):Promise<V2GroomingOffers>{
  const query=new URLSearchParams({customerId:input.customerId,cityId:input.cityId,packageCode:input.packageCode,orderValue:String(input.orderValue),serviceCode:"grooming",channel:"website",paymentMode:"full",isSubscription:String(Boolean(input.isSubscription))});
  // Reuse the platform's bounded request, safe JSON parsing and caller-abort handling.
  const data=await apiSend<V2GroomingOffers>(`/api/customer-offers?${query}`,{cache:"no-store",signal},"Available offers could not be checked. Try again.");
  const body={data};
  if(!Array.isArray(data.coupons)||typeof data.normalCouponsAllowed!=="boolean")throw new Error("Available offers could not be checked. Try again.");
  if(!Number.isSafeInteger(body.data.bookingCount)||body.data.bookingCount<0||(!body.data.normalCouponsAllowed&&body.data.coupons.length))throw new Error("Available offers could not be verified. Try again.");
  const codes=new Set<string>();
  for(const offer of body.data.coupons){
    if(typeof offer.code!=="string"||!offer.code.trim()||codes.has(offer.code)||typeof offer.name!=="string"||typeof offer.description!=="string"||typeof offer.savings!=="number"||offer.savings<=0)throw new Error("Available offers could not be verified. Try again.");
    groomingCouponPayable(input.orderValue,{discount:offer.savings,finalAmount:offer.finalAmount});codes.add(offer.code);
  }
  if(body.data.coupons.some(offer=>(offer.savings||0)>(body.data!.coupons[0]?.savings||0)))throw new Error("The best available offer could not be verified. Try again.");
  return body.data;
}
