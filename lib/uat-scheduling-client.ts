export type UatScheduleRequest={clientRequestId:string;customerId:string;petIds:string[];serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting"|"pet_taxi"|"dog_walking";cityId?:string;zoneId:string;scheduledStart:string;scheduledEnd:string;occurrences?:number;cadenceDays?:number;weekdays?:number[];careMode?:"visit"|"overnight";preferredProviderId?:string};
export type UatScheduleResult={groupId:string;provider:{id:string;name:string;model:"full_time"|"commission"};mode:"automatic"|"offer"|"manual_review";occurrences:Array<{start:string;end:string;occurrenceNumber:number}>;explanation:string[]};
/**
 * What a REFUSAL says to the person reading it. [PTJA-P1-UI]
 *
 * Measured in a browser: a real signed-in customer with a pet, an address and a confirmed training
 * zone pressed "Reserve trainer" and was shown, verbatim, the string `NO_SCHEDULE_AVAILABLE`. The
 * refusal was correct - no trainer had published availability - and the server had ALREADY computed
 * the sentence that explains it, returning per-provider `evaluations[].reasons` such as
 * "No published availability on 2026-08-30". This client kept `body.error` and discarded all of it.
 *
 * An unmapped code must never fall through to raw output either: a future refusal code is still a
 * machine token, and a customer who sees one has been shown a bug rather than an answer.
 */
const REFUSAL_COPY:Record<string,string>={
  NO_SCHEDULE_AVAILABLE:"No provider is available for the date and time you chose. Please pick another slot.",
  SLOT_TAKEN:"That slot was taken while you were booking. Please choose another one.",
};
const GENERIC_REFUSAL="We could not reserve this slot. Please choose another time, or contact PawSpace support.";

type SchedulingEvaluation={providerName?:string;eligible?:boolean;reasons?:string[]};

/** The refusal sentence, plus the server's own reason when it gave one and they all agree. */
export function schedulingRefusalMessage(code:string|undefined,evaluations?:SchedulingEvaluation[]){
  const base=(code&&REFUSAL_COPY[code])||GENERIC_REFUSAL;
  const reasons=(evaluations??[]).filter(item=>item&&item.eligible!==true).flatMap(item=>item.reasons??[]).map(reason=>String(reason).trim()).filter(Boolean);
  // Only when every ineligible provider gave the SAME reason: "Kiran is unavailable" is not the
  // customer's business, but "no trainer has published availability on that date" is exactly what
  // they need in order to act.
  const distinct=[...new Set(reasons)];
  return distinct.length===1?`${base} (${distinct[0]})`:base;
}

export async function reserveUatSchedule(input:UatScheduleRequest){const response=await fetch("/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const body=await response.json() as {data?:UatScheduleResult;error?:string;evaluations?:SchedulingEvaluation[]};if(!response.ok||!body.data)throw new Error(schedulingRefusalMessage(body.error,body.evaluations));return body.data;}
