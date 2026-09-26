import {meetGreetPrice,type MeetGreetFormat} from './meet-and-greet';
const DAY=86_400_000;
export function validStayDate(value:unknown){const text=String(value??'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return null;const ms=Date.parse(text+'T00:00:00Z');return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===text?text:null;}
/** Never grant a waiver from a browser-supplied day count. The stored intended dates decide it. */
export function intendedMeetingStayDays(start:unknown,end:unknown){const from=validStayDate(start),to=validStayDate(end);if(!from||!to||to<from)throw new Response('Valid intended check-in and check-out dates are required.',{status:400});return Math.round((Date.parse(to)-Date.parse(from))/DAY);}
export function stayMeetingPolicy(start:unknown,end:unknown){const days=intendedMeetingStayDays(start,end);return{version:'meet-greet-v1',intendedStayDays:days,phone:{...meetGreetPrice('phone',days),durationMinutes:10},house_visit:{...meetGreetPrice('house_visit',days),durationMinutes:240},paymentExecution:'separate_request_only',confirmationRequired:true};}
export function validateMeetingTime(format:MeetGreetFormat,preferredAt:number,start:string,now=Date.now()){
 if(!Number.isSafeInteger(preferredAt)||preferredAt<=now)throw new Response('Choose a future introduction time.',{status:400});
 const stayStart=Date.parse(start+'T00:00:00+05:30');if(preferredAt+(format==='phone'?10:240)*60_000>stayStart)throw new Response('The introduction must finish before the intended check-in date.',{status:409});
}
