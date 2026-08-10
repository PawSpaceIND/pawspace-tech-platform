type Db=D1Database;
type Row=Record<string,unknown>;

import { monthlyPetrolAllowance } from "./provider-daily-travel";
import { monthlySpecialIncentiveTotal } from "./employee-recognition-incentives";

const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export type GroomerBracket="team"|"single";

export async function ensureGroomingIncentiveTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS groomer_incentive_brackets (id TEXT PRIMARY KEY,head_groomer_id TEXT NOT NULL,bracket TEXT NOT NULL,helper_id TEXT,effective_from TEXT NOT NULL,effective_until TEXT,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_groomer_bracket_head ON groomer_incentive_brackets(head_groomer_id,effective_from)"),
 db.prepare("CREATE TABLE IF NOT EXISTS helper_daily_attendance (id TEXT PRIMARY KEY,helper_id TEXT NOT NULL,attendance_date TEXT NOT NULL,status TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL,UNIQUE(helper_id,attendance_date))"),
 db.prepare("CREATE TABLE IF NOT EXISTS groomer_monthly_targets (id TEXT PRIMARY KEY,head_groomer_id TEXT NOT NULL,month_start TEXT NOT NULL,target_amount REAL NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(head_groomer_id,month_start))"),
 db.prepare("CREATE TABLE IF NOT EXISTS groomer_offline_sub_sales (id TEXT PRIMARY KEY,head_groomer_id TEXT NOT NULL,sale_date TEXT NOT NULL,amount REAL NOT NULL,reason TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS groomer_gpay_ledger (id TEXT PRIMARY KEY,head_groomer_id TEXT NOT NULL,month_start TEXT NOT NULL,gpay_total REAL NOT NULL DEFAULT 0,gpay_pending REAL NOT NULL DEFAULT 0,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL,UNIQUE(head_groomer_id,month_start))"),
 db.prepare("CREATE TABLE IF NOT EXISTS groomer_special_incentives (id TEXT PRIMARY KEY,head_groomer_id TEXT NOT NULL,month_start TEXT NOT NULL,amount REAL NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS groomer_incentive_results (id TEXT PRIMARY KEY,head_groomer_id TEXT NOT NULL,month_start TEXT NOT NULL,bracket TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',result_json TEXT NOT NULL,finalized_by TEXT,finalized_at INTEGER,created_at INTEGER NOT NULL,UNIQUE(head_groomer_id,month_start))"),
]);}

export async function saveGroomerBracket(db:Db,input:{headGroomerId:string;bracket:GroomerBracket;helperId?:string|null;effectiveFrom:string;reason:string;actorId:string}){
 await ensureGroomingIncentiveTables(db);
 if(!text(input.headGroomerId))throw new Error("Head groomer is required");
 if(input.bracket!=="team"&&input.bracket!=="single")throw new Error("Bracket must be 'team' or 'single'");
 if(input.bracket==="team"&&!text(input.helperId||""))throw new Error("A team bracket requires a real helper");
 if(!/^\d{4}-\d{2}-01$/.test(input.effectiveFrom))throw new Error("effectiveFrom must be the first day of a month");
 if(input.reason.trim().length<8)throw new Error("A real reason is required to set or change a groomer's bracket");
 const now=Date.now();
 await db.prepare("UPDATE groomer_incentive_brackets SET effective_until=? WHERE head_groomer_id=? AND effective_until IS NULL").bind(input.effectiveFrom,input.headGroomerId).run();
 const id=uid("GIB");
 await db.prepare("INSERT INTO groomer_incentive_brackets (id,head_groomer_id,bracket,helper_id,effective_from,effective_until,reason,actor_id,created_at) VALUES (?,?,?,?,?,NULL,?,?,?)")
   .bind(id,input.headGroomerId,input.bracket,input.helperId||null,input.effectiveFrom,input.reason.trim(),input.actorId,now).run();
 return{id,headGroomerId:input.headGroomerId,bracket:input.bracket,helperId:input.helperId||null,effectiveFrom:input.effectiveFrom};
}

export async function currentGroomerBracket(db:Db,headGroomerId:string,atDate:string){
 await ensureGroomingIncentiveTables(db);
 const row=await db.prepare("SELECT * FROM groomer_incentive_brackets WHERE head_groomer_id=? AND effective_from<=? AND (effective_until IS NULL OR effective_until>?) ORDER BY effective_from DESC LIMIT 1")
   .bind(headGroomerId,atDate,atDate).first<Row>();
 if(!row)return null;
 return{id:String(row.id),headGroomerId:String(row.head_groomer_id),bracket:String(row.bracket) as GroomerBracket,helperId:row.helper_id?String(row.helper_id):null,effectiveFrom:String(row.effective_from)};
}

export async function recordHelperAttendance(db:Db,input:{helperId:string;attendanceDate:string;status:"present"|"absent";actorId:string}){
 await ensureGroomingIncentiveTables(db);
 if(!text(input.helperId)||!/^\d{4}-\d{2}-\d{2}$/.test(input.attendanceDate))throw new Error("Helper and a real date are required");
 const now=Date.now();
 await db.prepare("INSERT INTO helper_daily_attendance (id,helper_id,attendance_date,status,recorded_by,recorded_at) VALUES (?,?,?,?,?,?) ON CONFLICT(helper_id,attendance_date) DO UPDATE SET status=excluded.status,recorded_by=excluded.recorded_by,recorded_at=excluded.recorded_at")
   .bind(uid("HAT"),input.helperId,input.attendanceDate,input.status,input.actorId,now).run();
 return{helperId:input.helperId,attendanceDate:input.attendanceDate,status:input.status};
}

export async function saveGroomerMonthlyTarget(db:Db,input:{headGroomerId:string;monthStart:string;targetAmount:number;reason:string;actorId:string}){
 await ensureGroomingIncentiveTables(db);
 if(!/^\d{4}-\d{2}-01$/.test(input.monthStart))throw new Error("monthStart must be the first day of a month");
 if(!Number.isFinite(input.targetAmount)||input.targetAmount<=0)throw new Error("Target must be an explicit positive amount");
 if(input.reason.trim().length<8)throw new Error("A real reason is required to publish a target");
 const now=Date.now();
 await db.prepare("INSERT INTO groomer_monthly_targets (id,head_groomer_id,month_start,target_amount,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(head_groomer_id,month_start) DO UPDATE SET target_amount=excluded.target_amount,reason=excluded.reason,actor_id=excluded.actor_id,created_at=excluded.created_at")
   .bind(uid("GMT"),input.headGroomerId,input.monthStart,money(input.targetAmount),input.reason.trim(),input.actorId,now).run();
 return{headGroomerId:input.headGroomerId,monthStart:input.monthStart,targetAmount:money(input.targetAmount)};
}

export async function recordOfflineSubSale(db:Db,input:{headGroomerId:string;saleDate:string;amount:number;reason:string;actorId:string}){
 await ensureGroomingIncentiveTables(db);
 if(!text(input.headGroomerId)||!/^\d{4}-\d{2}-\d{2}$/.test(input.saleDate))throw new Error("Head groomer and a real date are required");
 if(!Number.isFinite(input.amount)||input.amount<=0)throw new Error("Sale amount must be an explicit positive number");
 const now=Date.now();
 await db.prepare("INSERT INTO groomer_offline_sub_sales (id,head_groomer_id,sale_date,amount,reason,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?)")
   .bind(uid("OSS"),input.headGroomerId,input.saleDate,money(input.amount),input.reason.trim()||"Offline subscription sold",input.actorId,now).run();
 return{headGroomerId:input.headGroomerId,saleDate:input.saleDate,amount:money(input.amount)};
}

export async function saveGroomerGpayLedger(db:Db,input:{headGroomerId:string;monthStart:string;gpayTotal:number;gpayPending:number;actorId:string}){
 await ensureGroomingIncentiveTables(db);
 if(!/^\d{4}-\d{2}-01$/.test(input.monthStart))throw new Error("monthStart must be the first day of a month");
 if(![input.gpayTotal,input.gpayPending].every(v=>Number.isFinite(v)&&v>=0))throw new Error("Gpay figures must be explicit non-negative numbers");
 const now=Date.now();
 await db.prepare("INSERT INTO groomer_gpay_ledger (id,head_groomer_id,month_start,gpay_total,gpay_pending,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(head_groomer_id,month_start) DO UPDATE SET gpay_total=excluded.gpay_total,gpay_pending=excluded.gpay_pending,recorded_by=excluded.recorded_by,recorded_at=excluded.recorded_at")
   .bind(uid("GGL"),input.headGroomerId,input.monthStart,money(input.gpayTotal),money(input.gpayPending),input.actorId,now).run();
 return{headGroomerId:input.headGroomerId,monthStart:input.monthStart,gpayTotal:money(input.gpayTotal),gpayPending:money(input.gpayPending),fine:gpayFineForPending(input.gpayPending)};
}

export async function recordSpecialIncentive(db:Db,input:{headGroomerId:string;monthStart:string;amount:number;reason:string;actorId:string}){
 await ensureGroomingIncentiveTables(db);
 if(!text(input.headGroomerId)||!/^\d{4}-\d{2}-01$/.test(input.monthStart))throw new Error("Head groomer and a real month are required");
 if(!Number.isFinite(input.amount)||input.amount<=0)throw new Error("Special incentive amount must be an explicit positive number");
 if(input.reason.trim().length<8)throw new Error("A real reason is required for a special incentive - never auto-applied");
 const now=Date.now();
 await db.prepare("INSERT INTO groomer_special_incentives (id,head_groomer_id,month_start,amount,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?)")
   .bind(uid("SPI"),input.headGroomerId,input.monthStart,money(input.amount),input.reason.trim(),input.actorId,now).run();
 return{headGroomerId:input.headGroomerId,monthStart:input.monthStart,amount:money(input.amount)};
}

function gpayFineForPending(pending:number){
 if(pending<5000)return 0;
 if(pending<=10000)return 500;
 if(pending<=15000)return 1250;
 if(pending<=20000)return 1750;
 return 2000;
}

function dailyOrderBonus(bracket:GroomerBracket,orderCountThatDay:number,orderValueThatDay:number){
 if(orderCountThatDay<4)return{headAmount:0,helperAmount:0,tier:null as null|4|5};
 const tier=orderCountThatDay===4?4:5;
 if(bracket==="single"){
   const pct=tier===4?0.30:0.40,cap=tier===4?500:1000;
   return{headAmount:money(Math.min(orderValueThatDay*pct,cap)),helperAmount:0,tier};
 }
 const pct=tier===4?0.30:0.40,cap=tier===4?500:1000,poolAmount=money(Math.min(orderValueThatDay*pct,cap));
 return{headAmount:money(poolAmount*0.6),helperAmount:money(poolAmount*0.4),tier};
}

function upgradeTierBonus(bracket:GroomerBracket,upgradeCount:number){
 if(bracket==="team"){
   if(upgradeCount>=40)return{headAmount:5000,helperAmount:2500};
   if(upgradeCount>=30)return{headAmount:3000,helperAmount:1500};
   if(upgradeCount>=20)return{headAmount:1500,helperAmount:750};
   return{headAmount:0,helperAmount:0};
 }
 if(upgradeCount>=25)return{headAmount:5000,helperAmount:0};
 if(upgradeCount>=15)return{headAmount:3000,helperAmount:0};
 return{headAmount:0,helperAmount:0};
}

function achievementTierBonus(bracket:GroomerBracket,monthTotal:number){
 const tiers=bracket==="team"
   ?[{cross:190000,headAmount:10000,helperAmount:5500},{cross:165000,headAmount:7000,helperAmount:4000},{cross:145000,headAmount:4500,helperAmount:2500}]
   :[{cross:175000,headAmount:10000,helperAmount:0},{cross:150000,headAmount:8500,helperAmount:0},{cross:125000,headAmount:6000,helperAmount:0}];
 for(const t of tiers)if(monthTotal>=t.cross)return{headAmount:t.headAmount,helperAmount:t.helperAmount,crossed:t.cross};
 return{headAmount:0,helperAmount:0,crossed:null as number|null};
}

function winnerBonus(bracket:GroomerBracket,rank:number){
 const team=[[5000,3000],[4000,2500],[3000,2000],[2500,2000],[2000,1500]];
 const single=[[8000,0],[6500,0],[5000,0],[4000,0],[3000,0]];
 const table=bracket==="team"?team:single;
 if(rank<1||rank>5)return{headAmount:0,helperAmount:0};
 const[head,helper]=table[rank-1];
 return{headAmount:head,helperAmount:helper};
}

async function dailyOrdersForGroomer(db:Db,headGroomerId:string,monthStartDate:string,monthEndDate:string){
 const rows=await db.prepare("SELECT date(scheduled_start) day,total_amount FROM canonical_bookings WHERE provider_id=? AND service_code='grooming' AND status='completed' AND date(scheduled_start)>=? AND date(scheduled_start)<=? ORDER BY scheduled_start ASC")
   .bind(headGroomerId,monthStartDate,monthEndDate).all<Row>();
 const byDay=new Map<string,number[]>();
 for(const row of rows.results){const day=String(row.day);if(!byDay.has(day))byDay.set(day,[]);byDay.get(day)!.push(Number(row.total_amount));}
 return byDay;
}

export async function computeGroomerMonthlyIncentive(db:Db,input:{headGroomerId:string;monthStart:string;actorId:string}){
 await ensureGroomingIncentiveTables(db);
 if(!/^\d{4}-\d{2}-01$/.test(input.monthStart))throw new Error("monthStart must be the first day of a month");
 const[year,month]=input.monthStart.split("-").map(Number);
 const monthEndDate=new Date(year,month,0).toISOString().slice(0,10);
 const bracketRow=await currentGroomerBracket(db,input.headGroomerId,input.monthStart);
 if(!bracketRow)throw new Error("This groomer has no bracket configured for this month - set team/single before computing");
 const bracket=bracketRow.bracket;

 const byDay=await dailyOrdersForGroomer(db,input.headGroomerId,input.monthStart,monthEndDate);
 let orderValueTotal=0,orderCountTotal=0;
 const dailyOrderResults:Array<{day:string;orderCount:number;orderValue:number;headBonus:number;helperBonus:number;tier:4|5|null}>=[];
 for(const[day,values] of byDay){
   const dayValue=money(values.reduce((s,v)=>s+v,0));
   orderValueTotal+=dayValue;orderCountTotal+=values.length;
   const bonus=dailyOrderBonus(bracket,values.length,dayValue);
   dailyOrderResults.push({day,orderCount:values.length,orderValue:dayValue,headBonus:bonus.headAmount,helperBonus:bonus.helperAmount,tier:bonus.tier});
 }
 orderValueTotal=money(orderValueTotal);

 const upgradeRow=await db.prepare("SELECT COUNT(*) n,COALESCE(SUM(upgrade_value),0) total FROM booking_upgrades WHERE provider_id=? AND booking_id IN (SELECT id FROM canonical_bookings WHERE date(scheduled_start)>=? AND date(scheduled_start)<=?)")
   .bind(input.headGroomerId,input.monthStart,monthEndDate).first<Row>();
 const upgradeCount=Number(upgradeRow?.n||0),upgradeValue=money(upgradeRow?.total);

 const monthTotal=money(orderValueTotal+upgradeValue);

 if(monthTotal<100000){
   return{headGroomerId:input.headGroomerId,monthStart:input.monthStart,bracket,orderCountTotal,orderValueTotal,upgradeCount,upgradeValue,monthTotal,eligible:false,eligibleForRanking:false,components:{},headTotal:0,helperTotal:0};
 }

 const dailyOrderHeadTotal=money(dailyOrderResults.reduce((s,d)=>s+d.headBonus,0));
 const dailyOrderHelperTotal=money(dailyOrderResults.reduce((s,d)=>s+d.helperBonus,0));
 const upgradeBonus=upgradeTierBonus(bracket,upgradeCount);
 const offlineSubRow=await db.prepare("SELECT COUNT(*) n FROM groomer_offline_sub_sales WHERE head_groomer_id=? AND sale_date>=? AND sale_date<=?").bind(input.headGroomerId,input.monthStart,monthEndDate).first<Row>();
 const offlineSubBonus=money(Number(offlineSubRow?.n||0)*500);
 const targetRow=await db.prepare("SELECT target_amount FROM groomer_monthly_targets WHERE head_groomer_id=? AND month_start=?").bind(input.headGroomerId,input.monthStart).first<Row>();
 const targetAmount=targetRow?Number(targetRow.target_amount):null;
 const crossedTarget=targetAmount!=null&&monthTotal>=targetAmount;
 const achievement=achievementTierBonus(bracket,monthTotal);

 let soloDayBonus=0,soloDayCount=0;
 if(bracket==="team"&&bracketRow.helperId){
   const absentDays=await db.prepare("SELECT COUNT(*) n FROM helper_daily_attendance WHERE helper_id=? AND attendance_date>=? AND attendance_date<=? AND status='absent'").bind(bracketRow.helperId,input.monthStart,monthEndDate).first<Row>();
   soloDayCount=Number(absentDays?.n||0);soloDayBonus=money(soloDayCount*500);
 }

 const gpayRow=await db.prepare("SELECT gpay_pending FROM groomer_gpay_ledger WHERE head_groomer_id=? AND month_start=?").bind(input.headGroomerId,input.monthStart).first<Row>();
 const gpayPending=Number(gpayRow?.gpay_pending||0),gpayFine=gpayFineForPending(gpayPending);

 const specialRow=await db.prepare("SELECT COALESCE(SUM(amount),0) total FROM groomer_special_incentives WHERE head_groomer_id=? AND month_start=?").bind(input.headGroomerId,input.monthStart).first<Row>();
 const groomerSpecificSpecialIncentive=money(specialRow?.total);
 const genericSpecialIncentive=await monthlySpecialIncentiveTotal(db,{employeeId:input.headGroomerId,monthStart:input.monthStart});
 const specialIncentive=money(groomerSpecificSpecialIncentive+genericSpecialIncentive);

 const petrol=await monthlyPetrolAllowance(db,{providerId:input.headGroomerId,monthStartDate:input.monthStart,monthEndDate});

 const headTotal=money(dailyOrderHeadTotal+upgradeBonus.headAmount+offlineSubBonus+achievement.headAmount+soloDayBonus+specialIncentive+petrol.totalAllowance-gpayFine);
 const helperTotal=money(dailyOrderHelperTotal+upgradeBonus.helperAmount+achievement.helperAmount);

 return{
   headGroomerId:input.headGroomerId,monthStart:input.monthStart,bracket,
   orderCountTotal,orderValueTotal,upgradeCount,upgradeValue,monthTotal,
   targetAmount,crossedTarget,eligible:true,eligibleForRanking:crossedTarget,
   components:{
     dailyOrderHeadTotal,dailyOrderHelperTotal,dailyOrderResults,
     upgradeBonus,offlineSubBonus,achievementTierBonus:achievement,
     soloDayBonus,soloDayCount,gpayPending,gpayFine,specialIncentive,petrolAllowance:petrol.totalAllowance,petrolQualifyingDays:petrol.qualifyingDayCount,
   },
   headTotal,helperTotal,
 };
}

export async function rankGroomersForMonth(db:Db,input:{monthStart:string;headGroomerIds:string[];actorId:string}){
 await ensureGroomingIncentiveTables(db);
 const computed=await Promise.all(input.headGroomerIds.map(id=>computeGroomerMonthlyIncentive(db,{headGroomerId:id,monthStart:input.monthStart,actorId:input.actorId})));
 const eligible=computed.filter(c=>c.eligibleForRanking&&c.targetAmount).map(c=>({...c,achievementPercent:money((c.monthTotal/(c.targetAmount as number))*100)}));
 eligible.sort((a,b)=>b.achievementPercent-a.achievementPercent);
 return eligible.map((c,index)=>{
   const rank=index+1,bonus=winnerBonus(c.bracket,rank);
   return{headGroomerId:c.headGroomerId,bracket:c.bracket,monthTotal:c.monthTotal,targetAmount:c.targetAmount,achievementPercent:c.achievementPercent,rank,winnerHeadBonus:bonus.headAmount,winnerHelperBonus:bonus.helperAmount};
 });
}
