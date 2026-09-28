const DAY_MS=86_400_000,IST_OFFSET_MS=19_800_000;
/** Bangalore service days are IST even when the Worker runs in UTC. */
export function partnerServiceDay(now:number){
 const start=Math.floor((now+IST_OFFSET_MS)/DAY_MS)*DAY_MS-IST_OFFSET_MS;
 return{start,end:start+DAY_MS};
}
export function partnerServiceTime(value:string){
 const time=new Date(value);
 if(!value||!Number.isFinite(time.getTime()))return "Not scheduled";
 return new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'}).format(time)+' IST';
}
