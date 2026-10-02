import type {V2GroomingPackage} from './grooming-client';
export type PublicGroomingSubscription={code:string;name:string;price:number;currency:string;sessions:number;validityValue:number;validityUnit:'days'|'months';eligiblePetTypes:string[];servicePackageCode:string;maxPetsPerBooking:number;creditsPerPet:number;effectiveFrom:string;effectiveTo:string|null;version:number;familyWallet:boolean};
/** Read projection only: no prices, credits, dates or eligibility are invented. */
export function subscriptionPackage(plan:PublicGroomingSubscription,care:V2GroomingPackage,audience:V2GroomingPackage["audience"]=care.audience):V2GroomingPackage|null{
 if(!plan.eligiblePetTypes.includes(audience)||!Number.isFinite(plan.price)||plan.price<=0||!Number.isInteger(plan.sessions)||plan.sessions<1||!Number.isInteger(plan.validityValue)||plan.validityValue<1||!Number.isInteger(plan.maxPetsPerBooking)||plan.maxPetsPerBooking<1||!Number.isInteger(plan.version)||plan.version<1||!/^[A-Z]{3}$/.test(plan.currency)||!Number.isInteger(plan.creditsPerPet)||plan.creditsPerPet<1)return null;
 const bundles=care.bundles.filter(b=>b.petCount<=plan.maxPetsPerBooking&&b.petCount*plan.creditsPerPet<=plan.sessions).map(b=>({...b,packageCode:plan.code,price:plan.price,currency:plan.currency,effectiveFrom:plan.effectiveFrom,effectiveTo:plan.effectiveTo}));
 return bundles.length?{...care,audience,code:plan.code,name:plan.name,subscription:plan,bundles}:null;
}
export function subscriptionSavings(pkg:V2GroomingPackage,care:V2GroomingPackage):number|null{
 const plan=pkg.subscription,one=care.bundles.find(b=>b.petCount===1);if(!plan||!one||plan.creditsPerPet!==1||one.currency!==plan.currency)return null;
 return Math.max(0,Math.round((one.price*plan.sessions-plan.price)*100)/100);
}
