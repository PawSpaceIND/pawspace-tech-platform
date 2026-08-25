import{createBoardingQuote,type BoardingPaymentMode}from"./boarding-governance";
import{createSittingQuote,type SittingPaymentMode}from"./sitting-governance";
import{resolveLivePrice}from"./live-pricing-resolver";
import{splitPaymentPlan}from"./stay-split-payments";

function quoteLocation(input:{cityId?:string;zoneId?:string}){
  const cityId=String(input.cityId??"").trim(),zoneId=String(input.zoneId??"").trim();
  return cityId&&zoneId?{cityId,zoneId}:null;
}

export async function createLiveBoardingQuote(db:D1Database,input:{packageCode:string;petCount:number;scheduledStart:string;scheduledEnd:string;paymentMode:BoardingPaymentMode;couponCode?:string;cityId?:string;zoneId?:string}){
  const quote=await createBoardingQuote(db,input),location=quoteLocation(input);
  // A missing location means there is no safe city-specific live override to apply. Keep the governed
  // package quote instead of silently borrowing Bengaluru pricing.
  if(!location)return quote;
  const live=await resolveLivePrice(db,{packageCode:quote.packageCode,fallbackPrice:quote.basePricePerPet,scheduledStart:quote.scheduledStart,...location});
  if(live.source==="fallback_default")return quote;
  const totalAmount=live.price*quote.petCount*quote.stayUnits;
  const amountDueNow=quote.paymentMode==="split_50_50"?splitPaymentPlan({totalAmount,scheduledStart:quote.scheduledStart}).dueNow:totalAmount;
  await db.prepare("UPDATE boarding_commercial_quotes SET total_amount=?,amount_due_now=? WHERE id=? AND status='open'").bind(totalAmount,amountDueNow,quote.quoteId).run();
  return{...quote,basePricePerPet:live.price,totalAmount,amountDueNow};
}

export async function createLiveSittingQuote(db:D1Database,input:{packageCode:string;petCount:number;scheduledStart:string;scheduledEnd:string;paymentMode:SittingPaymentMode;couponCode?:string;cityId?:string;zoneId?:string}){
  const quote=await createSittingQuote(db,input),location=quoteLocation(input);
  // Missing geography must never be interpreted as Bengaluru. The base package quote remains valid,
  // while live geography-specific overrides are intentionally skipped until city and zone are known.
  if(!location)return quote;
  const [base,extra]=await Promise.all([
    resolveLivePrice(db,{packageCode:quote.packageCode,fallbackPrice:quote.basePricePerPet,scheduledStart:quote.scheduledStart,...location}),
    resolveLivePrice(db,{packageCode:`${quote.packageCode}__extra_pet`,fallbackPrice:quote.extraPetPrice,scheduledStart:quote.scheduledStart,...location}),
  ]);
  if(base.source==="fallback_default"&&extra.source==="fallback_default")return quote;
  const unitAmount=base.price+Math.max(0,quote.petCount-1)*extra.price,totalAmount=unitAmount*quote.billableUnits;
  const amountDueNow=quote.paymentMode==="split_50_50"?splitPaymentPlan({totalAmount,scheduledStart:quote.scheduledStart}).dueNow:totalAmount;
  await db.prepare("UPDATE sitting_commercial_quotes SET total_amount=?,amount_due_now=? WHERE id=? AND status='open'").bind(totalAmount,amountDueNow,quote.quoteId).run();
  return{...quote,basePricePerPet:base.price,extraPetPrice:extra.price,totalAmount,amountDueNow};
}
