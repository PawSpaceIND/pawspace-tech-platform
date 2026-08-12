// TDS (Tax Deducted at Source) engine computing liabilities from REAL platform data:
//   Section 192  - salaries, from employee_payroll_results (new-regime FY 2025-26 slabs)
//   Section 194H - commission payouts (commission-model providers + boarding host settlements), 2%
//   Section 194J - professional fees (contract-model providers), 10%
// Thresholds per Finance Act 2025 (effective 1 Apr 2025): 194H aggregate Rs 20,000/FY,
// 194J aggregate Rs 50,000/FY. Once an aggregate threshold is crossed the whole FY-to-date
// base becomes deductible; this engine deducts the not-yet-taxed cumulative base at that point.
// Deposits are due the 7th of the following month (30 April for March); quarterly returns are
// 24Q (salary) and 26Q (non-salary). Where a PAN is not on record the row is FLAGGED
// (pan_status='pending_verification') rather than silently taxed at the s206AA penal 20% -
// the close checklist blocks on unresolved PANs instead of guessing.

type Db=D1Database;
type Row=Record<string,unknown>;

export const TDS_RATES={salary192:null,commission194H:0.02,professional194J:0.10} as const;
export const TDS_THRESHOLDS_FY={commission194H:20_000,professional194J:50_000} as const;
const round2=(value:number)=>Math.round(value*100)/100;

/** New-regime income tax on annual salary, FY 2025-26 (AY 2026-27):
 *  standard deduction Rs 75,000; slabs 0-4L nil, 4-8L 5%, 8-12L 10%, 12-16L 15%,
 *  16-20L 20%, 20-24L 25%, >24L 30%; s87A rebate zeroes tax when taxable <= 12L,
 *  with marginal relief just above; 4% health & education cess. No surcharge band
 *  (applies only above Rs 50L, outside current payroll). Pure and unit-tested. */
export function newRegimeAnnualTax(grossAnnualSalary:number):{taxableIncome:number;slabTax:number;rebateApplied:boolean;marginalReliefApplied:boolean;cess:number;totalTax:number}{
 const gross=Math.max(0,Number(grossAnnualSalary)||0);
 const taxable=Math.max(0,gross-75_000);
 const slabs:[number,number,number][]=[[400_000,800_000,0.05],[800_000,1_200_000,0.10],[1_200_000,1_600_000,0.15],[1_600_000,2_000_000,0.20],[2_000_000,2_400_000,0.25],[2_400_000,Number.POSITIVE_INFINITY,0.30]];
 let tax=0;
 for(const[from,to,rate]of slabs){if(taxable>from)tax+=(Math.min(taxable,to)-from)*rate;}
 let rebateApplied=false,marginalReliefApplied=false;
 if(taxable<=1_200_000){tax=0;rebateApplied=true;}
 else{const excess=taxable-1_200_000;if(tax>excess){tax=excess;marginalReliefApplied=true;}}
 const cess=round2(tax*0.04);
 return{taxableIncome:taxable,slabTax:round2(tax),rebateApplied,marginalReliefApplied,cess,totalTax:round2(tax+cess)};
}

/** Uniform monthly salary TDS estimate: annualize the month's gross, tax it, divide by 12. */
export function monthlySalaryTds(monthlyGross:number):number{
 return round2(newRegimeAnnualTax(monthlyGross*12).totalTax/12);
}

const tdsTablesEnsured=new WeakSet<Db>();
export async function ensureTdsTables(db:Db){
 if(tdsTablesEnsured.has(db))return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS tds_deductions (id TEXT PRIMARY KEY,period TEXT NOT NULL,section TEXT NOT NULL,deductee_type TEXT NOT NULL,deductee_id TEXT NOT NULL,deductee_name TEXT NOT NULL,pan_status TEXT NOT NULL DEFAULT 'pending_verification',base_amount REAL NOT NULL,rate_pct REAL NOT NULL,tds_amount REAL NOT NULL,source_type TEXT NOT NULL,source_ref TEXT NOT NULL,computed_at INTEGER NOT NULL,UNIQUE(period,section,deductee_id,source_ref))"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_tds_period ON tds_deductions(period,section)"),
  db.prepare("CREATE TABLE IF NOT EXISTS tds_deposits (period TEXT PRIMARY KEY,amount REAL NOT NULL,challan_reference TEXT NOT NULL,due_date TEXT NOT NULL,deposited_by TEXT NOT NULL,deposited_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'deposited')"),
  db.prepare("CREATE TABLE IF NOT EXISTS tds_quarterly_returns (id TEXT PRIMARY KEY,fy_label TEXT NOT NULL,quarter INTEGER NOT NULL,form TEXT NOT NULL,period_months_json TEXT NOT NULL,total_base REAL NOT NULL,total_tds REAL NOT NULL,total_deposited REAL NOT NULL,deductee_count INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'prepared',acknowledgement_ref TEXT,filed_by TEXT,filed_at INTEGER,prepared_by TEXT NOT NULL,prepared_at INTEGER NOT NULL,UNIQUE(fy_label,quarter,form))"),
 ]);
 tdsTablesEnsured.add(db);
}

function monthWindow(period:string):{startMs:number;endMs:number}{
 const[year,month]=period.split("-").map(Number);
 if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>12)throw new Response("TDS period must be YYYY-MM",{status:400});
 const startMs=Date.UTC(year,month-1,1)-(330*60_000),endMs=Date.UTC(month===12?year+1:year,month===12?0:month,1)-(330*60_000);
 return{startMs,endMs};
}

/** Indian FY months for the FY containing `period`, up to and including it. */
function fyMonthsThrough(period:string):string[]{
 const[year,month]=period.split("-").map(Number);
 const fyStartYear=month>=4?year:year-1;
 const months:string[]=[];
 for(let offset=0;offset<12;offset++){
  const m=((3+offset)%12)+1,y=fyStartYear+(m<4?1:0);
  months.push(`${y}-${String(m).padStart(2,"0")}`);
  if(y===year&&m===month)break;
 }
 return months;
}

async function safeAll(db:Db,sql:string,bindings:unknown[]=[]){
 try{let statement=db.prepare(sql);if(bindings.length)statement=statement.bind(...bindings);return((await statement.all<Row>()).results||[]);}catch{return[] as Row[];}
}

export type TdsComputation={period:string;sections:Record<string,{base:number;tds:number;deductees:number}>;totalTds:number;issues:string[];depositDueDate:string};

/** Compute (and idempotently persist) the month's TDS from real payroll + payout data.
 *  Recomputation replaces the period's engine-computed rows, so it is safe to re-run. */
export async function computeMonthlyTds(db:Db,input:{period:string;actorId:string;asOf?:number}):Promise<TdsComputation>{
 await ensureTdsTables(db);
 const{startMs,endMs}=monthWindow(input.period),now=input.asOf??Date.now(),issues:string[]=[];
 await db.prepare("DELETE FROM tds_deductions WHERE period=?").bind(input.period).run();
 const rows:Array<{section:string;deducteeType:string;deducteeId:string;deducteeName:string;base:number;rate:number;tds:number;sourceType:string;sourceRef:string}>=[];

 // s192 salaries: payroll results whose run period overlaps this month.
 const payroll=await safeAll(db,"SELECT r.id result_id,r.employee_id,r.gross_earnings,p.id run_id FROM employee_payroll_results r JOIN payroll_runs p ON p.id=r.run_id WHERE p.period_start<? AND p.period_end>?",[endMs,startMs]);
 for(const row of payroll){
  const gross=Number(row.gross_earnings||0);if(gross<=0)continue;
  const tds=monthlySalaryTds(gross);
  if(tds>0)rows.push({section:"192",deducteeType:"employee",deducteeId:String(row.employee_id),deducteeName:String(row.employee_id),base:gross,rate:0,tds,sourceType:"payroll_run",sourceRef:String(row.run_id)});
 }

 // 194H (commission) / 194J (professional): payouts classified by the engagement model on the
 // governing commercial term. FY-aggregate thresholds compare against the FY-TO-DATE cumulative
 // read from the SOURCE tables (below-threshold months leave no deduction rows, so deduction
 // history alone cannot see earlier payouts); the untaxed portion is cumulative minus base
 // already taxed in prior months' deduction rows.
 const[year,monthNum]=input.period.split("-").map(Number);
 const fyStartMs=Date.UTC(monthNum>=4?year:year-1,3,1)-(330*60_000);
 const fyPayouts=await safeAll(db,"SELECT c.booking_id,c.provider_id,c.provider_net_payout,c.computed_at,t.engagement_model FROM provider_payout_computations c JOIN provider_commercial_terms t ON t.id=c.term_id WHERE c.computed_at>=? AND c.computed_at<?",[fyStartMs,endMs]);
 const fySettlements=await safeAll(db,"SELECT booking_id,provider_id,payout_amount,eligible_at FROM boarding_host_settlement_ledger WHERE payout_amount IS NOT NULL AND eligible_at>=? AND eligible_at<?",[fyStartMs,endMs]);
 type ProviderAgg={section:"194H"|"194J";fyCumulative:number;monthAmount:number;monthRefs:string[]};
 const providerAgg=new Map<string,ProviderAgg>();
 const accumulate=(section:"194H"|"194J",providerId:string,amount:number,at:number,ref:string)=>{
  const key=`${section}:${providerId}`;
  const entry=providerAgg.get(key)||{section,fyCumulative:0,monthAmount:0,monthRefs:[]};
  entry.fyCumulative+=amount;
  if(at>=startMs&&at<endMs){entry.monthAmount+=amount;entry.monthRefs.push(ref);}
  providerAgg.set(key,entry);
 };
 // The payout engine writes engagement_model values commission_groomer / commission_standard /
 // direct_employee (lib/provider-commercial-terms.ts) - classify on that real vocabulary, then let
 // the provider's workforce engagement (service_providers.engagement_type, the same source the
 // partner workspace renders from) promote contract-engaged professionals to 194J.
 const directModels=new Set(["direct","direct_employee"]),contractModels=new Set(["contract","contractor","contract_provider"]);
 const workforceKindCache=new Map<string,string>();
 const workforceKind=async(providerId:string)=>{
  if(!workforceKindCache.has(providerId)){
   // Same provider registries the partner workspace classifies from: service_providers when present,
   // else provider_capacity_profiles.provider_model / provider_compensation_profiles.engagement_model
   // (full_time = contract-engaged professional -> 194J; commission -> 194H).
   const fromServiceProviders=await safeAll(db,"SELECT engagement_type FROM service_providers WHERE id=?",[providerId]);
   let kind=String(fromServiceProviders[0]?.engagement_type??"").trim().toLowerCase();
   if(!kind){
    const fromCapacity=await safeAll(db,"SELECT provider_model FROM provider_capacity_profiles WHERE id=?",[providerId]);
    const fromCompensation=fromCapacity.length?fromCapacity:await safeAll(db,"SELECT engagement_model provider_model FROM provider_compensation_profiles WHERE provider_id=?",[providerId]);
    const model=String(fromCompensation[0]?.provider_model??"").trim().toLowerCase();
    if(model)kind=model.startsWith("commission")?"commission":"contract";
   }
   workforceKindCache.set(providerId,kind);
  }
  return workforceKindCache.get(providerId)||"";
 };
 for(const row of fyPayouts){
  const model=String(row.engagement_model).trim().toLowerCase();
  if(directModels.has(model))continue; // salaried delivery is taxed under s192, never provider TDS
  const providerId=String(row.provider_id);
  const section=contractModels.has(model)||contractModels.has(await workforceKind(providerId))?"194J":"194H";
  accumulate(section,providerId,Number(row.provider_net_payout||0),Number(row.computed_at||0),String(row.booking_id));
 }
 for(const row of fySettlements)accumulate("194H",String(row.provider_id),Number(row.payout_amount||0),Number(row.eligible_at||0),String(row.booking_id));
 const fyMonths=fyMonthsThrough(input.period).filter(month=>month!==input.period);
 for(const[key,entry]of providerAgg){
  if(entry.monthAmount<=0)continue; // no activity this month - nothing new to deduct
  const providerId=key.split(":")[1];
  const threshold=entry.section==="194H"?TDS_THRESHOLDS_FY.commission194H:TDS_THRESHOLDS_FY.professional194J;
  const rate=entry.section==="194H"?TDS_RATES.commission194H:TDS_RATES.professional194J;
  if(entry.fyCumulative<threshold)continue; // FY aggregate threshold not crossed yet
  const prior=fyMonths.length?await safeAll(db,`SELECT COALESCE(SUM(base_amount),0) prior_base FROM tds_deductions WHERE section=? AND deductee_id=? AND period IN (${fyMonths.map(()=>"?").join(",")})`,[entry.section,providerId,...fyMonths]):[{prior_base:0}];
  const priorTaxedBase=Number(prior[0]?.prior_base||0);
  const base=round2(entry.fyCumulative-priorTaxedBase); // full untaxed cumulative at first crossing, month amount afterwards
  const tds=round2(base*rate);
  if(tds<=0)continue;
  rows.push({section:entry.section,deducteeType:"provider",deducteeId:providerId,deducteeName:providerId,base,rate:rate*100,tds,sourceType:"provider_payouts",sourceRef:entry.monthRefs.sort().join(",").slice(0,180)});
 }

 const statements=rows.map(row=>db.prepare("INSERT OR REPLACE INTO tds_deductions (id,period,section,deductee_type,deductee_id,deductee_name,pan_status,base_amount,rate_pct,tds_amount,source_type,source_ref,computed_at) VALUES (?,?,?,?,?,?,'pending_verification',?,?,?,?,?,?)")
  .bind(`TDS-${crypto.randomUUID().slice(0,10).toUpperCase()}`,input.period,row.section,row.deducteeType,row.deducteeId,row.deducteeName,row.base,row.rate,row.tds,row.sourceType,row.sourceRef,now));
 if(statements.length)await db.batch(statements);
 if(rows.length)issues.push(`${rows.length} deductee PAN(s) pending verification - resolve before filing (s206AA applies 20% without PAN)`);

 const sections:TdsComputation["sections"]={};
 for(const row of rows){
  const bucket=sections[row.section]||{base:0,tds:0,deductees:0};
  bucket.base=round2(bucket.base+row.base);bucket.tds=round2(bucket.tds+row.tds);bucket.deductees+=1;sections[row.section]=bucket;
 }
 const depositDueDate=monthNum===3?`${year}-04-30`:monthNum===12?`${year+1}-01-07`:`${year}-${String(monthNum+1).padStart(2,"0")}-07`;
 return{period:input.period,sections,totalTds:round2(rows.reduce((sum,row)=>sum+row.tds,0)),issues,depositDueDate};
}

export async function recordTdsDeposit(db:Db,input:{period:string;challanReference:string;amount:number;actorId:string;asOf?:number}){
 await ensureTdsTables(db);
 const challan=String(input.challanReference||"").trim();
 if(!challan)throw new Response("Challan reference (ITNS-281) is required",{status:400});
 const computed=await db.prepare("SELECT COALESCE(SUM(tds_amount),0) total FROM tds_deductions WHERE period=?").bind(input.period).first<Row>();
 const liability=round2(Number(computed?.total||0));
 if(Math.abs(liability-round2(Number(input.amount)))>0.01)throw new Response(`Deposit must equal the computed liability of ${liability} for ${input.period}`,{status:409});
 monthWindow(input.period); // validates period format
 const[year,month]=input.period.split("-").map(Number);
 const dueDate=month===3?`${year}-04-30`:month===12?`${year+1}-01-07`:`${year}-${String(month+1).padStart(2,"0")}-07`;
 const now=input.asOf??Date.now();
 const existing=await db.prepare("SELECT period FROM tds_deposits WHERE period=?").bind(input.period).first<Row>();
 if(existing)return{period:input.period,amount:liability,duplicatePrevented:true};
 await db.prepare("INSERT INTO tds_deposits (period,amount,challan_reference,due_date,deposited_by,deposited_at,status) VALUES (?,?,?,?,?,?,'deposited')")
  .bind(input.period,liability,challan,dueDate,input.actorId,now).run();
 return{period:input.period,amount:liability,challanReference:challan,dueDate,duplicatePrevented:false};
}

/** Prepare a quarterly return (24Q salaries / 26Q non-salary) from recorded deductions + deposits. */
export async function prepareTdsQuarterlyReturn(db:Db,input:{fyLabel:string;quarter:1|2|3|4;form:"24Q"|"26Q";actorId:string;asOf?:number}){
 await ensureTdsTables(db);
 const startYear=Number(input.fyLabel.replace(/^FY/,"").split("-")[0]);
 if(!Number.isInteger(startYear))throw new Response("fyLabel must look like FY2026-27",{status:400});
 const monthsByQuarter:Record<number,string[]>={1:["04","05","06"],2:["07","08","09"],3:["10","11","12"],4:["01","02","03"]};
 const year=input.quarter===4?startYear+1:startYear;
 const months=monthsByQuarter[input.quarter].map(month=>`${year}-${month}`);
 const sectionFilter=input.form==="24Q"?"section='192'":"section!='192'";
 const totals=await db.prepare(`SELECT COALESCE(SUM(base_amount),0) base,COALESCE(SUM(tds_amount),0) tds,COUNT(DISTINCT deductee_id) deductees FROM tds_deductions WHERE ${sectionFilter} AND period IN (${months.map(()=>"?").join(",")})`).bind(...months).first<Row>();
 const deposits=await db.prepare(`SELECT COALESCE(SUM(amount),0) deposited FROM tds_deposits WHERE period IN (${months.map(()=>"?").join(",")})`).bind(...months).first<Row>();
 const now=input.asOf??Date.now();
 const record={id:`TDSQ-${crypto.randomUUID().slice(0,10).toUpperCase()}`,base:round2(Number(totals?.base||0)),tds:round2(Number(totals?.tds||0)),deposited:round2(Number(deposits?.deposited||0)),deductees:Number(totals?.deductees||0)};
 await db.prepare("INSERT INTO tds_quarterly_returns (id,fy_label,quarter,form,period_months_json,total_base,total_tds,total_deposited,deductee_count,status,prepared_by,prepared_at) VALUES (?,?,?,?,?,?,?,?,?,'prepared',?,?) ON CONFLICT(fy_label,quarter,form) DO UPDATE SET period_months_json=excluded.period_months_json,total_base=excluded.total_base,total_tds=excluded.total_tds,total_deposited=excluded.total_deposited,deductee_count=excluded.deductee_count,prepared_by=excluded.prepared_by,prepared_at=excluded.prepared_at")
  .bind(record.id,input.fyLabel,input.quarter,input.form,JSON.stringify(months),record.base,record.tds,record.deposited,record.deductees,input.actorId,now).run();
 return{fyLabel:input.fyLabel,quarter:input.quarter,form:input.form,months,totalBase:record.base,totalTds:record.tds,totalDeposited:record.deposited,deducteeCount:record.deductees,fullyDeposited:record.deposited>=record.tds,status:"prepared" as const};
}

export async function markTdsReturnFiled(db:Db,input:{fyLabel:string;quarter:1|2|3|4;form:"24Q"|"26Q";acknowledgementRef:string;actorId:string;asOf?:number}){
 await ensureTdsTables(db);
 const ack=String(input.acknowledgementRef||"").trim();
 if(!ack)throw new Response("TRACES acknowledgement reference is required",{status:400});
 const now=input.asOf??Date.now();
 const result=await db.prepare("UPDATE tds_quarterly_returns SET status='filed',acknowledgement_ref=?,filed_by=?,filed_at=? WHERE fy_label=? AND quarter=? AND form=? AND status='prepared'")
  .bind(ack,input.actorId,now,input.fyLabel,input.quarter,input.form).run();
 if(!Number(result.meta.changes))throw new Response("Prepare the quarterly return before marking it filed (or it is already filed)",{status:409});
 return{fyLabel:input.fyLabel,quarter:input.quarter,form:input.form,status:"filed" as const,acknowledgementRef:ack};
}

export async function tdsDashboard(db:Db,period:string){
 await ensureTdsTables(db);
 const deductions=await safeAll(db,"SELECT section,deductee_type,deductee_id,deductee_name,base_amount,rate_pct,tds_amount,pan_status FROM tds_deductions WHERE period=? ORDER BY section,tds_amount DESC",[period]);
 const deposit=await db.prepare("SELECT * FROM tds_deposits WHERE period=?").bind(period).first<Row>();
 const returns=await safeAll(db,"SELECT fy_label,quarter,form,total_tds,total_deposited,deductee_count,status,acknowledgement_ref FROM tds_quarterly_returns ORDER BY fy_label DESC,quarter DESC");
 return{period,deductions,deposit:deposit||null,quarterlyReturns:returns};
}
