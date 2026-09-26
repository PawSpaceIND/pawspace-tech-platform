import type {BoardingRequirements} from "./stay-host-requirements";
// @ts-expect-error Node 22 strip-types requires the explicit .ts extension at runtime.
import{readJsonBody}from"./safe-json-response.ts";
export type BoardingPackage={package_code:string;name:string;care_kind:"daycare"|"overnight";max_hours:number;base_price_per_pet:number;currency:string;max_pets:number;version:number};
export type BoardingHost={providerId:string;name:string;model:"full_time"|"commission";area:string;rating:number;qualityScore:number;capacity:number;availableGuestPets?:number;species:string[];oneFamilyOnly:boolean;medicationSupport:boolean;residentPets:string;homeVerified:boolean;kycStatus:string;backgroundCheckStatus:string;profileVersion:number;availabilityVerified?:boolean;availabilityMode?:"uat_canonical";commitments?:number};
export type BoardingQuote={quoteId:string;packageCode:string;packageName:string;packageVersion:number;petCount:number;cityId:string;zoneId:string;scheduledStart:string;scheduledEnd:string;durationHours:number;stayUnits:number;basePricePerPet:number;totalAmount:number;amountDueNow:number;paymentMode:"prepaid"|"split_50_50";expiresAt:number;liveMoney:false};
export type BoardingCommercial={packages:BoardingPackage[];hosts:BoardingHost[];source:string;availabilityMode:"uat_canonical"|"catalogue_only";availabilityVerified:boolean;liveAvailability:false;liveMoney:false};

/** `signal` cancels a request that a newer one replaced; `timeoutMessage` is what the customer reads when it runs out of time. */
type BoardingRequestOptions={signal?:AbortSignal;timeoutMs?:number;timeoutMessage?:string};
async function boardingRequest<T>(url:string,init:RequestInit={},options:BoardingRequestOptions={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs??15000),cancel=()=>controller.abort();
 options.signal?.addEventListener("abort",cancel,{once:true});if(options.signal?.aborted)controller.abort();
 try{
  const response=await fetch(url,{...init,signal:controller.signal});
  // A timeout page or an empty body is a plain sentence, never a JSON parse error.
  const body=await readJsonBody<{data?:T;error?:string}>(response);
  if(body===undefined)throw new Error(response.status>=500?"Boarding is taking longer than usual to respond. Please try again.":"Boarding response could not be read. Please try again.");
  if(!response.ok||!body?.data)throw new Error(body?.error||"Boarding request failed. Please try again.");
  return body.data;
 }catch(error){if(controller.signal.aborted)throw new Error(options.timeoutMessage??"Boarding request timed out. Please try again.");if(error instanceof SyntaxError)throw new Error("Boarding response could not be read. Please try again.");throw error;}
 finally{clearTimeout(timer);options.signal?.removeEventListener("abort",cancel);}
}
/** The host search. A search that runs out of time says it is still checking; it never reads as "no host available". */
export async function loadBoardingCommercial(input:{cityId:string;zoneId:string;scheduledStart?:string;scheduledEnd?:string;petCount?:number;species?:string[];requirements?:BoardingRequirements},options:{signal?:AbortSignal}={}){const query=new URLSearchParams({cityId:input.cityId,zoneId:input.zoneId});if(input.scheduledStart)query.set("scheduledStart",input.scheduledStart);if(input.scheduledEnd)query.set("scheduledEnd",input.scheduledEnd);if(input.petCount)query.set("petCount",String(input.petCount));if(input.species?.length)query.set("species",input.species.join(","));for(const key of ["medicationRequired","noResidentPets","oneFamilyOnly"]as const)if(input.requirements?.[key])query.set(key,"true");return boardingRequest<BoardingCommercial>(`/api/boarding-commercial?${query.toString()}`,{cache:"no-store"},{signal:options.signal,timeoutMs:30_000,timeoutMessage:"Still checking host availability - the search timed out. Please try again."});}
export async function quoteBoarding(input:{packageCode:string;petCount:number;cityId:string;zoneId:string;scheduledStart:string;scheduledEnd:string;paymentMode:"prepaid"|"split_50_50";couponCode?:string;providerId?:string}){return boardingRequest<BoardingQuote>("/api/boarding-commercial",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});}
