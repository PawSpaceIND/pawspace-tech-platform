export type BoardingPackage={package_code:string;name:string;care_kind:"daycare"|"overnight";max_hours:number;base_price_per_pet:number;currency:string;max_pets:number;version:number};
export type BoardingHost={providerId:string;name:string;model:"full_time"|"commission";area:string;rating:number;qualityScore:number;capacity:number;availableGuestPets?:number;species:string[];oneFamilyOnly:boolean;medicationSupport:boolean;residentPets:string;homeVerified:boolean;kycStatus:string;backgroundCheckStatus:string;profileVersion:number;availabilityVerified?:boolean;availabilityMode?:"uat_canonical";commitments?:number};
export type BoardingQuote={quoteId:string;packageCode:string;packageName:string;packageVersion:number;petCount:number;cityId:string;zoneId:string;scheduledStart:string;scheduledEnd:string;durationHours:number;stayUnits:number;basePricePerPet:number;totalAmount:number;amountDueNow:number;paymentMode:"prepaid"|"split_50_50";expiresAt:number;liveMoney:false};
export type BoardingCommercial={packages:BoardingPackage[];hosts:BoardingHost[];source:string;availabilityMode:"uat_canonical"|"catalogue_only";availabilityVerified:boolean;liveAvailability:false;liveMoney:false};

async function boardingRequest<T>(url:string,init:RequestInit={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  const response=await fetch(url,{...init,signal:controller.signal});
  const body=await response.json() as {data?:T;error?:string}|null;
  if(!response.ok||!body?.data)throw new Error(body?.error||"Boarding request failed. Please try again.");
  return body.data;
 }catch(error){if(controller.signal.aborted)throw new Error("Boarding request timed out. Please try again.");if(error instanceof SyntaxError)throw new Error("Boarding response could not be read. Please try again.");throw error;}
 finally{clearTimeout(timer);}
}
export async function loadBoardingCommercial(input:{cityId:string;zoneId:string;scheduledStart?:string;scheduledEnd?:string;petCount?:number;species?:string[]}){const query=new URLSearchParams({cityId:input.cityId,zoneId:input.zoneId});if(input.scheduledStart)query.set("scheduledStart",input.scheduledStart);if(input.scheduledEnd)query.set("scheduledEnd",input.scheduledEnd);if(input.petCount)query.set("petCount",String(input.petCount));if(input.species?.length)query.set("species",input.species.join(","));return boardingRequest<BoardingCommercial>(`/api/boarding-commercial?${query.toString()}`,{cache:"no-store"});}
export async function quoteBoarding(input:{packageCode:string;petCount:number;cityId:string;zoneId:string;scheduledStart:string;scheduledEnd:string;paymentMode:"prepaid"|"split_50_50";couponCode?:string}){return boardingRequest<BoardingQuote>("/api/boarding-commercial",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});}
