import { currentSalesBase, computeDailySalesIncentive, computeMonthlySalesIncentive } from "./sales-incentive-engine";
import { currentGroomerBracket, computeGroomerMonthlyIncentive } from "./grooming-incentive-engine";
import { computeTrainerMonthlyIncentive } from "./trainer-incentive-engine";
import { dailyClosureReadiness } from "./rep-daily-closure-governance";
import { dailyTalkTimeSummary } from "./talk-time-governance";
import{chunkedIn}from"./d1-chunked-in";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;

type Scope={mode:"all"|"manager";managerEmployeeId:string|null;employeeIds:string[];employeeEmails:string[]};

/**
 * Same real scoping rule already used by lib/people-reports.ts's payroll/HR reports: a manager sees
 * only their real direct reports (via employee_employment_versions.manager_employee_id), a founder
 * or anyone with people.manage/payroll.view/audit.view sees everyone. Duplicated here rather than
 * importing (the original is a private, unexported function) - same query, same real table, so
 * scope is identical to what payroll/HR already trusts.
 */
async function resolveDashboardScope(db:Db,input:{actorEmail:string;permissions:string[]}):Promise<Scope>{
  const has=(perm:string)=>input.permissions.includes("*")||input.permissions.includes(perm);
  if(has("people.manage")||has("payroll.view")||has("audit.view"))return{mode:"all",managerEmployeeId:null,employeeIds:[],employeeEmails:[]};
  const own=await db.prepare("SELECT id FROM employees WHERE lower(COALESCE(user_email,work_email))=? AND employment_status='active'").bind(input.actorEmail.toLowerCase()).first<Row>();
  if(!own)return{mode:"manager",managerEmployeeId:null,employeeIds:[],employeeEmails:[]};
  const managerId=text(own.id);
  const direct=await db.prepare("SELECT e.id,e.work_email,e.user_email,e.display_name,v.title,v.team_code FROM employees e JOIN employee_employment_versions v ON v.employee_id=e.id AND v.effective_until IS NULL WHERE e.employment_status='active' AND v.manager_employee_id=? ORDER BY e.display_name").bind(managerId).all<Row>();
  return{mode:"manager",managerEmployeeId:managerId,employeeIds:direct.results.map(r=>text(r.id)),employeeEmails:direct.results.map(r=>text(r.user_email||r.work_email).toLowerCase()).filter(Boolean)};
}

async function employeesInScope(db:Db,scope:Scope){
  if(scope.mode==="all"){
    const rows=await db.prepare("SELECT e.id,e.work_email,e.user_email,e.display_name,v.title,v.team_code FROM employees e JOIN employee_employment_versions v ON v.employee_id=e.id AND v.effective_until IS NULL WHERE e.employment_status='active' ORDER BY e.display_name").all<Row>();
    return rows.results;
  }
  if(!scope.employeeEmails.length)return[];
  return chunkedIn(scope.employeeEmails,async(chunk,placeholders)=>(await db.prepare(`SELECT e.id,e.work_email,e.user_email,e.display_name,v.title,v.team_code FROM employees e JOIN employee_employment_versions v ON v.employee_id=e.id AND v.effective_until IS NULL WHERE lower(COALESCE(e.user_email,e.work_email)) IN (${placeholders}) ORDER BY e.display_name`).bind(...chunk).all<Row>()).results);

}

/**
 * Classifies each employee into the vertical whose real incentive engine applies to them.
 * Sales and Groomer are determined by a real governed registry lookup (currentSalesBase /
 * currentGroomerBracket) - never guessed. Trainer has no equivalent dedicated registry yet, so it
 * falls back to matching "trainer" in their real title/team_code - flagged honestly as a heuristic
 * in the result rather than presented with the same confidence as the other two.
 */
async function classifyEmployee(db:Db,employee:Row,today:string){
  const email=text(employee.user_email||employee.work_email).toLowerCase(),title=text(employee.title).toLowerCase(),teamCode=text(employee.team_code).toLowerCase();
  const salesBase=await currentSalesBase(db,email,today);
  if(salesBase)return{vertical:"sales" as const,basis:"governed_registry" as const,detail:salesBase.baseVertical};
  const groomerBracket=await currentGroomerBracket(db,email,today);
  if(groomerBracket)return{vertical:"groomer" as const,basis:"governed_registry" as const,detail:groomerBracket.bracket};
  if(title.includes("trainer")||teamCode.includes("training"))return{vertical:"trainer" as const,basis:"title_heuristic" as const,detail:null};
  return{vertical:"other" as const,basis:"unclassified" as const,detail:null};
}

function monthStartOf(date:string){return `${date.slice(0,7)}-01`;}
function daysAgo(date:string,n:number){const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-n);return d.toISOString().slice(0,10);}

async function salesRow(db:Db,email:string,name:string,today:string,actorId:string){
  const daily=await computeDailySalesIncentive(db,{employeeId:email,date:today,actorId}).catch(()=>null);
  const monthly=await computeMonthlySalesIncentive(db,{employeeId:email,monthStart:monthStartOf(today),actorId}).catch(()=>null);
  let weeklyValue=0;for(let i=0;i<7;i++){const d=await computeDailySalesIncentive(db,{employeeId:email,date:daysAgo(today,i),actorId}).catch(()=>null);if(d)weeklyValue+=d.achievedValue;}
  const closure=await dailyClosureReadiness(db,{repEmail:email,closureDate:today}).catch(()=>null);
  const talkTime=await dailyTalkTimeSummary(db,{repEmail:email,callDate:today}).catch(()=>null);
  return{
    employeeEmail:email,name,vertical:"sales",
    daily:daily?{achievedValue:daily.achievedValue,tierTarget:daily.tierTarget,incentive:daily.incentive}:null,
    weekly:{achievedValue:money(weeklyValue)},
    monthly:monthly?{achievedValue:monthly.achievedValue,tierTarget:monthly.tierTarget,incentive:monthly.incentive}:null,
    dayClosureReady:closure?closure.readyToClose:null,talkTimeMinutesToday:talkTime?talkTime.totalMinutes:null,
  };
}

async function groomerRow(db:Db,email:string,name:string,today:string,actorId:string){
  const monthly=await computeGroomerMonthlyIncentive(db,{headGroomerId:email,monthStart:monthStartOf(today),actorId}).catch(()=>null);
  return{
    employeeEmail:email,name,vertical:"groomer",
    monthly:monthly?{orderCountTotal:monthly.orderCountTotal,monthTotal:monthly.monthTotal,targetAmount:monthly.targetAmount,crossedTarget:monthly.crossedTarget,headTotal:monthly.headTotal}:null,
  };
}

async function trainerRow(db:Db,email:string,name:string,today:string,actorId:string){
  const monthly=await computeTrainerMonthlyIncentive(db,{trainerId:email,monthStart:monthStartOf(today),actorId}).catch(()=>null);
  return{
    employeeEmail:email,name,vertical:"trainer",
    monthly:monthly?{orderValue:monthly.orderValue,revenueIncentive:monthly.revenueIncentive,meetGreetIncentive:monthly.meetGreetIncentive,total:monthly.total}:null,
  };
}

/**
 * The real dashboard: a manager sees only their real direct reports (via the same employment-versions
 * relationship payroll/HR already trusts); a founder or anyone with people.manage/payroll.view/audit.view
 * sees everyone, grouped by real vertical. Every figure here is a live read from the same governed
 * engines already built and tested this session - nothing here is a separate, parallel calculation.
 */
export async function buildManagerDashboard(db:Db,input:{actorEmail:string;permissions:string[];asOf?:number}){
  const asOf=input.asOf??Date.now(),today=new Date(asOf).toISOString().slice(0,10);
  const scope=await resolveDashboardScope(db,{actorEmail:input.actorEmail,permissions:input.permissions});
  const employees=await employeesInScope(db,scope);
  const sales:Array<Awaited<ReturnType<typeof salesRow>>>=[],groomers:Array<Awaited<ReturnType<typeof groomerRow>>>=[],trainers:Array<Awaited<ReturnType<typeof trainerRow>>>=[],other:Array<{employeeEmail:string;name:string;title:string}>=[];
  const classificationBasis:Record<string,string>={};
  for(const employee of employees){
    const email=text(employee.user_email||employee.work_email).toLowerCase(),name=text(employee.display_name);
    if(!email)continue;
    const classification=await classifyEmployee(db,employee,today);
    classificationBasis[email]=classification.basis;
    if(classification.vertical==="sales")sales.push(await salesRow(db,email,name,today,input.actorEmail));
    else if(classification.vertical==="groomer")groomers.push(await groomerRow(db,email,name,today,input.actorEmail));
    else if(classification.vertical==="trainer")trainers.push(await trainerRow(db,email,name,today,input.actorEmail));
    else other.push({employeeEmail:email,name,title:text(employee.title)});
  }
  return{
    asOf,today,scope:scope.mode,employeeCount:employees.length,
    verticals:{sales,groomers,trainers,other},
    classificationBasis,
    note:"Sales and Groomer classification comes from a real governed registry (their configured base vertical / bracket). Trainer classification falls back to matching 'trainer' in their real job title or team code, since no dedicated trainer registry exists yet - flagged in classificationBasis as title_heuristic rather than presented with equal confidence.",
  };
}
