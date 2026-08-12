/**
 * The live company leaderboard - one board that ranks everyone who earns on PawSpace, refreshed on load.
 * Three sections, each computed independently and cold-DB safe (a missing table yields an empty section,
 * never an error):
 *   - employees:  operational performance ranked across ALL teams from the latest productivity fact run
 *   - groomers:   head-groomer month achievement (%) vs target, with winner bonuses, from the grooming engine
 *   - trainers:   monthly training incentive (revenue + Meet&Greet conversions + reviews), from the trainer engine
 * Ranking here is an operational sort for recognition ("like Indeed" peer visibility) - it is NOT payroll,
 * incentive-approval, or disciplinary authority. Those stay in their governed modules.
 */
import{rankGroomersForMonth}from"./grooming-incentive-engine";
import{computeTrainerMonthlyIncentive}from"./trainer-incentive-engine";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v||0);
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;

/** First day of the month for a timestamp, as YYYY-MM-01 (UTC). */
function monthStartOf(ms:number){const d=new Date(ms);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-01`;}

/** Operational employee ranking across every team in the latest productivity fact run. */
async function employeeBoard(db:Db,metric:string):Promise<Row[]>{
 try{
  const latest=await db.prepare("SELECT id FROM sales_productivity_fact_runs ORDER BY generated_at DESC LIMIT 1").first<Row>();
  if(!latest)return[];
  const facts=await db.prepare("SELECT f.*,u.name employee_name FROM sales_productivity_facts f LEFT JOIN app_users u ON u.email=f.employee_email WHERE f.run_id=?").bind(latest.id).all<Row>();
  const rows=facts.results.map(r=>{const clocks=num(r.first_response_clocks),met=num(r.first_response_met);const firstResponseRate=clocks?Number((met/clocks*100).toFixed(1)):null;const m:Record<string,number>={net_collected_revenue:num(r.net_collected_revenue),booking_conversions:num(r.booking_conversions),qualified_leads:num(r.qualified_leads),meaningful_actions:num(r.meaningful_actions),first_response_rate:firstResponseRate??-1};
   return{email:text(r.employee_email),name:text(r.employee_name)||text(r.employee_email),team:text(r.team_code),netCollectedRevenue:num(r.net_collected_revenue),bookingConversions:num(r.booking_conversions),qualifiedLeads:num(r.qualified_leads),firstResponseRate,rankValue:m[metric]??num(r.net_collected_revenue)};});
  rows.sort((a,b)=>b.rankValue-a.rankValue||b.bookingConversions-a.bookingConversions||b.netCollectedRevenue-a.netCollectedRevenue||a.email.localeCompare(b.email));
  return rows.map((r,i)=>({...r,rank:i+1}));
 }catch{return[];}
}

/** Head-groomer month achievement ranking with winner bonuses. */
async function groomerBoard(db:Db,monthStart:string):Promise<Row[]>{
 try{
  const heads=await db.prepare("SELECT DISTINCT head_groomer_id FROM groomer_incentive_brackets").all<Row>();
  const ids=heads.results.map(r=>text(r.head_groomer_id)).filter(Boolean);
  if(!ids.length)return[];
  const ranked=await rankGroomersForMonth(db,{monthStart,headGroomerIds:ids,actorId:"system:leaderboard"});
  return ranked.map(g=>({headGroomerId:g.headGroomerId,bracket:g.bracket,monthTotal:money(g.monthTotal),targetAmount:money(g.targetAmount),achievementPercent:num(g.achievementPercent),rank:g.rank,winnerHeadBonus:money(g.winnerHeadBonus),winnerHelperBonus:money(g.winnerHelperBonus)}));
 }catch{return[];}
}

/** Trainer monthly incentive ranking (revenue + Meet&Greet conversions + reviews). */
async function trainerBoard(db:Db,monthStart:string):Promise<Row[]>{
 try{
  const ids=new Set<string>();
  const a=await db.prepare("SELECT DISTINCT trainer_id id FROM trainer_meet_greet_conversions").all<Row>().catch(()=>({results:[] as Row[]}));
  for(const r of a.results)if(text(r.id))ids.add(text(r.id));
  const b=await db.prepare("SELECT DISTINCT provider_id id FROM canonical_bookings WHERE service_code='dog_training' AND status='completed'").all<Row>().catch(()=>({results:[] as Row[]}));
  for(const r of b.results)if(text(r.id))ids.add(text(r.id));
  if(!ids.size)return[];
  const computed=await Promise.all([...ids].map(id=>computeTrainerMonthlyIncentive(db,{trainerId:id,monthStart,actorId:"system:leaderboard"}).catch(()=>null)));
  const rows=computed.filter((c):c is NonNullable<typeof c>=>!!c).map(c=>({trainerId:c.trainerId,orderValue:money(c.orderValue),meetGreetConversions:c.meetGreetConversionCount,revenueIncentive:money(c.revenueIncentive),meetGreetIncentive:money(c.meetGreetIncentive),reviewIncentive:money(c.reviewIncentive),total:money(c.total)}));
  rows.sort((x,y)=>y.total-x.total||y.orderValue-x.orderValue||x.trainerId.localeCompare(y.trainerId));
  return rows.map((r,i)=>({...r,rank:i+1}));
 }catch{return[];}
}

/** The full live leaderboard. metric selects the employee ranking dimension; monthStart overridable for tests. */
export async function liveLeaderboard(db:Db,input:{metric?:string|null;monthStart?:string|null;asOf?:number|null}={}){
 const allowed=new Set(["net_collected_revenue","booking_conversions","qualified_leads","meaningful_actions","first_response_rate"]);
 const metric=allowed.has(text(input.metric))?text(input.metric):"net_collected_revenue";
 const asOf=Number(input.asOf)||Date.now();
 const monthStart=/^\d{4}-\d{2}-01$/.test(text(input.monthStart))?text(input.monthStart):monthStartOf(asOf);
 const[employees,groomers,trainers]=await Promise.all([employeeBoard(db,metric),groomerBoard(db,monthStart),trainerBoard(db,monthStart)]);
 return{
  asOf,monthStart,metric,
  employees,groomers,trainers,
  counts:{employees:employees.length,groomers:groomers.length,trainers:trainers.length},
  truth:{rankingType:"operational_recognition_sort",compositeScore:false,payrollAuthority:false,disciplinaryAuthority:false,liveRefreshRecommendedSeconds:60,productionReady:false},
 };
}
