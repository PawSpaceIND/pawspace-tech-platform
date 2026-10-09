// Pure server-side preparation. Evidence is supplied by trusted platform readers, never request JSON.
// @ts-expect-error Explicit extension supports the repository's Node strip-types synthetic tests.
import {providerChoiceProblem} from './scheduling-provider-choice.ts';
// @ts-expect-error Explicit extension supports the repository's Node strip-types synthetic tests.
import {validateIndianPincode} from './pincode-validation.ts';
// @ts-expect-error Explicit extension supports the repository's Node strip-types synthetic tests.
import {sameInstant} from './booking-window-instant.ts';
import type {UatScheduleRequest} from './uat-scheduling-client';

type Interval = {start:string;end:string};
type Address = {id:string;customerId:string;serviceCode:string;text:string;pincode:string;cityId:string;zoneId:string;latitude:number;longitude:number;serviceable:boolean};
export type ReadinessInput = {
  event:{key:string;fingerprint:string};
  binding?:{eventKey:string;fingerprint:string;customerId:string;leadId:string;serviceCode:string;verified:boolean};
  auth?:{customerId:string;leadId:string;platformAuthorized:boolean;permission:'scheduling.book';expiresAt:number};
  request:Partial<UatScheduleRequest>;
  pets?:Array<{id:string;customerId:string}>;
  address?:Address;
  availability?:{requestKey:string;revision:string;checkedAt:number;expiresAt:number;providerIds:string[];engineEligible:boolean};
  // Must cover the complete requested interval. A platform reader supplies all active reservations.
  travel?:{requestKey:string;availabilityRevision:string;providerId:string;checkedAt:number;expiresAt:number;complete:boolean;legs:Array<{status:'configured'|'route_unavailable'|'configuration_required';durationSeconds:number;availableSeconds:number}>};
  reservations?:{availabilityRevision:string;complete:boolean;windows:Array<Interval & {providerId:string}>};
  replay?:{eventKey:string;fingerprint:string;requestKey:string};
};
export type ReadinessResult = {status:'held';holds:string[]}|{status:'ready';payload:UatScheduleRequest & {action:'preview';saveAddress:false};origin:{leadId:string;customerId:string};requestKey:string;receipt:{eventKey:string;fingerprint:string;requestKey:string};duplicateReplay:boolean;reservationAllowed:false};
const supported = new Set(['grooming','dog_training','dog_walking']);
const text = (v:unknown):v is string => typeof v==='string'&&Boolean(v.trim());
const time = (v:unknown) => typeof v==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(v)?Date.parse(v):NaN;
const fresh = (v:{checkedAt:number;expiresAt:number}|undefined,now:number,maxAge:number) => Boolean(v&&Number.isFinite(v.checkedAt)&&Number.isFinite(v.expiresAt)&&v.checkedAt<=now&&now-v.checkedAt<=maxAge&&v.expiresAt>now);
/** Stable semantic key: ISO instants and sorted pets avoid spelling/order-only replay conflicts. */
export function schedulingReadinessKey(input:ReadinessInput):string {
 const r=input.request,a=input.address,b=input.binding;
 return JSON.stringify([input.event.key,r.clientRequestId,b?.customerId,b?.leadId,r.serviceCode,[...(r.petIds??[])].sort(),a?.id,a?.text,a?.pincode,a?.cityId,a?.zoneId,a?.latitude,a?.longitude,Number.isFinite(time(r.scheduledStart))?new Date(time(r.scheduledStart)).toISOString():null,Number.isFinite(time(r.scheduledEnd))?new Date(time(r.scheduledEnd)).toISOString():null,r.providerSelection,r.preferredProviderId??null,r.occurrences??1,r.cadenceDays??null,r.weekdays??null,r.careMode??null,r.trainingQuoteId??null,r.trainingSchedulingMode??null]);
}
/** Readiness is advisory, not authorization, a reservation, or a replacement for route/engine validation. */
export function prepareCrmSchedulingReadiness(input:ReadinessInput,now:number):ReadinessResult {
 const holds:string[]=[],r=input.request,b=input.binding,a=input.address,start=time(r.scheduledStart),end=time(r.scheduledEnd),key=schedulingReadinessKey(input);
 const hold=(code:string)=>{if(!holds.includes(code))holds.push(code);};
 if(!Number.isFinite(now))hold('invalid_evaluation_time');
 if(!text(input.event.key)||!text(input.event.fingerprint)||!b?.verified||b.eventKey!==input.event.key||b.fingerprint!==input.event.fingerprint||!text(b.customerId)||!text(b.leadId)||r.customerId!==b.customerId||b.serviceCode!==r.serviceCode)hold('canonical_identity_binding_required');
 if(!input.auth?.platformAuthorized||input.auth.permission!=='scheduling.book'||input.auth.customerId!==b?.customerId||input.auth.leadId!==b?.leadId||!Number.isFinite(input.auth.expiresAt)||input.auth.expiresAt<=now)hold('platform_auth_binding_required');
 if(!text(r.serviceCode))hold('service_required');else if(!supported.has(r.serviceCode))hold('manual_service_workflow_required');
 if(!text(r.clientRequestId))hold('request_id_required');
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||start<=now)hold('requested_window_required');
 // Programme recurrence needs occurrence-specific route evidence; do not silently check only session one.
 if((r.occurrences!==undefined&&r.occurrences!==1)||(r.weekdays?.length??0)>0||r.trainingSchedulingMode)hold('recurring_workflow_required');
 if(r.careMode!==undefined)hold('manual_service_workflow_required');
 if(!Array.isArray(r.petIds)||!r.petIds.length||new Set(r.petIds).size!==r.petIds.length||r.petIds.some(id=>!text(id)||!input.pets?.some(p=>p.id===id&&p.customerId===b?.customerId)))hold('owned_pets_required');
 if(!a||!text(a.id)||a.customerId!==b?.customerId||a.serviceCode!==r.serviceCode||!text(a.text)||a.text.trim().length<8||!validateIndianPincode(a.pincode).ok||!text(a.cityId)||!text(a.zoneId)||typeof a.latitude!=='number'||typeof a.longitude!=='number'||!Number.isFinite(a.latitude)||!Number.isFinite(a.longitude)||Math.abs(a.latitude)>90||Math.abs(a.longitude)>180)hold('governed_location_required');
 if(a&&!a.serviceable)hold('address_not_serviceable');
 if(a&&((r.serviceAddress!==undefined&&r.serviceAddress!==a.text)||(r.servicePincode!==undefined&&r.servicePincode!==a.pincode)||(r.cityId!==undefined&&r.cityId!==a.cityId)||(r.zoneId!==undefined&&r.zoneId!==a.zoneId)||(r.latitude!==undefined&&r.latitude!==a.latitude)||(r.longitude!==undefined&&r.longitude!==a.longitude)))hold('address_binding_conflict');
 if(r.providerSelection===undefined||providerChoiceProblem(r))hold('provider_choice_required');
 const av=input.availability;
 if(!av||av.requestKey!==key||!text(av.revision)||!fresh(av,now,60_000))hold('fresh_bound_availability_required');
 if(av&&(!av.engineEligible||!av.providerIds.length))hold('no_eligible_availability');
 const travel=input.travel;
 if(!travel||travel.requestKey!==key||travel.availabilityRevision!==av?.revision||!travel.complete||!fresh(travel,now,60_000)||!av?.providerIds.includes(travel.providerId)||(r.providerSelection==='specific'&&r.preferredProviderId!==travel.providerId)||!travel.legs.length)hold('fresh_bound_travel_data_required');
 if(travel?.legs.some(leg=>leg.status!=='configured'||typeof leg.durationSeconds!=='number'||!Number.isFinite(leg.durationSeconds)||leg.durationSeconds<=0||typeof leg.availableSeconds!=='number'||!Number.isFinite(leg.availableSeconds)||leg.availableSeconds<0))hold('travel_data_unavailable');
 if(travel?.legs.some(leg=>leg.durationSeconds>leg.availableSeconds))hold('travel_window_conflict');
 const reservations=input.reservations;
 if(!reservations?.complete||reservations.availabilityRevision!==av?.revision)hold('reservation_snapshot_required');
 if(reservations?.windows.some(w=>!text(w.providerId)||!Number.isFinite(time(w.start))||!Number.isFinite(time(w.end))||time(w.end)<=time(w.start)))hold('reservation_snapshot_invalid');
 if(reservations?.windows.some(w=>w.providerId===travel?.providerId&&time(w.start)<end&&time(w.end)>start))hold('overlapping_slot');
 const replay=input.replay;
 if(replay&&(replay.eventKey!==input.event.key||replay.fingerprint!==input.event.fingerprint||replay.requestKey!==key))hold('duplicate_replay_conflict');
 if(holds.length)return {status:'held',holds};
 const payload:UatScheduleRequest & {action:'preview';saveAddress:false}={clientRequestId:r.clientRequestId!,customerId:b!.customerId,petIds:[...r.petIds!],serviceCode:r.serviceCode!,cityId:a!.cityId,zoneId:a!.zoneId,serviceAddress:a!.text,servicePincode:a!.pincode,latitude:a!.latitude,longitude:a!.longitude,scheduledStart:new Date(start).toISOString(),scheduledEnd:new Date(end).toISOString(),providerSelection:r.providerSelection,action:'preview',saveAddress:false};
 if(r.preferredProviderId)payload.preferredProviderId=r.preferredProviderId;
 if(r.trainingQuoteId)payload.trainingQuoteId=r.trainingQuoteId;
 // Same helper used by canonical booking confirmation protects equivalent instant spellings.
 if(!sameInstant(payload.scheduledStart,r.scheduledStart)||!sameInstant(payload.scheduledEnd,r.scheduledEnd))return {status:'held',holds:['requested_window_required']};
 return {status:'ready',payload,origin:{leadId:b!.leadId,customerId:b!.customerId},requestKey:key,receipt:{eventKey:input.event.key,fingerprint:input.event.fingerprint,requestKey:key},duplicateReplay:Boolean(replay),reservationAllowed:false};
}
