/** Scope availability to the exact location, stay and pet selection that produced it. */
export function staySearchKey(input:{cityId?:string;zoneId?:string;location?:string;start:string;end:string;careWindow:string;petIds:string[];species:string[]}){
 return JSON.stringify([input.cityId||"",input.zoneId||"",input.location||"",input.start,input.end,input.careWindow,[...input.petIds].sort(),[...input.species].sort()]);
}
export function canPlanStay(input:{datesValid:boolean;petCount:number;serviceAvailable?:boolean}){
 return input.datesValid&&input.petCount>0&&input.serviceAvailable===true;
}
export function currentBoardingHost<T extends {providerId?:string;availabilityVerified?:boolean}>(hosts:T[],selectedId:string|undefined,loadedKey:string,currentKey:string):T|undefined{
 if(loadedKey!==currentKey||!selectedId)return undefined;
 return hosts.find(host=>host.providerId===selectedId&&host.availabilityVerified===true);
}
