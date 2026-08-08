import type{CouponCampaign,CouponQuoteInput}from"./coupon-governance";

type SaveCouponCampaign=Omit<CouponCampaign,"id"|"createdAt"|"updatedAt"|"testOnly">&{id?:string};
async function payload(response:Response){const body=await response.json().catch(()=>({})) as Record<string,unknown>;if(!response.ok)throw new Error(String(body.error||"Coupon request failed"));return body.data;}
export async function quoteGovernedCoupon(input:CouponQuoteInput){return payload(await fetch("/api/coupon-governance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"quote",input})})) as Promise<{valid:boolean;quoteId?:string;code?:string;discount:number;finalAmount?:number;expiresAt?:number;error?:string;testOnly?:boolean;liveMoney?:boolean}>;}
export async function loadCouponCampaigns(){return payload(await fetch("/api/coupon-governance",{cache:"no-store"})) as Promise<Array<CouponCampaign&{used:number}>>;}
export async function saveGovernedCoupon(campaign:SaveCouponCampaign){return payload(await fetch("/api/coupon-governance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"save_campaign",campaign})})) as Promise<CouponCampaign>;}
