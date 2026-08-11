import { dailyTalkTimeSummary } from "./talk-time-governance";

type Db=D1Database;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

/**
 * The real rep daily-closure gate: every lead currently assigned to them must have a real touch
 * (a logged call/WhatsApp attempt) today, and they must have logged at least the required real
 * talk time for the day, before their day can be marked closed. This is deliberately separate from
 * the existing Finance/Accounts day-closure feature (finance_day_closures) - that gates six unrelated
 * accounting checks, not an individual rep's daily activity.
 */
export async function ensureRepDailyClosureTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS rep_daily_closures (id TEXT PRIMARY KEY,rep_email TEXT NOT NULL,closure_date TEXT NOT NULL,leads_total INTEGER NOT NULL,leads_touched INTEGER NOT NULL,talk_time_minutes REAL NOT NULL,closed_at INTEGER NOT NULL,actor_id TEXT NOT NULL,UNIQUE(rep_email,closure_date))"),
]);}

export async function dailyClosureReadiness(db:Db,input:{repEmail:string;closureDate:string;talkTimeRequiredMinutes?:number}){
 await ensureRepDailyClosureTables(db);
 const talkTimeRequiredMinutes=input.talkTimeRequiredMinutes??210;
 const assignedLeads=await db.prepare("SELECT lead_id FROM lead_assignments WHERE employee_email=? AND status='current'").bind(input.repEmail).all<Row>();
 const leadIds=assignedLeads.results.map(r=>text(r.lead_id));
 const untouched:string[]=[];
 for(const leadId of leadIds){
   const touch=await db.prepare("SELECT 1 FROM lead_attempts WHERE lead_id=? AND created_by=? AND date(created_at/1000,'unixepoch')=? LIMIT 1").bind(leadId,input.repEmail,input.closureDate).first<Row>().catch(()=>null);
   if(!touch)untouched.push(leadId);
 }
 const talkTime=await dailyTalkTimeSummary(db,{repEmail:input.repEmail,callDate:input.closureDate});
 const talkTimeMet=talkTime.totalMinutes>=talkTimeRequiredMinutes;
 const allTouched=untouched.length===0;
 const reasons:string[]=[];
 if(!allTouched)reasons.push(`${untouched.length} of ${leadIds.length} assigned lead(s) have no logged activity today`);
 if(!talkTimeMet)reasons.push(`Talk time is ${talkTime.totalMinutes} of the required ${talkTimeRequiredMinutes} minutes`);
 return{
   repEmail:input.repEmail,closureDate:input.closureDate,
   leadsTotal:leadIds.length,leadsTouched:leadIds.length-untouched.length,untouchedLeadIds:untouched,
   talkTimeMinutes:talkTime.totalMinutes,talkTimeRequiredMinutes,talkTimeMet,
   readyToClose:allTouched&&talkTimeMet,reasons,
 };
}

export async function attemptDailyClosure(db:Db,input:{repEmail:string;closureDate:string;actorId:string;talkTimeRequiredMinutes?:number}){
 await ensureRepDailyClosureTables(db);
 const existing=await db.prepare("SELECT * FROM rep_daily_closures WHERE rep_email=? AND closure_date=?").bind(input.repEmail,input.closureDate).first<Row>();
 if(existing)return{repEmail:input.repEmail,closureDate:input.closureDate,alreadyClosed:true};
 const readiness=await dailyClosureReadiness(db,input);
 if(!readiness.readyToClose)throw new Error(`Day cannot be closed yet: ${readiness.reasons.join("; ")}`);
 const now=Date.now();
 await db.prepare("INSERT INTO rep_daily_closures (id,rep_email,closure_date,leads_total,leads_touched,talk_time_minutes,closed_at,actor_id) VALUES (?,?,?,?,?,?,?,?)")
   .bind(uid("RDC"),input.repEmail,input.closureDate,readiness.leadsTotal,readiness.leadsTouched,readiness.talkTimeMinutes,now,input.actorId).run();
 return{repEmail:input.repEmail,closureDate:input.closureDate,alreadyClosed:false,leadsTotal:readiness.leadsTotal,talkTimeMinutes:readiness.talkTimeMinutes};
}

/** Real reps who have current lead assignments but have NOT closed the given day - the list a manager escalation sweep acts on. */
export async function repsWithIncompleteClosure(db:Db,input:{closureDate:string}){
 await ensureRepDailyClosureTables(db);
 const reps=await db.prepare("SELECT DISTINCT employee_email,team_code FROM lead_assignments WHERE status='current'").all<Row>();
 const incomplete:Array<{repEmail:string;teamCode:string}>=[];
 for(const rep of reps.results){
   const email=text(rep.employee_email);
   const closed=await db.prepare("SELECT 1 FROM rep_daily_closures WHERE rep_email=? AND closure_date=?").bind(email,input.closureDate).first<Row>();
   if(!closed)incomplete.push({repEmail:email,teamCode:text(rep.team_code)});
 }
 return incomplete;
}
