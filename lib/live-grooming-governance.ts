import{groomingCatalogue,governGroomingBooking,type GroomingCatalogueItem,type GroomingGovernanceInput,type GroomingGovernanceResult}from"./grooming-governance";
import{groomingTaxBreakdown}from"./grooming-invoice";
import{groomingPricingPackageCode}from"./grooming-pricing-code";
import{resolveLivePrice}from"./live-pricing-resolver";

const round2=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
function pairedItem(item:GroomingCatalogueItem,species:"dog"|"cat"){
 if(item.eligiblePetTypes.includes(species))return item;
 const prefix=species==="dog"?"dog-":"cat-",suffix=item.code.replace(/^(dog|cat)-/,"");
 return groomingCatalogue.find(candidate=>candidate.active&&candidate.code===`${prefix}${suffix}`&&candidate.offerType===item.offerType)??null;
}
/** Keeps subscription/single-pet behaviour untouched; regular multi-pet quotes get explicit species,
 * discount and GST guardrails. Mixed dog+cat bookings resolve the equivalent catalogue package per pet. */
export async function governGroomingBookingWithLiveMultiPet(db:D1Database,input:GroomingGovernanceInput):Promise<GroomingGovernanceResult>{
 if(input.pets.length<=1||input.packageCode.startsWith("sub-"))return governGroomingBooking(db,input);
 const item=groomingCatalogue.find(row=>row.active&&row.code===input.packageCode);
 if(!item)return governGroomingBooking(db,input);
 const petCount=input.pets.length,maxPets=item.maxPetsPerBooking??4;if(petCount<2||petCount>maxPets)throw new Error(`Grooming supports between 1 and ${maxPets} pets for this plan`);
 const species=input.pets.map(p=>p.species??"other");if(species.some(value=>value!=="dog"&&value!=="cat"))throw new Error("Multi-pet Grooming requires each saved pet to be explicitly a dog or cat");
 const resolved=species.map(value=>pairedItem(item,value as "dog"|"cat"));if(resolved.some(value=>!value))throw new Error(`${item.name} has no governed equivalent for every selected pet species`);
 const items=resolved as GroomingCatalogueItem[],basePrice=round2(items.reduce((sum,row)=>sum+row.singlePrice,0));
 const fallbackTotal=round2(items.reduce((sum,row)=>sum+(row.multiPetPrice??row.singlePrice),0));
 // A homogeneous bundle may have a count-specific live Pricing Control row. Mixed-species bundles use
 // the two governed catalogue prices until Pricing Control publishes a dedicated mixed bundle code.
 const homogeneous=new Set(species).size===1;
 const live=homogeneous&&input.scheduledStart?await resolveLivePrice(db,{packageCode:groomingPricingPackageCode(item.code,petCount),fallbackPrice:fallbackTotal,scheduledStart:input.scheduledStart,cityId:input.cityId,zoneId:input.zoneId}):{price:fallbackTotal,source:"fallback_default" as const};
 const discounted=round2(live.price),breakdown=await groomingTaxBreakdown(db,input.cityId,discounted,basePrice),totalAmount=breakdown.gstMode==="exclusive"?breakdown.totalAmount:discounted;
 if(Math.round(input.submittedTotal)!==Math.round(totalAmount))throw new Error(`Submitted Grooming total does not match governed catalogue ${item.version}`);
 const amountDueNow=input.paymentMode==="prepaid"?totalAmount:0;if(Math.round(input.submittedAmountDueNow)!==Math.round(amountDueNow))throw new Error("Submitted amount due now does not match the governed payment mode");
 return{packageCode:item.code,packageName:item.name,catalogueVersion:item.version,offerType:item.offerType,petCount,totalAmount,amountDueNow,pricingBreakdown:{...breakdown,totalAmount}};
}
