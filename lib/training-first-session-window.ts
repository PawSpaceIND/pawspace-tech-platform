/** New rolling Training bookings only. Two complete local calendar days separate booking day and session day. */
export const TRAINING_FIRST_SESSION_RULE = Object.freeze({fullPreparationDays:2,firstStartHour:8,lastStartHour:20,timeZone:'Asia/Kolkata'});

function localParts(instant:number,timeZone:string){
 const values=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
 return{year:values.year,month:values.month,day:values.day,hour:values.hour,minute:values.minute,second:values.second};
}
export function trainingFirstSessionDecision(scheduledStart:string,options:{now?:number;timeZone?:string;fullPreparationDays?:number;firstStartHour?:number;lastStartHour?:number}={}){
 const policy={...TRAINING_FIRST_SESSION_RULE,...options},start=Date.parse(scheduledStart),now=policy.now??Date.now(),fraction=scheduledStart.match(/T\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1]||'';
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(scheduledStart)||!Number.isFinite(start)||start<=now)return{ok:false,reason:'Choose a future first-session time with a timezone.'};
 if(!Number.isInteger(policy.fullPreparationDays)||policy.fullPreparationDays<0||!Number.isInteger(policy.firstStartHour)||!Number.isInteger(policy.lastStartHour)||policy.firstStartHour<0||policy.lastStartHour>23||policy.firstStartHour>policy.lastStartHour)throw new Error('Invalid Training first-session policy');
 const a=localParts(now,policy.timeZone),b=localParts(start,policy.timeZone),day=(v:typeof a)=>Date.UTC(v.year,v.month-1,v.day)/86_400_000,days=day(b)-day(a);
 if(days<policy.fullPreparationDays+1)return{ok:false,reason:`Choose a first session after ${policy.fullPreparationDays} full preparation days.`};
 if(b.hour<policy.firstStartHour||b.hour>policy.lastStartHour||b.minute!==0||b.second!==0||start%1000!==0||/[^0]/.test(fraction))return{ok:false,reason:`Choose a whole-hour first-session start from ${String(policy.firstStartHour).padStart(2,'0')}:00 through ${String(policy.lastStartHour).padStart(2,'0')}:00.`};
 return{ok:true,reason:null};
}
