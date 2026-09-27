import{INDIA_TIME_ZONE}from"./india-time";
import{governedJsonError}from"./governed-http-error";
type Row=Record<string,unknown>;
export function realCalendarDate(value:string){const ts=Date.parse(`${value}T00:00:00Z`);return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(ts)&&new Date(ts).toISOString().slice(0,10)===value;}
export function employeeWorkDate(timestamp:number,timezone=INDIA_TIME_ZONE,shiftEnd?:string|null,overnight=false,eventType="check_in"){
 const parts=new Intl.DateTimeFormat("en-GB",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(timestamp);
 const get=(name:string)=>parts.find(p=>p.type===name)?.value||"";
 let date=`${get("year")}-${get("month")}-${get("day")}`;
 const time=`${get("hour")}:${get("minute")}:${get("second")}`,end=`${shiftEnd||"00:00"}:00`;
 if(overnight&&(time<end||(time===end&&eventType==="check_out")))date=new Date(Date.parse(`${date}T00:00:00Z`)-86400000).toISOString().slice(0,10);
 return date;
}
export async function employeeAttendanceCalendar(db:D1Database,employeeId:string,at:number){
 const shift=await db.prepare("SELECT p.* FROM employee_shift_assignments a JOIN shift_policies p ON p.id=a.shift_policy_id WHERE a.employee_id=? AND a.effective_from<=? AND (a.effective_until IS NULL OR a.effective_until>=?) ORDER BY a.effective_from DESC LIMIT 1").bind(employeeId,at,at).first<Row>();
 const timezone=String(shift?.timezone||INDIA_TIME_ZONE),start=String(shift?.start_time||""),end=String(shift?.end_time||"");
 const overnight=/^([01]\d|2[0-3]):[0-5]\d$/.test(start)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(end)&&end<start;
 try{employeeWorkDate(at,timezone);}catch{throw governedJsonError({error:"Valid employee shift timezone is required"},409);}
 return{shift,timezone,workDate:(timestamp:number,eventType:string)=>employeeWorkDate(timestamp,timezone,end,overnight,eventType)};
}
