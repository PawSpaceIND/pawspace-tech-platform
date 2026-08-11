import{groomingCatalogue,governGroomingBooking,type GroomingGovernanceInput,type GroomingGovernanceResult}from"./grooming-governance";
import{groomingPricingPackageCode}from"./grooming-pricing-code";
import{resolveLivePrice}from"./live-pricing-resolver";

/** Keeps the already-verified single-pet/subscription path untouched; only the ledger-open regular
 * multi-pet case is handled here. The Pricing Control row is count-specific so a 2/3/4-pet bundle
 * can be priced independently instead of incorrectly multiplying a single-pet operator price. */
export async function governGroomingBookingWithLiveMultiPet(db:D1Database,input:GroomingGovernanceInput):Promise<GroomingGovernanceResult>{
  if(input.pets.length<=1||input.packageCode.startsWith("sub-"))return governGroomingBooking(db,input);
  const item=groomingCatalogue.find(row=>row.active&&row.code===input.packageCode);
  if(!item)return governGroomingBooking(db,input);
  const petCount=input.pets.length,maxPets=item.maxPetsPerBooking??4;
  if(petCount<2||petCount>maxPets)throw new Error(`Grooming supports between 1 and ${maxPets} pets for this plan`);
  for(const pet of input.pets){const species=pet.species??"other";if(!item.eligiblePetTypes.includes(species))throw new Error(`${item.name} is not eligible for ${species}`);}
  const fallbackTotal=(item.multiPetPrice??item.singlePrice)*petCount;
  const live=input.scheduledStart?await resolveLivePrice(db,{packageCode:groomingPricingPackageCode(item.code,petCount),fallbackPrice:fallbackTotal,scheduledStart:input.scheduledStart,cityId:input.cityId,zoneId:input.zoneId}):{price:fallbackTotal,source:"fallback_default" as const};
  const totalAmount=live.price;
  if(Math.round(input.submittedTotal)!==Math.round(totalAmount))throw new Error(`Submitted Grooming total does not match governed catalogue ${item.version}`);
  const amountDueNow=input.paymentMode==="prepaid"?totalAmount:0;
  if(Math.round(input.submittedAmountDueNow)!==Math.round(amountDueNow))throw new Error("Submitted amount due now does not match the governed payment mode");
  return{packageCode:item.code,packageName:item.name,catalogueVersion:item.version,offerType:item.offerType,petCount,totalAmount,amountDueNow};
}
