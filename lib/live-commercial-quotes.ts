import{createBoardingQuote,type BoardingPaymentMode}from"./boarding-governance";
import{createSittingQuote,type SittingPaymentMode}from"./sitting-governance";
import{resolveLivePrice}from"./live-pricing-resolver";
import{splitPaymentPlan}from"./stay-split-payments";

export async function createLiveBoardingQuote(db:D1Database,input:{packageCode:string;petCount:number;scheduledStart:string;scheduledEnd:string;paymentMode:BoardingPaymentMode;couponCode?:string;cityId?:string;zoneId?:string}){
  const quote=await createBoardingQuote(db,input);
  const live=await resolveLivePrice(db,{packageCode:quote.packageCode,fallbackPrice:quote.basePricePerPet,scheduledStart:quote.scheduledStart,cityId:input.cityId??"blr",zoneId:input.zoneId??"blr-east"});
  if(live.source==="fallback_default")return quote;
  const totalAmount=live.price*quote.petCount*quote.stayUnits;
  const amountDueNow=quote.paymentMode==="split_50_50"?splitPaymentPlan({totalAmount,scheduledStart:quote.scheduledStart}).dueNow:totalAmount;
  await db.prepare("UPDATE boarding_commercial_quotes SET total_amount=?,amount_due_now=? WHERE id=? AND status='open'").bind(totalAmount,amountDueNow,quote.quoteId).run();
  return{...quote,basePricePerPet:live.price,totalAmount,amountDueNow};
}

export async function createLiveSittingQuote(db:D1Database,input:{packageCode:string;petCount:number;scheduledStart:string;scheduledEnd:string;paymentMode:SittingPaymentMode;couponCode?:string;cityId?:string;zoneId?:string}){
  const quote=await createSittingQuote(db,input);
  const [base,extra]=await Promise.all([
    resolveLivePrice(db,{packageCode:quote.packageCode,fallbackPrice:quote.basePricePerPet,scheduledStart:quote.scheduledStart,cityId:input.cityId??"blr",zoneId:input.zoneId??"blr-east"}),
    resolveLivePrice(db,{packageCode:`${quote.packageCode}__extra_pet`,fallbackPrice:quote.extraPetPrice,scheduledStart:quote.scheduledStart,cityId:input.cityId??"blr",zoneId:input.zoneId??"blr-east"}),
  ]);
  if(base.source==="fallback_default"&&extra.source==="fallback_default")return quote;
  const unitAmount=base.price+Math.max(0,quote.petCount-1)*extra.price,totalAmount=unitAmount*quote.billableUnits;
  const amountDueNow=quote.paymentMode==="split_50_50"?splitPaymentPlan({totalAmount,scheduledStart:quote.scheduledStart}).dueNow:totalAmount;
  await db.prepare("UPDATE sitting_commercial_quotes SET total_amount=?,amount_due_now=? WHERE id=? AND status='open'").bind(totalAmount,amountDueNow,quote.quoteId).run();
  return{...quote,basePricePerPet:base.price,extraPetPrice:extra.price,totalAmount,amountDueNow};
}
