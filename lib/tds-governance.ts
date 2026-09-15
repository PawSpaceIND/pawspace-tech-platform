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
//
// The PAN control is a real, closable loop, not a permanent warning:
//   recordTdsPanVerification()  is the ONLY writer of a verified PAN. It refuses a malformed PAN and
//                               a deductee with no deduction row, records a MASKED reference plus who
//                               verified it and when in tds_pan_registry, and stamps the deductee's
//                               existing tds_deductions rows 'verified'.
//   tds_pan_registry            is the durable, per-deductee record. computeMonthlyTds READS it and
//                               stamps each computed row from it, so a recompute can never undo an
//                               operator's verification and a deductee verified once stays verified
//                               in every later period.
//   finance-monthly-close.ts    carries the tds_pans_verified checklist item, which is RED (and so
//                               blocks the close) while any of the month's deductees is unverified.
// Before this existed the only writer hard-coded 'pending_verification' on every recompute, so the
// warning could never be cleared and the "close checklist blocks on unresolved PANs" claim above was
// describing a control that did not exist. [FIN-W1-D3]

import{governedJsonError}from"./governed-http-error";

/* The refusals below are the operator's OWN input (a blank challan, a deposit that does not equal the
 * computed liability, a malformed period or fyLabel, filing a quarter that was never prepared) and are
 * raised with governedJsonError() so authError() returns them verbatim. A plain `new Response(...)` is
 * NOT enough: isGovernedHttpError() trusts a thrown Response only by identity in the WeakSet that
 * governedJsonError()/markGovernedHttpError() register it in, so an ungoverned one keeps its status and
 * loses its body to the route's fallback - "Unable to complete the statutory compliance action" in place
 * of "Deposit must equal the computed liability of 44070 for 2026-08".
 *
 * The two `new Error(...)` throws further down (the read-before-delete guards) are deliberately NOT
 * converted: a source table that exists and fails to read is a platform fault, and a redacted 500 is
 * the correct report for it. [AUDIT-C3] */
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
  // The durable home of an operator's PAN verification. It is deliberately OUTSIDE tds_deductions,
  // which every recompute rewrites: state a human entered must not live in a table a machine
  // regenerates. Only a masked reference is stored - the last five characters of the PAN are enough
  // to tie a deduction to a 26AS/TRACES entry, and the full number is never persisted here. [FIN-W1-D3]
  db.prepare("CREATE TABLE IF NOT EXISTS tds_pan_registry (deductee_id TEXT PRIMARY KEY,deductee_type TEXT NOT NULL,deductee_name TEXT NOT NULL DEFAULT '',pan_reference TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'verified',verified_by TEXT NOT NULL,verified_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 ]);
 tdsTablesEnsured.add(db);
}

const IST_OFFSET_MS=330*60_000;

/* A payroll run belongs to EXACTLY ONE calendar month. [FIN-W1-D1]
 *
 * Both this module and lib/finance-monthly-close.ts used to select payroll with a pure OVERLAP test -
 * `WHERE p.period_start<:endMs AND p.period_end>:startMs` - against IST-shifted month boundaries,
 * while payroll_runs stores plain-UTC end-of-day boundaries. SEEDRUN-AUG2026 (2026-08-01T00:00:00Z ->
 * 2026-08-31T23:59:59Z, 40 employees, gross 11,50,000) therefore satisfied the predicate for BOTH
 * 2026-08 and 2026-09: the September window opens at 2026-08-31T18:30:00Z, five and a half hours
 * before the run ends. Overlap has no proration either, so one run was claimed IN FULL by two closes,
 * and computeMonthlyTds would have computed - and recordTdsDeposit would have DEPOSITED - the same
 * s192 liability twice. It read Rs 0 only because every seeded salary falls under the s87A rebate.
 *
 * The rule: the run is attributed to the IST calendar month containing the MIDPOINT of its pay period.
 *
 * Why a single month and not proration. A payroll run is one payment event: it is approved once, paid
 * once, and its s192 tax is deposited once, by the 7th of the month following payment (a single
 * challan, a single 24Q line, a single Form 16 credit). Splitting one run across two months would
 * invent two deposit obligations for one payment. There is also nothing to prorate WITH -
 * employee_payroll_results carries no date of its own, only run_id, so any split would be an
 * apportionment of amounts the source never apportioned.
 *
 * Why the midpoint and not a boundary. Run boundaries are written in two conventions in this
 * database (plain UTC by the seed, IST-shifted by lib/payroll-engine.ts callers), so any
 * boundary-based rule is wrong by up to 5h30m for half the rows - which is exactly the bug. The
 * midpoint of a month-long period sits ~15 days from either edge, so it is immune to that skew; only
 * a pay period shorter than about eleven hours could be moved by it, and no such payroll exists.
 *
 * The rule is a TOTAL function of the run alone, so every run maps to exactly one month: it cannot
 * be double-counted, and it cannot be dropped. PAYROLL_RUN_PERIOD_SQL and payrollRunPeriod are the
 * SAME rule in SQL and in TypeScript, and lib/finance-monthly-close.ts consumes this module's
 * helpers rather than re-deriving them, so the close view and computeMonthlyTds cannot drift apart. */
export function payrollRunPeriod(periodStart:number,periodEnd:number):string{
 const start=Number(periodStart)||0,end=Number(periodEnd)||0;
 const midpoint=Math.floor((start+(end>=start?end:start))/2)+IST_OFFSET_MS;
 const at=new Date(midpoint);
 return`${at.getUTCFullYear()}-${String(at.getUTCMonth()+1).padStart(2,"0")}`;
}
/** payrollRunPeriod as a SQL expression over an aliased payroll_runs row. */
export const PAYROLL_RUN_PERIOD_SQL=(alias:string)=>`strftime('%Y-%m',((${alias}.period_start+${alias}.period_end)/2+${IST_OFFSET_MS})/1000,'unixepoch')`;

export type PayrollRunAttribution={runId:string;status:string;employees:number;grossTotal:number;periodStart:number;periodEnd:number};
/** Every payroll run attributed to `period`, with its employee count and gross. Shared with the
 *  monthly close so both surfaces answer "whose payroll is this month's?" identically. */
export async function payrollRunsForPeriod(db:Db,period:string):Promise<PayrollRunAttribution[]>{
 const rows=await safeAll(db,`SELECT p.id run_id,p.status,p.period_start,p.period_end,COUNT(r.id) employees,COALESCE(SUM(r.gross_earnings),0) gross FROM payroll_runs p LEFT JOIN employee_payroll_results r ON r.run_id=p.id WHERE ${PAYROLL_RUN_PERIOD_SQL("p")}=? GROUP BY p.id ORDER BY p.period_start,p.id`,[period]);
 return rows.map(row=>({runId:String(row.run_id),status:String(row.status??""),employees:Number(row.employees||0),grossTotal:round2(Number(row.gross||0)),periodStart:Number(row.period_start||0),periodEnd:Number(row.period_end||0)}));
}

function monthWindow(period:string):{startMs:number;endMs:number}{
 const[year,month]=period.split("-").map(Number);
 if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>12)throw governedJsonError({error:"TDS period must be YYYY-MM"},400);
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

export type TdsComputation={period:string;sections:Record<string,{base:number;tds:number;deductees:number}>;totalTds:number;issues:string[];depositDueDate:string;deducteeRows:number;panVerified:number;panPending:number;persisted:boolean};

/** Compute (and, when persisting, idempotently store) the month's TDS from real payroll + payout data.
 *
 *  `persist` defaults to TRUE - this is the statutory recompute behind POST ?action=compute_tds and
 *  behind closing a month. It is passed FALSE by the read-only monthly-close view, because a GET of
 *  the compliance dashboard must not write. [FIN-W1-D2]
 *
 *  Persisting is an UPSERT on (period,section,deductee_id,source_ref) followed by a sweep of the rows
 *  this run did not touch - not the DELETE-everything-then-INSERT it used to be. The old form also
 *  re-stamped pan_status='pending_verification' on every row it wrote, so a recompute silently undid
 *  an operator's PAN verification; pan_status now comes from tds_pan_registry, which no recompute
 *  touches. The source reads still happen strictly BEFORE any write, so a failed read refuses instead
 *  of destroying the period. [AUDIT-C3 preserved] */
async function sourceTableExists(db:Db,name:string){try{return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}catch{return false;}}
// Like safeAll, but a never-created source table is a legitimately empty read while a table that EXISTS
// and fails to read REFUSES (throws) instead of returning [] - so a statutory recompute cannot destroy
// and zero a period on transient/drift read failure. [AUDIT-C3 extension for 194H/194J provider sources]
async function guardedAll(db:Db,tableName:string,sql:string,bindings:unknown[],period:string){
 if(!(await sourceTableExists(db,tableName)))return[] as Row[];
 try{let statement=db.prepare(sql);if(bindings.length)statement=statement.bind(...bindings);return((await statement.all<Row>()).results||[]);}
 catch(error){throw new Error(`TDS provider-source read (${tableName}) failed for ${period}; refusing to recompute. Existing tds_deductions rows are preserved. (${error instanceof Error?error.message:String(error)})`);}
}
export async function computeMonthlyTds(db:Db,input:{period:string;actorId:string;asOf?:number;persist?:boolean}):Promise<TdsComputation>{
 await ensureTdsTables(db);
 const persist=input.persist!==false;
 const{startMs,endMs}=monthWindow(input.period),now=input.asOf??Date.now(),issues:string[]=[];
 const rows:Array<{section:string;deducteeType:string;deducteeId:string;deducteeName:string;base:number;rate:number;tds:number;sourceType:string;sourceRef:string}>=[];

 // s192 salaries: payroll results of the runs ATTRIBUTED to this month (payrollRunPeriod above).
 // This used to be the same overlap predicate the close view used, so one run's salary TDS was
 // computed for two consecutive months - and would have been deposited twice. [FIN-W1-D1]
 /* Source read BEFORE the DELETE, and a failure REFUSES rather than returning [].
  *
  * This used to DELETE the period's tds_deductions and then read payroll through safeAll
  * (`catch{return[]}`). A failed read destroyed the prior computation and recomputed the month to
  * zero: measured at Rs 44,070 of s192 TDS over six employees becoming Rs 0 with the six deduction
  * rows gone and `issues` EMPTY. The monthly close then passed its tds_deposited check TRIVIALLY,
  * because that condition is `totalTds===0||Boolean(deposit)` - green tick, no challan, and six
  * employees issued Form 16 showing zero TDS credit.
  *
  * A statutory computation that cannot read its source must not publish a number, and must not
  * destroy the number it already had. [AUDIT-C3] */
 let payroll:Row[];
 /* Never-existed source table = a legitimately empty month (no payroll run yet). A table that EXISTS
  * but fails to read is the drift case this guard is for. */
 if(!(await sourceTableExists(db,"employee_payroll_results"))){payroll=[];}
 else try{payroll=((await db.prepare(`SELECT r.id result_id,r.employee_id,r.gross_earnings,p.id run_id FROM employee_payroll_results r JOIN payroll_runs p ON p.id=r.run_id WHERE ${PAYROLL_RUN_PERIOD_SQL("p")}=?`).bind(input.period).all<Row>()).results)||[];}
 catch(error){throw new Error(`TDS payroll read failed for ${input.period}; refusing to recompute. Existing tds_deductions rows are preserved. (${error instanceof Error?error.message:String(error)})`);}
 // 194H/194J provider sources are read HERE - before the DELETE - with the same refuse-on-drift guard as
 // s192 above, so a read failure on an existing source table cannot destroy the period and recompute
 // provider TDS to zero. [AUDIT-C3 extension]
 const[year,monthNum]=input.period.split("-").map(Number);
 const fyStartMs=Date.UTC(monthNum>=4?year:year-1,3,1)-(330*60_000);
 const fyPayouts=await guardedAll(db,"provider_payout_computations","SELECT c.booking_id,c.provider_id,c.provider_net_payout,c.computed_at,t.engagement_model FROM provider_payout_computations c JOIN provider_commercial_terms t ON t.id=c.term_id WHERE c.computed_at>=? AND c.computed_at<?",[fyStartMs,endMs],input.period);
 const fySettlements=await guardedAll(db,"boarding_host_settlement_ledger","SELECT booking_id,provider_id,payout_amount,eligible_at FROM boarding_host_settlement_ledger WHERE payout_amount IS NOT NULL AND eligible_at>=? AND eligible_at<?",[fyStartMs,endMs],input.period);
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

 /* pan_status is READ from tds_pan_registry, never invented here. The previous writer hard-coded
  * 'pending_verification' into every row it wrote, which is why no deduction could ever leave that
  * state and why a plain page load wiped a verification an operator had just recorded. [FIN-W1-D3] */
 const verifiedPans=new Set((await safeAll(db,"SELECT deductee_id FROM tds_pan_registry WHERE status='verified'")).map(row=>String(row.deductee_id)));
 const panStatusOf=(deducteeId:string)=>verifiedPans.has(deducteeId)?"verified":"pending_verification";
 const panVerified=rows.filter(row=>panStatusOf(row.deducteeId)==="verified").length,panPending=rows.length-panVerified;

 if(persist){
  /* UPSERT on the natural key, then sweep only what this run did not touch. INSERT OR REPLACE would
   * delete and re-create the row - a new id, and every operator-set column reset. The sweep is keyed
   * on this run's computed_at stamp, which every row written above carries, so a deduction whose
   * underlying payout has gone is removed without an IN list that could breach D1's bind cap. */
  const statements=rows.map(row=>db.prepare("INSERT INTO tds_deductions (id,period,section,deductee_type,deductee_id,deductee_name,pan_status,base_amount,rate_pct,tds_amount,source_type,source_ref,computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(period,section,deductee_id,source_ref) DO UPDATE SET deductee_type=excluded.deductee_type,deductee_name=excluded.deductee_name,pan_status=excluded.pan_status,base_amount=excluded.base_amount,rate_pct=excluded.rate_pct,tds_amount=excluded.tds_amount,source_type=excluded.source_type,computed_at=excluded.computed_at")
   .bind(`TDS-${crypto.randomUUID().slice(0,10).toUpperCase()}`,input.period,row.section,row.deducteeType,row.deducteeId,row.deducteeName,panStatusOf(row.deducteeId),row.base,row.rate,row.tds,row.sourceType,row.sourceRef,now));
  if(statements.length)await db.batch(statements);
  await db.prepare("DELETE FROM tds_deductions WHERE period=? AND computed_at<>?").bind(input.period,now).run();
 }
 if(panPending)issues.push(`${panPending} deductee PAN(s) pending verification - resolve before filing (s206AA applies 20% without PAN)`);

 const sections:TdsComputation["sections"]={};
 for(const row of rows){
  const bucket=sections[row.section]||{base:0,tds:0,deductees:0};
  bucket.base=round2(bucket.base+row.base);bucket.tds=round2(bucket.tds+row.tds);bucket.deductees+=1;sections[row.section]=bucket;
 }
 const depositDueDate=monthNum===3?`${year}-04-30`:monthNum===12?`${year+1}-01-07`:`${year}-${String(monthNum+1).padStart(2,"0")}-07`;
 return{period:input.period,sections,totalTds:round2(rows.reduce((sum,row)=>sum+row.tds,0)),issues,depositDueDate,deducteeRows:rows.length,panVerified,panPending,persisted:persist};
}

/** Indian PAN: five letters, four digits, one letter. The fourth letter encodes the holder type. */
const PAN_PATTERN=/^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** Stored reference only: the five leading characters are dropped, never persisted. ABCDE1234F -> *****1234F */
const maskPan=(pan:string)=>`*****${pan.slice(5)}`;

/** Record a deductee's PAN as verified. The ONLY writer of pan_status='verified'. [FIN-W1-D3]
 *
 *  Refuses a malformed PAN and a deductee that has no deduction row, so the registry cannot be
 *  populated by a typo. The verification is written to tds_pan_registry (which no recompute touches)
 *  and stamped onto the deductee's existing deductions, so the dashboard and
 *  lib/tds-tcs-reconciliation clear their s206AA warning immediately rather than at the next
 *  recompute. Verification is per DEDUCTEE, not per period: a PAN confirmed in August is still
 *  confirmed in September, which is what makes the close checklist closable month after month. */
export async function recordTdsPanVerification(db:Db,input:{deducteeId:string;pan:string;actorId:string;asOf?:number}){
 await ensureTdsTables(db);
 const deducteeId=String(input.deducteeId||"").trim();
 if(!deducteeId)throw governedJsonError({error:"A deductee is required to verify a PAN"},400);
 const pan=String(input.pan||"").trim().toUpperCase();
 if(!PAN_PATTERN.test(pan))throw governedJsonError({error:"PAN must be 10 characters in the form ABCDE1234F"},400);
 const deductee=await db.prepare("SELECT deductee_type,deductee_name FROM tds_deductions WHERE deductee_id=? ORDER BY computed_at DESC").bind(deducteeId).first<Row>();
 if(!deductee)throw governedJsonError({error:`No TDS deduction has been computed for ${deducteeId}; compute the period before verifying its PAN`},404);
 const reference=maskPan(pan),now=input.asOf??Date.now();
 await db.prepare("INSERT INTO tds_pan_registry (deductee_id,deductee_type,deductee_name,pan_reference,status,verified_by,verified_at,updated_at) VALUES (?,?,?,?,'verified',?,?,?) ON CONFLICT(deductee_id) DO UPDATE SET deductee_type=excluded.deductee_type,deductee_name=excluded.deductee_name,pan_reference=excluded.pan_reference,status='verified',verified_by=excluded.verified_by,verified_at=excluded.verified_at,updated_at=excluded.updated_at")
  .bind(deducteeId,String(deductee.deductee_type||"provider"),String(deductee.deductee_name||deducteeId),reference,input.actorId,now,now).run();
 const stamped=await db.prepare("UPDATE tds_deductions SET pan_status='verified' WHERE deductee_id=? AND pan_status!='verified'").bind(deducteeId).run();
 return{deducteeId,panReference:reference,status:"verified" as const,verifiedBy:input.actorId,verifiedAt:now,deductionRowsUpdated:Number(stamped.meta.changes||0)};
}

export async function recordTdsDeposit(db:Db,input:{period:string;challanReference:string;amount:number;actorId:string;asOf?:number}){
 await ensureTdsTables(db);
 const challan=String(input.challanReference||"").trim();
 if(!challan)throw governedJsonError({error:"Challan reference (ITNS-281) is required"},400);
 const computed=await db.prepare("SELECT COALESCE(SUM(tds_amount),0) total FROM tds_deductions WHERE period=?").bind(input.period).first<Row>();
 const liability=round2(Number(computed?.total||0));
 if(Math.abs(liability-round2(Number(input.amount)))>0.01)throw governedJsonError({error:`Deposit must equal the computed liability of ${liability} for ${input.period}`},409);
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
 if(!Number.isInteger(startYear))throw governedJsonError({error:"fyLabel must look like FY2026-27"},400);
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
 if(!ack)throw governedJsonError({error:"TRACES acknowledgement reference is required"},400);
 const now=input.asOf??Date.now();
 const result=await db.prepare("UPDATE tds_quarterly_returns SET status='filed',acknowledgement_ref=?,filed_by=?,filed_at=? WHERE fy_label=? AND quarter=? AND form=? AND status='prepared'")
  .bind(ack,input.actorId,now,input.fyLabel,input.quarter,input.form).run();
 if(!Number(result.meta.changes))throw governedJsonError({error:"Prepare the quarterly return before marking it filed (or it is already filed)"},409);
 return{fyLabel:input.fyLabel,quarter:input.quarter,form:input.form,status:"filed" as const,acknowledgementRef:ack};
}

export async function tdsDashboard(db:Db,period:string){
 await ensureTdsTables(db);
 const deductions=await safeAll(db,"SELECT section,deductee_type,deductee_id,deductee_name,base_amount,rate_pct,tds_amount,pan_status FROM tds_deductions WHERE period=? ORDER BY section,tds_amount DESC",[period]);
 const deposit=await db.prepare("SELECT * FROM tds_deposits WHERE period=?").bind(period).first<Row>();
 const returns=await safeAll(db,"SELECT fy_label,quarter,form,total_tds,total_deposited,deductee_count,status,acknowledgement_ref FROM tds_quarterly_returns ORDER BY fy_label DESC,quarter DESC");
 const panPending=deductions.filter(row=>String(row.pan_status||"")!=="verified").length;
 return{period,deductions,deposit:deposit||null,quarterlyReturns:returns,panPending,panVerified:deductions.length-panPending};
}
