export type UatScheduleRequest={clientRequestId:string;customerId:string;petIds:string[];serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting"|"pet_taxi"|"dog_walking";cityId?:string;zoneId?:string;serviceAddress?:string;servicePincode?:string;scheduledStart:string;scheduledEnd:string;occurrences?:number;cadenceDays?:number;weekdays?:number[];careMode?:"visit"|"overnight";preferredProviderId?:string};
export type UatScheduleResult={groupId:string;provider:{id:string;name:string;model:"full_time"|"commission"};mode:"automatic"|"offer"|"manual_review";occurrences:Array<{start:string;end:string;occurrenceNumber:number}>;explanation:string[]};
/**
 * Customer clients identify the service address they selected; they do not own provider-matching
 * authority. `/api/uat-scheduling` derives city, zone, coordinates and radius again on the server.
 * cityId/zoneId remain optional for older callers and UI display compatibility, but the route ignores
 * them when deciding who can be assigned.
 */
const REFUSAL_COPY:Record<string,string>={
  NO_SCHEDULE_AVAILABLE:"No provider is available for the date and time you chose. Please pick another slot.",
  SLOT_TAKEN:"That slot was taken while you were booking. Please choose another one.",
};
const GENERIC_REFUSAL="We could not reserve this slot. Please choose another time, or contact PawSpace support.";
type SchedulingEvaluation={providerName?:string;eligible?:boolean;reasons?:string[]};
export function schedulingRefusalMessage(code:string|undefined,evaluations?:SchedulingEvaluation[]){const base=(code&&REFUSAL_COPY[code])||GENERIC_REFUSAL;const reasons=(evaluations??[]).filter(item=>item&&item.eligible!==true).flatMap(item=>item.reasons??[]).map(reason=>String(reason).trim()).filter(Boolean);const distinct=[...new Set(reasons)];return distinct.length===1?`${base} (${distinct[0]})`:base;}
export async function reserveUatSchedule(input:UatScheduleRequest){const response=await fetch("/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const body=await response.json() as {data?:UatScheduleResult;error?:string;evaluations?:SchedulingEvaluation[]};if(!response.ok||!body.data)throw new Error(schedulingRefusalMessage(body.error,body.evaluations));return body.data;}