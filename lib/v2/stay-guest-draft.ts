import {indiaDateOffset} from '../customer-booking-safety';
import {rangeDays} from '../analytics-visuals';
export type StayGuestDraft={start:string;end:string;startTime:string;endTime:string;sittingCare:'visit'|'overnight'};
export function defaultStayGuestDraft():StayGuestDraft{return {start:indiaDateOffset(3),end:indiaDateOffset(10),startTime:'09:00',endTime:'09:00',sittingCare:'overnight'};}
/** Public care preferences only. Customer/pet/address/quote/payment identities never enter this draft. */
export function parseStayGuestDraft(input:unknown):StayGuestDraft|null{
 if(!input||typeof input!=='object')return null;const value=input as Record<string,unknown>;
 const {start,end,startTime,endTime,sittingCare}=value;
 if(typeof start!=='string'||typeof end!=='string'||typeof startTime!=='string'||typeof endTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)||!['visit','overnight'].includes(String(sittingCare)))return null;
 try{rangeDays({from:start,to:sittingCare==='visit'?start:end});}catch{return null;}
 return {start,end,startTime,endTime,sittingCare:sittingCare as 'visit'|'overnight'};
}
export const stayGuestStorageKey=(mode:'boarding'|'sitting')=>`pawspace_v2_stay_guest:${mode}`;
