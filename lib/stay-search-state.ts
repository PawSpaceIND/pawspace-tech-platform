/** Scope availability to the exact location, stay and pet selection that produced it. */
export function staySearchKey(input:{cityId?:string;zoneId?:string;location?:string;start:string;end:string;careWindow:string;startTime?:string;petIds:string[];species:string[]}){
 return JSON.stringify([input.cityId||"",input.zoneId||"",input.location||"",input.start,input.end,input.careWindow,input.careWindow==="24 hours"?"09:00":input.startTime||"09:00",[...input.petIds].sort(),[...input.species].sort()]);
}
export function canPlanStay(input:{datesValid:boolean;petCount:number;serviceAvailable?:boolean}){
 return input.datesValid&&input.petCount>0&&input.serviceAvailable===true;
}
export function currentBoardingHost<T extends {providerId?:string;availabilityVerified?:boolean}>(hosts:T[],selectedId:string|undefined,loadedKey:string,currentKey:string):T|undefined{
 if(loadedKey!==currentKey||!selectedId)return undefined;
 return hosts.find(host=>host.providerId===selectedId&&host.availabilityVerified===true);
}

/** Customer time is IST; overnight stays retain the existing 9 am check-in/out window. */
export function careWindowDates(start:string,end:string,window:"4 hours"|"10 hours"|"12 hours"|"24 hours",startTime="09:00"){
 const time=window==="24 hours"?"09:00":startTime;
 const scheduledStart=new Date(`${start}T${time}:00+05:30`);
 const scheduledEnd=window==="24 hours"?new Date(`${end}T09:00:00+05:30`):new Date(scheduledStart.getTime()+(window==="10 hours"?10:window==="12 hours"?12:4)*3_600_000);
 return{scheduledStart,scheduledEnd};
}
