/**
 * What the Boarding and Pet Sitting Plan step checks before it searches for hosts or sitters or asks for a price.
 *
 * Round-2 staging: a stay starting in ~20 hours, a stay 185 days out and a pet without verified vaccination were all
 * given hosts, a price, a Care Card and a Review, and were refused only at the final "Create stay request" click
 * ("This service needs more notice than that", "We could not reserve this slot", "Boarding requires verified
 * vaccination for every selected pet"). The server keeps refusing them (lib/booking-time-policy.ts at the
 * reservation, lib/boarding-governance.ts at the booking); these are the same rules checked first, in the browser,
 * so the customer reads them on the Plan step. Browser-safe.
 */
import {bookingHorizonMessage,minimumNoticeMessage} from "./booking-time-copy";
import {indiaDateOffset} from "./customer-booking-safety";

/** lib/booking-time-policy.ts APPROVED_BOOKING_TIME_BY_SERVICE: Boarding and Pet Sitting need 24 hours' notice. */
export const STAY_MINIMUM_NOTICE_MINUTES=24*60;
/** lib/booking-time-policy.ts APPROVED_BOOKING_TIME_DEFAULT: bookings open up to 180 days ahead. */
export const STAY_BOOKING_HORIZON_DAYS=180;
const MINUTE=60_000,DAY=86_400_000;

export type StayPlanProblem={code:"below_minimum_lead_time"|"beyond_booking_horizon"|"vaccination_required";message:string};

/** The sentence the Plan step always shows beside the dates. */
export function stayBookingWindowRule(){
 return`${minimumNoticeMessage(STAY_MINIMUM_NOTICE_MINUTES)} ${bookingHorizonMessage(STAY_BOOKING_HORIZON_DAYS)}`;
}

/** The check-in date picker's range, as IST calendar dates: the first day 24 hours' notice allows, to the horizon. */
export function stayDateBounds(now=Date.now()){
 return{min:indiaDateOffset(0,now+STAY_MINIMUM_NOTICE_MINUTES*MINUTE),max:indiaDateOffset(STAY_BOOKING_HORIZON_DAYS,now)};
}

/** The start the customer chose, measured the way the reservation measures it (server time is still the authority). */
export function stayWindowProblem(scheduledStart:Date|number,now=Date.now()):StayPlanProblem|null{
 const start=scheduledStart instanceof Date?scheduledStart.getTime():Number(scheduledStart);
 if(!Number.isFinite(start))return null;
 if(start-now<STAY_MINIMUM_NOTICE_MINUTES*MINUTE)return{code:"below_minimum_lead_time",message:minimumNoticeMessage(STAY_MINIMUM_NOTICE_MINUTES)};
 if(start>now+STAY_BOOKING_HORIZON_DAYS*DAY)return{code:"beyond_booking_horizon",message:bookingHorizonMessage(STAY_BOOKING_HORIZON_DAYS)};
 return null;
}

/** The same check at the moment of a click (the Plan step's clock refreshes once a minute), with the time it used. */
export function stayWindowCheckNow(scheduledStart:Date|number){
 const now=Date.now();
 return{now,problem:stayWindowProblem(scheduledStart,now)};
}

/** Boarding takes only pets whose vaccination PawSpace has verified (lib/boarding-governance.ts refuses the rest). */
export function boardingPetReady(pet:{vaccinationStatus?:string|null}){return pet.vaccinationStatus==="verified";}

/** The note under a pet on the Boarding Plan step when Boarding cannot take it yet. */
export function boardingPetNote(pet:{vaccinationStatus?:string|null}){
 return boardingPetReady(pet)?null:pet.vaccinationStatus==="pending"?"Vaccination record pending - Boarding needs it verified":"Vaccination not verified - Boarding needs it";
}

export function boardingVaccinationProblem(pets:Array<{name:string;vaccinationStatus?:string|null}>):StayPlanProblem|null{
 const names=pets.filter(pet=>!boardingPetReady(pet)).map(pet=>pet.name);
 if(!names.length)return null;
 const who=names.length===1?names[0]:`${names.slice(0,-1).join(", ")} and ${names[names.length-1]}`;
 return{code:"vaccination_required",message:`Boarding needs verified vaccination for every pet. ${who} ${names.length===1?"isn't":"aren't"} verified yet - add the vaccination record in the pet details, or choose another pet.`};
}
