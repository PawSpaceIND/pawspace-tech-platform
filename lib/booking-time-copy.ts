/**
 * Customer wording for the booking-time rules in lib/booking-time-policy.ts.
 *
 * The server refusal read "This service needs at least 1440 minutes' notice" (round-1 SIT-12, still on staging in
 * round 2), and a stay more than 180 days out was refused with a generic "We could not reserve this slot". The
 * server's refusal, the scheduling client's mapping of its code and the Boarding / Pet Sitting Plan step all say
 * these sentences, so a customer reads the rule the same way wherever it is checked. Browser-safe, no imports.
 */

/** A lead time as a person says it: 1440 -> "24 hours", 120 -> "2 hours", 60 -> "1 hour", 90 -> "90 minutes". */
export function noticePeriod(minutes:number){
  const whole=Math.max(0,Math.round(Number(minutes)||0));
  if(whole>=60&&whole%60===0){const hours=whole/60;return`${hours} ${hours===1?"hour":"hours"}`;}
  return`${whole} ${whole===1?"minute":"minutes"}`;
}

/** "Book at least 24 hours ahead." */
export function minimumNoticeMessage(minutes:number){
  return`Book at least ${noticePeriod(minutes)} ahead.`;
}

/** "You can book up to 180 days ahead." */
export function bookingHorizonMessage(days:number){
  const whole=Math.max(1,Math.round(Number(days)||0));
  return`You can book up to ${whole} ${whole===1?"day":"days"} ahead.`;
}
