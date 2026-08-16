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
