import{createBoardingQuote,type BoardingPaymentMode}from"./boarding-governance";
import{createSittingQuote,type SittingPaymentMode}from"./sitting-governance";
import{resolveLivePrice}from"./live-pricing-resolver";
import{SERVICE_ZONES}from"./service-zones";

// D8: a live-money Boarding/Sitting quote must be priced against an EXPLICITLY serviceable city. The
// previous `cityId ?? "blr"` / `zoneId ?? "blr-east"` fallback silently priced a Chennai (or no-city)
// request against the Bengaluru rate card. A city is serviceable only where SERVICE_ZONES defines
// zones for it — Boarding & Pet-sitting are launched in Bengaluru only today. This mirrors the
// contract already applied elsewhere: lib/service-zones.ts finding #10 ("never invent a blr zone for
// another city — return not-serviceable instead") and app/api/uat-scheduling finding #6 ("must be a
// known launched city"). A missing/unknown city, or a zone that does not belong to it, is rejected
// with a clear 400 (thrown Response, surfaced by the routes' failure() handler) rather than mispriced.
const SERVICEABLE_CITIES=new Set(Object.keys(SERVICE_ZONES).map(zoneId=>zoneId.split("-")[0]));
export function resolveQuoteLocation(input:{cityId?:string|null;zoneId?:string|null}):{cityId:string;zoneId:string}{
  const cityId=typeof input.cityId==="string"?input.cityId.trim().toLowerCase():"";
  if(!cityId||!SERVICEABLE_CITIES.has(cityId))throw new Response("A serviceable city is required for a live quote",{status:400});
  const zoneRaw=typeof input.zoneId==="string"?input.zoneId.trim().toLowerCase():"";
  const zoneId=zoneRaw||`${cityId}-east`;
  const zone=SERVICE_ZONES[zoneId];
  if(!zone||!zone.serviceAvailable||zoneId.split("-")[0]!==cityId)throw new Response("A serviceable zone is required for a live quote",{status:400});
  return{cityId,zoneId};
}

export async function createLiveBoardingQuote(db:D1Database,input:{packageCode:string;petCount:number;scheduledStart:string;scheduledEnd:string;paymentMode:BoardingPaymentMode;couponCode?:string;cityId?:string;zoneId?:string}){
  const{cityId,zoneId}=resolveQuoteLocation(input);
  const quote=await createBoardingQuote(db,input);
  const live=await resolveLivePrice(db,{packageCode:quote.packageCode,fallbackPrice:quote.basePricePerPet,scheduledStart:quote.scheduledStart,cityId,zoneId});
  if(live.source==="fallback_default")return quote;
  const totalAmount=live.price*quote.petCount*quote.stayUnits;
  await db.prepare("UPDATE boarding_commercial_quotes SET total_amount=?,amount_due_now=? WHERE id=? AND status='open'").bind(totalAmount,totalAmount,quote.quoteId).run();
  return{...quote,basePricePerPet:live.price,totalAmount,amountDueNow:totalAmount};
}

export async function createLiveSittingQuote(db:D1Database,input:{packageCode:string;petCount:number;scheduledStart:string;scheduledEnd:string;paymentMode:SittingPaymentMode;couponCode?:string;cityId?:string;zoneId?:string}){
  const{cityId,zoneId}=resolveQuoteLocation(input);
  const quote=await createSittingQuote(db,input);
  const [base,extra]=await Promise.all([
    resolveLivePrice(db,{packageCode:quote.packageCode,fallbackPrice:quote.basePricePerPet,scheduledStart:quote.scheduledStart,cityId,zoneId}),
    resolveLivePrice(db,{packageCode:`${quote.packageCode}__extra_pet`,fallbackPrice:quote.extraPetPrice,scheduledStart:quote.scheduledStart,cityId,zoneId}),
  ]);
  if(base.source==="fallback_default"&&extra.source==="fallback_default")return quote;
  const unitAmount=base.price+Math.max(0,quote.petCount-1)*extra.price,totalAmount=unitAmount*quote.billableUnits;
  await db.prepare("UPDATE sitting_commercial_quotes SET total_amount=?,amount_due_now=? WHERE id=? AND status='open'").bind(totalAmount,totalAmount,quote.quoteId).run();
  return{...quote,basePricePerPet:base.price,extraPetPrice:extra.price,totalAmount,amountDueNow:totalAmount};
}
