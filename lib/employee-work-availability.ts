type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
/** Shared HR eligibility for staff lead routing. Existing staff-only identities are preserved;
 * once an employee record exists, inactive employment and approved leave must be respected. */
export async function employeeWorkAvailability(db:D1Database,email:string,asOf:number){
 const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('employees','leave_requests','employee_shift_assignments','shift_policies')").all<Row>()).results;
 const has=new Set(tables.map(row=>text(row.name)));
 if(!has.has("employees"))return{available:true,reason:"staff_identity_only"};
 const employees=(await db.prepare("SELECT id,employment_status,joined_at,ended_at FROM employees WHERE lower(work_email)=? OR lower(user_email)=? LIMIT 2").bind(email.toLowerCase(),email.toLowerCase()).all<Row>()).results;
 if(!employees.length)return{available:true,reason:"staff_identity_only"};
 if(employees.length!==1)return{available:false,reason:"ambiguous_employee_link"};
 const employee=employees[0];
 if(!["active","contract_active"].includes(text(employee.employment_status))||(employee.joined_at!=null&&Number(employee.joined_at)>asOf)||(employee.ended_at!=null&&Number(employee.ended_at)<=asOf))return{available:false,reason:"employee_inactive"};
 let shift:Row|null=null;
 if(has.has("employee_shift_assignments")&&has.has("shift_policies"))shift=await db.prepare("SELECT p.* FROM employee_shift_assignments a JOIN shift_policies p ON p.id=a.shift_policy_id WHERE a.employee_id=? AND a.effective_from<=? AND (a.effective_until IS NULL OR a.effective_until>=?) AND p.effective_from<=? AND (p.effective_until IS NULL OR p.effective_until>=?) ORDER BY a.effective_from DESC LIMIT 1").bind(employee.id,asOf,asOf,asOf,asOf).first<Row>();
 const zone=text(shift?.timezone)||"Asia/Kolkata";
 let parts:Intl.DateTimeFormatPart[];
 try{parts=new Intl.DateTimeFormat("en-GB",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(asOf);}catch{return{available:false,reason:"invalid_shift_timezone"};}
 const part=(name:string)=>parts.find(p=>p.type===name)?.value||"";
 const date=`${part("year")}-${part("month")}-${part("day")}`;
 if(has.has("leave_requests")){
  const leave=await db.prepare("SELECT id FROM leave_requests WHERE employee_id=? AND status='approved' AND start_date<=? AND end_date>=? LIMIT 1").bind(employee.id,date,date).first<Row>();
  if(leave)return{available:false,reason:"approved_leave"};
 }
 if(!shift)return{available:true,reason:"no_employee_shift"};
 const minute=Number(part("hour"))*60+Number(part("minute"));
 const parseMinute=(v:unknown)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(text(v))?Number(text(v).slice(0,2))*60+Number(text(v).slice(3)):null;
 const start=parseMinute(shift.start_time),end=parseMinute(shift.end_time);
 if(start===null||end===null||start===end)return{available:false,reason:"shift_configuration_required"};
 const overnight=end<start;
 if(!(overnight?(minute>=start||minute<end):(minute>=start&&minute<end)))return{available:false,reason:"outside_employee_shift"};
 const weekdayNames=["sun","mon","tue","wed","thu","fri","sat"];
 const calendarDay=weekdayNames.indexOf(part("weekday").toLowerCase());
 const workday=overnight&&minute<end?(calendarDay+6)%7:calendarDay;
 let weeklyOff:unknown;
 try{weeklyOff=JSON.parse(text(shift.weekly_off_json)||"[]");}catch{return{available:false,reason:"invalid_shift_calendar"};}
 if(!Array.isArray(weeklyOff))return{available:false,reason:"invalid_shift_calendar"};
 if(weeklyOff.some(day=>text(day).toLowerCase()===String(workday)||text(day).toLowerCase().slice(0,3)===weekdayNames[workday]))return{available:false,reason:"weekly_off"};
 return{available:true,reason:"working_employee_shift"};
}
