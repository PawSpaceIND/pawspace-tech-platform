// @ts-expect-error Node 22 strip-types requires the explicit .ts extension at runtime.
import{readJsonBody}from"./safe-json-response.ts";
export type UatScheduleRequest={clientRequestId:string;customerId:string;petIds:string[];serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting"|"pet_taxi"|"dog_walking";cityId?:string;zoneId?:string;serviceAddress?:string;servicePincode?:string;latitude?:number;longitude?:number;scheduledStart:string;scheduledEnd:string;occurrences?:number;cadenceDays?:number;weekdays?:number[];careMode?:"visit"|"overnight";preferredProviderId?:string};
export type UatScheduleResult={groupId:string;provider:{id:string;name:string;model:"full_time"|"commission"};mode:"automatic"|"offer"|"manual_review";occurrences:Array<{start:string;end:string;occurrenceNumber:number}>;explanation:string[]};
const REFUSAL_COPY:Record<string,string>={SELECTED_SITTER_UNAVAILABLE:"Your selected sitter is no longer available. Search again and choose another sitter.",SELECTED_PROVIDER_UNAVAILABLE:"Your selected provider is no longer available. Refresh availability and choose again.",provider_selection_required:"Choose an available provider before confirming this service.",manual_workflow_required:"This request needs PawSpace Operations rather than automatic provider assignment.",NO_SCHEDULE_AVAILABLE:"No provider is available for the date and time you chose. Please pick another slot.",SLOT_TAKEN:"That slot was taken while you were booking. Please choose another one.",below_minimum_lead_time:"This service needs more notice than that. Please choose a later start time.",SCHEDULING_BUSY:"Scheduling is busy for a moment. Please try again - trying again will not book twice.",SCHEDULING_CONFLICT:"The schedule changed while you were booking. Please try again.",SCHEDULING_PREVIEW_TIMEOUT:"Checking availability is taking longer than usual. Please try again in a moment.",RESERVE_UNREADABLE:"PawSpace is taking longer than usual to confirm this slot. Please try again in a moment - trying again will not book twice."},GENERIC_REFUSAL="We could not reserve this slot. Please choose another time, or contact PawSpace support.";
type SchedulingEvaluation={providerName?:string;eligible?:boolean;reasons?:string[]};
export function schedulingRefusalMessage(code:string|undefined,evaluations?:SchedulingEvaluation[]){const base=(code&&REFUSAL_COPY[code])||GENERIC_REFUSAL,reasons=(evaluations??[]).filter(item=>item&&item.eligible!==true).flatMap(item=>item.reasons??[]).map(reason=>String(reason).trim()).filter(Boolean),distinct=[...new Set(reasons)];return distinct.length===1?`${base} (${distinct[0]})`:base;}
// Refusals name their reason either in `error` (SLOT_TAKEN, NO_SCHEDULE_AVAILABLE) or, for policy refusals such as
// below_minimum_lead_time, in `code` beside a human sentence. Keep the recognised one so callers can react to it.
export class SchedulingRefusal extends Error { readonly code:string|undefined; constructor(code:string|undefined,evaluations?:SchedulingEvaluation[]){super(schedulingRefusalMessage(code,evaluations));this.name="SchedulingRefusal";this.code=code;} }
/** A refusal that only means this trainer or slot is taken, so another eligible trainer may still take the booking. */
export function isProviderSlotRefusal(error:unknown){return error instanceof SchedulingRefusal&&["SLOT_TAKEN","NO_SCHEDULE_AVAILABLE","SELECTED_PROVIDER_UNAVAILABLE"].includes(String(error.code));}
function selectedAddress(){if(typeof window==="undefined")return null;try{const raw=window.sessionStorage.getItem("pawspace.selected-service-address");if(!raw)return null;const parsed=JSON.parse(raw)as{address?:unknown;pincode?:unknown;assignment?:{pincode?:unknown};latitude?:unknown;longitude?:unknown;verification?:unknown},address=String(parsed.address||"").trim(),pincode=String(parsed.pincode||parsed.assignment?.pincode||"").trim(),latitude=Number(parsed.latitude),longitude=Number(parsed.longitude),mapped=parsed.verification!=="manual"&&Number.isFinite(latitude)&&Number.isFinite(longitude);return address&&/^[1-9][0-9]{5}$/.test(pincode)?{serviceAddress:address,servicePincode:pincode,...(mapped?{latitude,longitude}:{})}:null;}catch{return null;}}
/** The browser may identify the selected address, but city/zone/coordinates/radius are deliberately not authoritative. */
export async function reserveUatSchedule(input:UatScheduleRequest){const remembered=!input.serviceAddress&&!input.servicePincode?selectedAddress():null,payload={...input,...remembered},response=await fetch("/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}),body=await readJsonBody<{data?:UatScheduleResult;error?:string;code?:string;evaluations?:SchedulingEvaluation[]}>(response);/* A timeout page or an empty body is a plain retry sentence, never a JSON parse error. */if(!body)throw new SchedulingRefusal("RESERVE_UNREADABLE");if(!response.ok||!body.data)throw new SchedulingRefusal(body.code&&REFUSAL_COPY[body.code]?body.code:body.error,body.evaluations);return body.data;}
export type ProviderPreview={occurrences?:Array<{start:string;end:string;occurrenceNumber:number}>;providers:Array<{id:string;name:string;model:"full_time"|"commission";rating?:number;qualityScore?:number}>;availabilityChecked:true;reserved:false;cityId:string;zoneId:string;scheduledStart:string;scheduledEnd:string};
export type SitterPreview=ProviderPreview;
/**
 * The availability check did not finish (the server's 20 s deadline, a busy or timed-out platform, or the
 * browser's own limit). It is NOT an answer: the screen says it is still checking and offers a retry, and
 * never tells the customer that nobody is available.
 */
export class AvailabilityPending extends Error{readonly retryAfterSeconds:number;constructor(message:string,retryAfterSeconds=5){super(message);this.name="AvailabilityPending";this.retryAfterSeconds=retryAfterSeconds;}}
export function isAvailabilityPending(error:unknown):error is AvailabilityPending{return error instanceof AvailabilityPending;}
const STILL_CHECKING="Still checking availability - this is taking longer than usual. Please try again in a moment.";
export async function previewUatProviders(input:UatScheduleRequest,options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<ProviderPreview>{
 const controller=new AbortController();
 // Staging availability checks take 16-30 s per zone; 15 s cut every V2 grooming search off before it finished.
 const timeout=Number.isFinite(options.timeoutMs)?Math.min(90_000,Math.max(1000,options.timeoutMs!)):60_000;
 const abort=()=>controller.abort();
 options.signal?.addEventListener("abort",abort,{once:true});
 if(options.signal?.aborted)controller.abort();
 const timer=setTimeout(abort,timeout);
 try{
  const remembered=!input.serviceAddress&&!input.servicePincode?selectedAddress():null;
  for(let attempt=0;;attempt+=1){
   const response=await fetch("/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...input,...remembered,action:"preview"}),signal:controller.signal});
   const body=await readJsonBody<{data?:ProviderPreview;error?:string;code?:string;retryAfterSeconds?:number}>(response);
   if(response.ok&&body?.data&&Array.isArray(body.data.providers))return body.data;
   // The server stops at its own 20 s deadline with 503 SCHEDULING_PREVIEW_TIMEOUT and finishes warming up in the
   // background, so a second check after Retry-After usually answers in a few seconds. Retry once, inside the same
   // overall time limit, instead of asking the customer to press the button again.
   if(attempt===0&&response.status===503&&body?.code==="SCHEDULING_PREVIEW_TIMEOUT"){
    const waitMs=Math.min(10,Math.max(1,Number(body.retryAfterSeconds)||5))*1000;
    await new Promise<void>((resolve,reject)=>{const wait=setTimeout(resolve,waitMs);controller.signal.addEventListener("abort",()=>{clearTimeout(wait);reject(new Error("aborted"));},{once:true});});
    continue;
   }
   // An unfinished check (deadline, busy, gateway timeout, unreadable 5xx page) is "still checking", not "none available".
   if(response.status>=500||body?.code==="SCHEDULING_PREVIEW_TIMEOUT")throw new AvailabilityPending(body?.error||STILL_CHECKING,Number(body?.retryAfterSeconds)||Number(response.headers?.get?.("retry-after"))||5);
   if(!body)throw new Error("Availability response could not be read. Please try again.");
   throw new Error(body.error||"Unable to load available care professionals. Please try again.");
  }
 }catch(error){
  if(controller.signal.aborted)throw new AvailabilityPending("Still checking availability - the search timed out. Please try again.");
  throw error;
 }finally{clearTimeout(timer);options.signal?.removeEventListener("abort",abort);}
}
/** `signal` lets the page cancel a search that a newer one replaced. */
export async function previewSitters(input:UatScheduleRequest,options:{signal?:AbortSignal}={}):Promise<SitterPreview>{return previewUatProviders({...input,serviceCode:"pet_sitting"},{timeoutMs:60_000,signal:options.signal});}
