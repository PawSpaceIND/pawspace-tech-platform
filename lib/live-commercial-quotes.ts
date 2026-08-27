import{createBoardingQuote,listBoardingPackages,type BoardingPaymentMode}from"./boarding-governance";
import{createSittingQuote,listSittingPackages,type SittingPaymentMode}from"./sitting-governance";
import{resolveLivePrice}from"./live-pricing-resolver";
import{splitPaymentPlan}from"./stay-split-payments";

function requiredLocationScope(input:{cityId?:string;zoneId?:string}){
  const cityId=String(input.cityId||"").trim().toLowerCase(),zoneId=String(input.zoneId||"").trim().toLowerCase();
  if(!cityId||!zoneId)throw new Response("City and zone are required for a live commercial quote",{status:400});
  if(!zoneId.startsWith(`${cityId}-`))throw new Response("Quote city and zone do not match",{status:409});
  return{cityId,zoneId};
}

/*
 * The catalogue half of the same screen. [PTJA-W1-F14]
 *
 * MEASURED before this existed, driving the real GET and POST handlers of
 * app/api/boarding-commercial/route.ts against one database:
 *
 *   BEFORE  GET packages: boarding-24h shown 699   POST quote: base 699,  2 units, 2 pets -> 2796
 *   -- ops activates 'Luxury Stay' at 2500 in Pricing Control --
 *   AFTER   GET packages: boarding-24h shown 699   POST quote: base 2500, 2 units, 2 pets -> 10000
 *
 * app/boarding/page.tsx renders `money(item.base_price_per_pet) / pet / unit` from that GET, and the
 * sticky quote panel directly underneath it renders the POST's totalAmount. So the customer picked a
 * card advertising Rs 699 per pet per unit and was quoted Rs 10,000 for it on the same screen, with no
 * third surface to arbitrate and nothing explaining the difference. The same split existed for Pet
 * Sitting: app/sitting/page.tsx renders activePackage.base_price_per_pet from listSittingPackages
 * while POST /api/sitting-commercial prices through createLiveSittingQuote.
 *
 * lib/live-pricing-resolver.ts is documented as the single bridge between the operator's Pricing
 * Control state and the customer price. The listing endpoints bypassed it; these route them through
 * it, one resolve per listed package, exactly as the quote builders above do - including the same
 * fallback contract, quoted from that module: "If the row remains inactive, callers get their
 * pre-existing fallback unchanged." A package with no active Pricing Control row is returned with its
 * catalogue price untouched, and says so.
 */
type CataloguePriceScope={at?:string;cityId:string;zoneId:string};

/** Resolves one catalogue price through Pricing Control, leaving it alone when nothing is active. */
async function livePrice(db:D1Database,packageCode:string,fallbackPrice:number,scope:CataloguePriceScope,scheduledStart:string){
  const live=await resolveLivePrice(db,{packageCode,fallbackPrice,scheduledStart,cityId:scope.cityId,zoneId:scope.zoneId});
  return live.source==="pricing_control"?{price:live.price,source:live.source}:{price:fallbackPrice,source:live.source};
}

export async function listLiveBoardingPackages(db:D1Database,scope:CataloguePriceScope){
  const scheduledStart=scope.at||new Date().toISOString();
  const rows=await listBoardingPackages(db,scope.at);
  return Promise.all(rows.map(async row=>{
    const resolved=await livePrice(db,String(row.package_code),Number(row.base_price_per_pet),scope,scheduledStart);
    return{...row,base_price_per_pet:resolved.price,price_source:resolved.source};
  }));
}

export async function listLiveSittingPackages(db:D1Database,scope:CataloguePriceScope){
  const scheduledStart=scope.at||new Date().toISOString();
  const rows=await listSittingPackages(db,scope.at);
  return Promise.all(rows.map(async row=>{
    // The extra-pet price is a separate Pricing Control package code, and createLiveSittingQuote
    // resolves it separately too. The card would otherwise advertise a stale second-pet price.
    const code=String(row.package_code);
    const [base,extra]=await Promise.all([
      livePrice(db,code,Number(row.base_price_per_pet),scope,scheduledStart),
      livePrice(db,`${code}__extra_pet`,Number(row.extra_pet_price),scope,scheduledStart),
    ]);
    return{...row,base_price_per_pet:base.price,extra_pet_price:extra.price,price_source:base.source==="pricing_control"||extra.source==="pricing_control"?"pricing_control":"fallback_default"};
  }));
}

export async function createLiveBoardingQuote(db:D1Database,input:{packageCode:string;petCount:number;scheduledStart:string;scheduledEnd:string;paymentMode:BoardingPaymentMode;couponCode?:string;cityId?:string;zoneId?:string}){
  const scope=requiredLocationScope(input),quote=await createBoardingQuote(db,{...input,...scope});
  const live=await resolveLivePrice(db,{packageCode:quote.packageCode,fallbackPrice:quote.basePricePerPet,scheduledStart:quote.scheduledStart,cityId:scope.cityId,zoneId:scope.zoneId});
  if(live.source==="fallback_default")return quote;
  const totalAmount=live.price*quote.petCount*quote.stayUnits;
  const amountDueNow=quote.paymentMode==="split_50_50"?splitPaymentPlan({totalAmount,scheduledStart:quote.scheduledStart}).dueNow:totalAmount;
  // The priced UNIT is written back beside the priced total, so governBoardingBooking records a
  // decomposition that adds up to what was charged rather than the stale catalogue figure. [PTJA-W1-F15]
  await db.prepare("UPDATE boarding_commercial_quotes SET total_amount=?,amount_due_now=?,priced_base_price_per_pet=? WHERE id=? AND status='open'").bind(totalAmount,amountDueNow,live.price,quote.quoteId).run();
  return{...quote,basePricePerPet:live.price,totalAmount,amountDueNow};
}

export async function createLiveSittingQuote(db:D1Database,input:{packageCode:string;petCount:number;scheduledStart:string;scheduledEnd:string;paymentMode:SittingPaymentMode;couponCode?:string;cityId?:string;zoneId?:string}){
  const scope=requiredLocationScope(input),quote=await createSittingQuote(db,{...input,...scope});
  const [base,extra]=await Promise.all([
    resolveLivePrice(db,{packageCode:quote.packageCode,fallbackPrice:quote.basePricePerPet,scheduledStart:quote.scheduledStart,cityId:scope.cityId,zoneId:scope.zoneId}),
    resolveLivePrice(db,{packageCode:`${quote.packageCode}__extra_pet`,fallbackPrice:quote.extraPetPrice,scheduledStart:quote.scheduledStart,cityId:scope.cityId,zoneId:scope.zoneId}),
  ]);
  if(base.source==="fallback_default"&&extra.source==="fallback_default")return quote;
  const unitAmount=base.price+Math.max(0,quote.petCount-1)*extra.price,totalAmount=unitAmount*quote.billableUnits;
  const amountDueNow=quote.paymentMode==="split_50_50"?splitPaymentPlan({totalAmount,scheduledStart:quote.scheduledStart}).dueNow:totalAmount;
  // Both priced units, for the same reason. Whichever half resolved from Pricing Control is the one
  // that produced the total, and the other is the catalogue value this quote actually used. [PTJA-W1-F15]
  await db.prepare("UPDATE sitting_commercial_quotes SET total_amount=?,amount_due_now=?,priced_base_price_per_pet=?,priced_extra_pet_price=? WHERE id=? AND status='open'").bind(totalAmount,amountDueNow,base.price,extra.price,quote.quoteId).run();
  return{...quote,basePricePerPet:base.price,extraPetPrice:extra.price,totalAmount,amountDueNow};
}
