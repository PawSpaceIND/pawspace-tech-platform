// Two guards the Training booking page must not get wrong, kept pure so they can be tested directly
// rather than asserted against page source. Both answer "may this booking proceed?" and both fail
// closed: an unknown answer is a refusal, never a guess.

/** Everything that changes a Training price. Two sets of selections with the same key are the same
 *  quote; anything else is a different quote and the old price is not spendable against it.
 *  Pet ids are sorted so that selecting Bruno then Pepper is the same key as Pepper then Bruno. */
export function trainingQuoteKey(input:{scheduledStart:string;packageCode:string;paymentMode:string;petIds:readonly string[]}):string{
 return [input.scheduledStart,input.packageCode,input.paymentMode,[...input.petIds].sort().join(",")].join("|");
}

/** A held quote is spendable only while it still corresponds to what is on screen.
 *  `quotedKey` is the key the held quote was PRICED for, captured when the response was applied —
 *  not recomputed at read time. That is what makes this safe against an out-of-order response: a
 *  slow earlier request carries its own (now superseded) key, so it can never look current. */
export function trainingQuoteSpendable(input:{hasQuote:boolean;quotedKey:string;currentKey:string}):boolean{
 return input.hasQuote&&input.quotedKey!==""&&input.quotedKey===input.currentKey;
}

export type TrainingLocationRefusal={ok:false;reason:string};

/** Which pincode to resolve the customer's training zone from, or why we refuse to book them.
 *  lib/service-zones.ts governs pincode→zone and contains Bengaluru zones ONLY, so a customer
 *  outside Bengaluru has no zone that could legitimately be chosen for them. */
export function trainingLocationPincode(account:{cityId:string;addresses:ReadonlyArray<{postalCode:string|null;isDefault:boolean}>}):{ok:true;pincode:string}|TrainingLocationRefusal{
 if(account.cityId!=="blr")return{ok:false,reason:"Dog Training is available in Bengaluru only. Your account is registered in another city, so no governed trainer zone applies to it."};
 const address=account.addresses.find(item=>item.isDefault)??account.addresses[0];
 const pincode=(address?.postalCode||"").replace(/\D/g,"");
 if(pincode.length!==6)return{ok:false,reason:"Add a Bengaluru address with a 6-digit PIN code in My PawSpace so your training zone can be confirmed."};
 return{ok:true,pincode};
}

/** The governed zone for that pincode, or why we refuse. `zone` is whatever /api/service-zone
 *  returned — null covers both "no mapping" and a failed lookup, and both refuse rather than
 *  falling back to a default zone. */
export function trainingLocationZone(zone:{zoneId:string;zoneName:string;serviceAvailable:boolean}|null,pincode:string):{ok:true;zoneId:string;zoneName:string}|TrainingLocationRefusal{
 if(!zone)return{ok:false,reason:`PIN code ${pincode} is not in a serviced Bengaluru training zone yet.`};
 if(!zone.serviceAvailable)return{ok:false,reason:`${zone.zoneName} is not open for Dog Training yet.`};
 return{ok:true,zoneId:zone.zoneId,zoneName:zone.zoneName};
}

/*
 * VALIDITY vs THE CALENDAR THE CUSTOMER IS SHOWN. [R3-A3]
 *
 * MEASURED: the Pro Training Plan card said "93 days validity", step 4 said "Validity starts from the
 * first service date", and the calendar under it then listed 16 weekly sessions from Sat 19 Sept to
 * Sat 2 Jan - a 105-day span. The server reserved all 16 without complaint, so sessions 15 and 16 were
 * paid for and scheduled AFTER the package they belong to had expired.
 *
 * Which of the two was wrong is answered by the catalogue's own ladder: 2 and 4 sessions get 31 days,
 * 8 get 62, 12 get 93 - one month, two months, three months. 16 sessions kept 93, the twelve-session
 * row's number, where the ladder gives four months. The validity was a copy-paste; the calendar was
 * telling the truth about how long sixteen weekly sessions take.
 *
 * These are pure so the screen, the seeded catalogue and the tests all measure it the same way. The
 * cadence stepping mirrors lib/training-session-preview.ts on purpose: the span this returns is the
 * span of the calendar the customer is actually shown.
 */

/** The slowest repeat schedule the app offers is once a week. */
export const TRAINING_SLOWEST_CADENCE_DAYS=7;

/** Days from session 1 to session N at the slowest cadence a customer can choose. */
export function trainingSlowestScheduleSpanDays(sessions:number):number{
 const count=Math.max(1,Math.floor(Number(sessions)||1));
 return (count-1)*TRAINING_SLOWEST_CADENCE_DAYS;
}

/**
 * Can this package's own validity hold its own sessions? A package that cannot is unsellable as
 * described: whatever cadence the customer picks, the last sessions fall outside the validity the
 * card promised.
 */
export function trainingPackageValidityCoversSessions(input:{sessions:number;validityDays:number}):boolean{
 return Number(input.validityDays)>=trainingSlowestScheduleSpanDays(input.sessions);
}

/** Days from session 1 to session N for a concrete weekday cadence, counted the way the preview counts. */
export function trainingScheduleSpanDays(input:{weekdays:readonly number[];sessions:number;startWeekday:number}):number{
 const count=Math.max(1,Math.floor(Number(input.sessions)||1));
 const days=input.weekdays&&input.weekdays.length?[...input.weekdays]:[0,1,2,3,4,5,6];
 let found=1,offset=0;
 const limit=Math.max(40,count*8);
 while(found<count&&offset<limit){offset+=1;if(days.includes((Number(input.startWeekday)+offset)%7))found+=1;}
 return found<count?Number.POSITIVE_INFINITY:offset;
}

export type TrainingValidityVerdict={ok:boolean;spanDays:number;validityDays:number;overrunDays:number};

/** Whether a concrete chosen schedule finishes inside the package validity it was sold under. */
export function trainingScheduleWithinValidity(input:{weekdays:readonly number[];sessions:number;startWeekday:number;validityDays:number}):TrainingValidityVerdict{
 const spanDays=trainingScheduleSpanDays(input),validityDays=Number(input.validityDays)||0;
 return{ok:Number.isFinite(spanDays)&&spanDays<=validityDays,spanDays,validityDays,overrunDays:Number.isFinite(spanDays)?Math.max(0,spanDays-validityDays):Number.POSITIVE_INFINITY};
}
