import type { CustomerOffer } from "../customer-offers";
export type V2GroomingOffers = { coupons: CustomerOffer[]; normalCouponsAllowed: boolean; bookingCount: number; message?: string };
export async function loadV2GroomingOffers(input: {customerId:string;cityId:string;packageCode:string;orderValue:number}, signal?:AbortSignal):Promise<V2GroomingOffers>{
  const query=new URLSearchParams({customerId:input.customerId,cityId:input.cityId,packageCode:input.packageCode,orderValue:String(input.orderValue),serviceCode:"grooming",channel:"website",paymentMode:"full",isSubscription:"false"});
  const response=await fetch(`/api/customer-offers?${query}`,{cache:"no-store",signal});
  const body=await response.json() as {data?:V2GroomingOffers;error?:string};
  if(!response.ok||!body.data||!Array.isArray(body.data.coupons)||typeof body.data.normalCouponsAllowed!=="boolean")throw new Error(body.error||"Available offers could not be checked. Try again.");
  return body.data;
}
