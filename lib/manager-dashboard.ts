import { ensurePeopleTables } from "./people-foundation";
import { currentSalesBase, computeDailySalesIncentive, computeMonthlySalesIncentive } from "./sales-incentive-engine";
import { currentGroomerBracket, computeGroomerMonthlyIncentive } from "./grooming-incentive-engine";
import { computeTrainerMonthlyIncentive } from "./trainer-incentive-engine";
import { dailyClosureReadiness } from "./rep-daily-closure-governance";
import { dailyTalkTimeSummary } from "./talk-time-governance";
import{chunkedIn}from"./d1-chunked-in";
import{salesIncentivePeriodTruth}from"./daily-incentive-accrual";

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

/**
 * Who is in the dashboard's scope - and why this is a LEFT JOIN.
 *
 * It was an INNER JOIN on an OPEN employment version, which silently deleted every active employee
 * who has no open version row. Measured on the real database: 44 active employees, 4 with an open
 * employment version, so a founder opening "Scope: Everyone" was shown "Employees in view 4" beside
 * the claim of "a real, complete company view ... everyone across every vertical", while
 * /team/people/reports read "Active headcount 44" for the same persona at the same moment.
 *
 * The 44 is right and the 4 was wrong. `employees.employment_status='active'` is the canonical
 * in-scope predicate everywhere else that pays or counts these people:
 *   lib/payroll-engine.ts calculatePayroll  - SELECT ... FROM employees WHERE employment_status='active'
 *                                             (a real run produced 44 results; all 44 got paid)
 *   lib/people-reports.ts                   - LEFT JOIN employee_employment_versions
 *   lib/people-foundation.ts peopleDirectory- LEFT JOIN employee_employment_versions
 * An employment version is a versioned ATTRIBUTE record (title, team, manager, cost centre), not an
 * existence gate: employment_status lives on `employees`, and nothing about being paid depends on
 * holding an open version row. Requiring one made the dashboard the only People surface that
 * disagreed with payroll about who works here, and it disagreed silently.
 *
 * The MANAGER branch keeps its meaning. `resolveDashboardScope` resolves direct reports through
 * `v.manager_employee_id` on an open version, so that relationship genuinely requires one and that
 * join stays an inner join (exactly as lib/people-reports.ts resolves the same scope). The join
 * below is relaxed only so the second read cannot drop a report the first read already admitted.
 *
 * The 40 missing versions are ALSO a real data problem, and silence about it is what turned this
 * into a wrong number rather than a visible gap: with no open version an employee has no title and
 * no team_code, so classifyEmployee cannot place them in a vertical and they land in "other". The
 * dashboard therefore counts them AND names the gap (employmentVersionGap below) instead of
 * choosing between an honest short count and a dishonest complete one.
 */
async function employeesInScope(db:Db,scope:Scope){
  if(scope.mode==="all"){
    const rows=await db.prepare("SELECT e.id,e.work_email,e.user_email,e.display_name,v.title,v.team_code FROM employees e LEFT JOIN employee_employment_versions v ON v.employee_id=e.id AND v.effective_until IS NULL WHERE e.employment_status='active' ORDER BY e.display_name").all<Row>();
    return rows.results;
  }
  if(!scope.employeeEmails.length)return[];
  return chunkedIn(scope.employeeEmails,async(chunk,placeholders)=>(await db.prepare(`SELECT e.id,e.work_email,e.user_email,e.display_name,v.title,v.team_code FROM employees e LEFT JOIN employee_employment_versions v ON v.employee_id=e.id AND v.effective_until IS NULL WHERE lower(COALESCE(e.user_email,e.work_email)) IN (${placeholders}) ORDER BY e.display_name`).bind(...chunk).all<Row>()).results);

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


async function tableExists(db:Db,name:string){const row=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();return Boolean(row);}

async function managerOperationsSnapshot(db:Db,scope:Scope,asOf:number){
  const result={openCases:0,criticalCases:0,unownedCases:0,firstResponseOverdue:0,resolutionOverdue:0,managerEscalationsDue:0,refundsPending:0,refundsFailed:0,workQueueOpen:0,sopPending:0,legacyTicketsOpen:0};
  if(await tableExists(db,"unified_cases")){
    let rows:Row[]=[];
    if(scope.mode==="all") rows=(await db.prepare("SELECT status,severity,owner_email,first_responded_at,first_response_due_at,resolution_due_at,manager_escalation_due_at FROM unified_cases WHERE status NOT IN ('resolved','closed')").all<Row>()).results;
    else if(scope.employeeEmails.length){rows=await chunkedIn(scope.employeeEmails,async(chunk,placeholders)=>(await db.prepare(`SELECT status,severity,owner_email,first_responded_at,first_response_due_at,resolution_due_at,manager_escalation_due_at FROM unified_cases WHERE status NOT IN ('resolved','closed') AND lower(COALESCE(owner_email,'')) IN (${placeholders})`).bind(...chunk).all<Row>()).results);}
    result.openCases=rows.length;result.criticalCases=rows.filter(r=>text(r.severity)==="critical").length;result.unownedCases=scope.mode==="all"?rows.filter(r=>!text(r.owner_email)).length:0;result.firstResponseOverdue=rows.filter(r=>!r.first_responded_at&&r.first_response_due_at!=null&&Number(r.first_response_due_at)<=asOf).length;result.resolutionOverdue=rows.filter(r=>r.resolution_due_at!=null&&Number(r.resolution_due_at)<=asOf).length;result.managerEscalationsDue=rows.filter(r=>r.manager_escalation_due_at!=null&&Number(r.manager_escalation_due_at)<=asOf).length;
  }
  if(scope.mode==="all"&&await tableExists(db,"booking_refund_cases")){const row=await db.prepare("SELECT SUM(CASE WHEN status IN ('requested','approved','processing') THEN 1 ELSE 0 END) pending,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed FROM booking_refund_cases").first<Row>();result.refundsPending=Number(row?.pending||0);result.refundsFailed=Number(row?.failed||0);}
  if(scope.mode==="all"&&await tableExists(db,"ops_work_queue_tasks")){const row=await db.prepare("SELECT COUNT(*) count FROM ops_work_queue_tasks WHERE status IN ('open','acknowledged','in_progress')").first<Row>();result.workQueueOpen=Number(row?.count||0);}
  if(scope.mode==="all"&&await tableExists(db,"unified_case_sop_requirements")){const row=await db.prepare("SELECT COUNT(*) count FROM unified_case_sop_requirements WHERE status='pending'").first<Row>();result.sopPending=Number(row?.count||0);}
  if(scope.mode==="all"&&await tableExists(db,"customer_experience_tickets")){const row=await db.prepare("SELECT COUNT(*) count FROM customer_experience_tickets WHERE status NOT IN ('resolved','closed')").first<Row>();result.legacyTicketsOpen=Number(row?.count||0);}
  return result;
}

function monthStartOf(date:string){return `${date.slice(0,7)}-01`;}
function daysAgo(date:string,n:number){const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-n);return d.toISOString().slice(0,10);}

async function salesRow(db:Db,email:string,name:string,today:string,actorId:string){
  const daily=await computeDailySalesIncentive(db,{employeeId:email,date:today,actorId}).catch(()=>null);
  const monthStart=monthStartOf(today),monthly=await computeMonthlySalesIncentive(db,{employeeId:email,monthStart,actorId}).catch(()=>null),incentiveTruth=await salesIncentivePeriodTruth(db,{employeeId:email,monthStart}).catch(()=>null);
  let weeklyValue=0,weeklyComplete=true;for(let i=0;i<7;i++){const d=await computeDailySalesIncentive(db,{employeeId:email,date:daysAgo(today,i),actorId}).catch(()=>null);if(d)weeklyValue+=d.achievedValue;else weeklyComplete=false;}
  const closure=await dailyClosureReadiness(db,{repEmail:email,closureDate:today}).catch(()=>null);
  const talkTime=await dailyTalkTimeSummary(db,{repEmail:email,callDate:today}).catch(()=>null);
  return{
    employeeEmail:email,name,vertical:"sales",
    daily:daily?{achievedValue:daily.achievedValue,tierTarget:daily.tierTarget,incentive:daily.incentive}:null,
    weekly:weeklyComplete?{achievedValue:money(weeklyValue)}:null,
    unavailableMetrics:[...(!daily?["daily"]:[]),...(!weeklyComplete?["weekly"]:[]),...(!monthly?["monthly"]:[]),...(!closure?["day closure"]:[]),...(!talkTime?["talk time"]:[])],
    monthly:monthly?{achievedValue:monthly.achievedValue,tierTarget:monthly.tierTarget,incentive:monthly.incentive}:null,
    incentiveTruth,
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
  await ensurePeopleTables(db); // cold-DB safe: the dashboard reads employees/employment versions before any people module has run
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
  const operations=await managerOperationsSnapshot(db,scope,asOf);
  /* The scope is now every active employee (see employeesInScope). The ones with no OPEN employment
   * version carry no title and no team_code, so they cannot be classified into a vertical and land
   * in "other" - that is a real gap in the employment record, and it is named here rather than
   * hidden by dropping those people from the count the way the inner join used to. */
  const missingEmploymentVersion=employees.filter(row=>!text(row.team_code)&&!text(row.title));
  const employmentVersionGap={
    employeesWithoutOpenEmploymentVersion:missingEmploymentVersion.length,
    employeeIds:missingEmploymentVersion.map(row=>text(row.id)).filter(Boolean),
    effect:missingEmploymentVersion.length?"These active employees have no open employee_employment_versions row, so they have no title, team or manager on record. They are counted in scope and payroll pays them, but they cannot be classified into a vertical and appear under 'other' until their employment version is recorded.":"Every employee in scope has an open employment version.",
  };
  return{
    asOf,today,scope:scope.mode,employeeCount:employees.length,operations,
    verticals:{sales,groomers,trainers,other},
    classificationBasis,employmentVersionGap,
    /* app/team/people/manager-dashboard/page.tsx renders `note` verbatim under the header that
     * claims "a real, complete company view". The employment-version gap therefore has to reach
     * that sentence, not only the structured field above, or the screen would still be silent
     * about the people whose vertical it cannot determine. */
    note:`Sales and Groomer classification comes from a real governed registry (their configured base vertical / bracket). Trainer classification falls back to matching 'trainer' in their real job title or team code, since no dedicated trainer registry exists yet - flagged in classificationBasis as title_heuristic rather than presented with equal confidence.${missingEmploymentVersion.length?` Scope is every active employee: ${missingEmploymentVersion.length} of the ${employees.length} shown have no open employment version, so they carry no title or team and cannot be classified into a vertical - they are listed under 'other' until their employment record is completed.`:""}`,
    scopeNote:"Scope is every ACTIVE employee, the same population lib/payroll-engine.ts pays and lib/people-reports.ts counts as active headcount. An open employment version is a versioned attribute record (title/team/manager), not a condition of being in scope; employees missing one are counted here and reported in employmentVersionGap.",
  };
}
