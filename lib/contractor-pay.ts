// Full-time contractor pay. Owner decision 7 (26 Sept 2026): full-time providers are contractors. Each month
// they are paid a fixed fee, an incentive and petrol as separate statement lines, with TDS deducted on the fee
// and incentive (never on the petrol reimbursement). They are not on employee payroll, so no PF, ESI or
// professional tax, and they are never paid commission (lib/full-time-providers.ts keeps them out of the
// commission sync, the legacy partner settlement statement and its payout, and per-session trainer payouts).
//
// A pay profile is effective-dated and versioned per provider. A monthly statement is worked out from the
// profile versions that cover the month (the fee is pro-rated by active days), the service's existing
// incentive engine (petrol taken out of it) and the existing petrol rule in lib/provider-daily-travel.ts,
// computed on its own so it is paid even when the month misses the incentive floor. Finance approves a
// statement with one click; approval is idempotent per provider and month and posts one balanced journal.
// Sending the money stays behind the existing payout approvals: nothing here moves money.
import{findExpenseCategory}from"./chart-of-accounts";
import{prepareJournalPosting}from"./finance-accounts";
import{fullTimeProviderIds}from"./full-time-providers";
import{GovernedRefusal}from"./governed-http-error";
import{computeGroomerMonthlyIncentive,ensureGroomingIncentiveTables}from"./grooming-incentive-engine";
import{monthlyPetrolAllowance}from"./provider-daily-travel";
import{TDS_RATES}from"./tds-governance";
import{computeTrainerMonthlyIncentive}from"./trainer-incentive-engine";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const rows=<T=Row>(r:{results?:unknown[]})=>(r.results||[]) as T[];
const refuse=(message:string,status=409)=>new GovernedRefusal(message,status);
const DAY=86_400_000;
const isoDay=(ms:number)=>new Date(ms).toISOString().slice(0,10);
const dayMs=(day:string)=>Date.parse(`${day}T00:00:00Z`);
const validDay=(day:string)=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(dayMs(day))&&isoDay(dayMs(day))===day;
const rupees=(v:number)=>`Rs ${money(v).toLocaleString("en-IN")}`;

/**
 * Default TDS on a contractor's fee and incentive: section 194J at TDS_RATES.professional194J (10%).
 * Why this default: lib/tds-governance.ts already files full-time / contract-engaged providers under 194J
 * (professional fees), so the statement deducts what the 26Q engine and the TDS reconciliation expect.
 * The CA may prefer 194C (payment to a contractor for work, 1% or 2%) for groomers and drivers; Finance can
 * change the section and rate per provider, with a reason, and the change is audited.
 */
export const CONTRACTOR_TDS_DEFAULT={section:"194J",ratePct:Math.round(TDS_RATES.professional194J*10000)/100} as const;
export const CONTRACTOR_TDS_SECTIONS=["194J","194C"] as const;
/** The rate used when Finance leaves it blank follows the section: 194J 10%; 194C 1% (an individual payee), never 194J's 10%. */
export const CONTRACTOR_TDS_DEFAULT_RATE_PCT:Record<(typeof CONTRACTOR_TDS_SECTIONS)[number],number>={"194J":CONTRACTOR_TDS_DEFAULT.ratePct,"194C":Math.round(TDS_RATES.contract194C*10000)/100};
/** The highest rate a deductor may apply (s206AA, no PAN on record). */
export const CONTRACTOR_TDS_MAX_RATE_PCT=20;
/** daily_travel_allowance = the existing rule in lib/provider-daily-travel.ts (a flat amount for each day
 *  whose routed home -> jobs -> home distance is over the threshold), paid as its own reimbursement line. */
export const CONTRACTOR_PETROL_RULES=["daily_travel_allowance","none"] as const;
/** Existing liability codes, plus TDS payable, which had no code yet: 2150 sits beside 2130 GST and 2140 TCS. */
export const CONTRACTOR_ACCOUNTS={providerPayable:"2110-Provider Payable",tdsPayable:"2150-TDS Payable"} as const;
const FEE_ACCOUNT:Record<string,string>={grooming:"EXP-CP-GROOMING",dog_training:"EXP-CP-TRAINER",training:"EXP-CP-TRAINER",food:"EXP-CP-FOOD",pet_taxi:"EXP-TAXI-EMPLOYEES"};
const PETROL_ACCOUNT:Record<string,string>={food:"EXP-FOOD-PETROL"};
function chartAccount(code:string){const found=findExpenseCategory(code);if(!found)throw new Error(`Chart of accounts has no ${code}`);return found.accountCode;}
/** Expense accounts come from the real chart of accounts (lib/chart-of-accounts.ts), so the P&L picks them up. */
export function contractorAccounts(serviceCode:string){return{fee:chartAccount(FEE_ACCOUNT[serviceCode]||"EXP-PROF-CHARGES"),petrol:chartAccount(PETROL_ACCOUNT[serviceCode]||"EXP-OFF-CONVEYANCE"),...CONTRACTOR_ACCOUNTS};}

export function contractorMonth(periodCode:string){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(text(periodCode)))throw refuse("Choose a month like 2026-09",400);
 const[year,month]=periodCode.split("-").map(Number),end=isoDay(Date.UTC(year,month,0));
 // The month is over at midnight India time on the 1st of the next month.
 return{start:`${periodCode}-01`,end,days:Number(end.slice(8,10)),closesAt:Date.UTC(year,month,1)-330*60_000,nextMonthStart:isoDay(Date.UTC(year,month,1))};
}

export async function ensureContractorPayTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS contractor_pay_profiles (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active',service_code TEXT NOT NULL,monthly_fee REAL NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,tds_section TEXT NOT NULL,tds_rate_pct REAL NOT NULL,petrol_rule TEXT NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(provider_id,version))"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_contractor_pay_profiles_window ON contractor_pay_profiles(provider_id,status,effective_from)"),
 db.prepare("CREATE TABLE IF NOT EXISTS contractor_monthly_statements (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,period_code TEXT NOT NULL,service_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',days_in_month INTEGER NOT NULL,active_days INTEGER NOT NULL,fixed_fee REAL NOT NULL,incentive REAL NOT NULL,petrol REAL NOT NULL,tds_section TEXT NOT NULL,tds_rate_pct REAL NOT NULL,tds_base REAL NOT NULL,tds_amount REAL NOT NULL,net_payable REAL NOT NULL,lines_json TEXT NOT NULL,blockers_json TEXT NOT NULL DEFAULT '[]',journal_group TEXT,approval_id TEXT,approved_by TEXT,approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(provider_id,period_code))"),
 db.prepare("CREATE TABLE IF NOT EXISTS contractor_pay_events (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,subject_type TEXT NOT NULL,subject_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_email TEXT NOT NULL,reason TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);}

export type ContractorPayProfile={id:string;providerId:string;version:number;status:string;serviceCode:string;monthlyFee:number;effectiveFrom:string;effectiveTo:string|null;tdsSection:string;tdsRatePct:number;petrolRule:string;reason:string;createdBy:string;createdAt:number};
const profileOf=(r:Row):ContractorPayProfile=>({id:text(r.id),providerId:text(r.provider_id),version:Number(r.version),status:text(r.status),serviceCode:text(r.service_code),monthlyFee:money(r.monthly_fee),effectiveFrom:text(r.effective_from),effectiveTo:r.effective_to==null?null:text(r.effective_to),tdsSection:text(r.tds_section),tdsRatePct:Number(r.tds_rate_pct),petrolRule:text(r.petrol_rule),reason:text(r.reason),createdBy:text(r.created_by),createdAt:Number(r.created_at)});
const eventStatement=(db:Db,input:{providerId:string;subjectType:string;subjectId:string;eventType:string;actor:string;reason?:string|null;detail:unknown;at:number})=>db.prepare("INSERT INTO contractor_pay_events (id,provider_id,subject_type,subject_id,event_type,actor_email,reason,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(uid("CPE"),input.providerId,input.subjectType,input.subjectId,input.eventType,input.actor,input.reason??null,JSON.stringify(input.detail??{}),input.at);

async function providerService(db:Db,providerId:string){try{const row=await db.prepare("SELECT services_json FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();const services=JSON.parse(text(row?.services_json)||"[]") as unknown[];return Array.isArray(services)?text(services[0]):"";}catch{return"";}}
/** A pay change must not reach back into a month whose statement Finance has already approved. */
async function assertNoApprovedMonthFrom(db:Db,providerId:string,firstChangedDay:string){
 const locked=await db.prepare("SELECT period_code FROM contractor_monthly_statements WHERE provider_id=? AND status='approved' AND period_code>=? ORDER BY period_code DESC LIMIT 1").bind(providerId,firstChangedDay.slice(0,7)).first<Row>();
 if(locked)throw refuse(`The ${text(locked.period_code)} statement for this provider is already approved, so pay changes can only start from ${contractorMonth(text(locked.period_code)).nextMonthStart}.`);
}

export async function saveContractorPayProfile(db:Db,input:{providerId:string;serviceCode?:string|null;monthlyFee:number;effectiveFrom:string;effectiveTo?:string|null;tdsSection?:string|null;tdsRatePct?:number|null;petrolRule?:string|null;reason:string;actorId:string}){
 await ensureContractorPayTables(db);
 const providerId=text(input.providerId),reason=text(input.reason),actor=text(input.actorId),effectiveFrom=text(input.effectiveFrom),effectiveTo=text(input.effectiveTo)||null;
 if(!providerId)throw refuse("Choose the provider",400);
 if(!actor)throw refuse("The Finance user making this change is required",400);
 if(reason.length<8)throw refuse("Give a reason of at least 8 characters for this pay change",400);
 const monthlyFee=Number(input.monthlyFee);
 if(!Number.isFinite(monthlyFee)||monthlyFee<=0)throw refuse("The monthly fixed fee must be more than Rs 0",400);
 if(!validDay(effectiveFrom))throw refuse("The start date must be a real date (YYYY-MM-DD)",400);
 if(effectiveTo&&(!validDay(effectiveTo)||effectiveTo<effectiveFrom))throw refuse("The last working day must be a real date on or after the start date",400);
 const tdsSection=text(input.tdsSection)||CONTRACTOR_TDS_DEFAULT.section;
 if(!(CONTRACTOR_TDS_SECTIONS as readonly string[]).includes(tdsSection))throw refuse(`TDS section must be one of ${CONTRACTOR_TDS_SECTIONS.join(" or ")}`,400);
 const tdsRatePct=input.tdsRatePct==null||String(input.tdsRatePct).trim()===""?CONTRACTOR_TDS_DEFAULT_RATE_PCT[tdsSection as keyof typeof CONTRACTOR_TDS_DEFAULT_RATE_PCT]:Number(input.tdsRatePct);
 if(!Number.isFinite(tdsRatePct)||tdsRatePct<0||tdsRatePct>CONTRACTOR_TDS_MAX_RATE_PCT)throw refuse(`TDS rate must be between 0% and ${CONTRACTOR_TDS_MAX_RATE_PCT}%`,400);
 const petrolRule=text(input.petrolRule)||"daily_travel_allowance";
 if(!(CONTRACTOR_PETROL_RULES as readonly string[]).includes(petrolRule))throw refuse("Petrol rule must be the daily travel allowance or none",400);
 if(!(await fullTimeProviderIds(db)).has(providerId))throw refuse("This provider is not recorded as full-time. Record them as full-time first: commission providers are paid per job, not a monthly fee.");
 const serviceCode=text(input.serviceCode)||await providerService(db,providerId);
 if(!/^[a-z_]{3,40}$/.test(serviceCode))throw refuse("Choose the service this provider works in",400);
 await assertNoApprovedMonthFrom(db,providerId,effectiveFrom);
 const before=rows(await db.prepare("SELECT * FROM contractor_pay_profiles WHERE provider_id=? AND status='active' ORDER BY effective_from").bind(providerId).all<Row>()).map(profileOf);
 const latest=await db.prepare("SELECT COALESCE(MAX(version),0) version FROM contractor_pay_profiles WHERE provider_id=?").bind(providerId).first<Row>();
 const now=Date.now(),id=uid("CPP"),version=Number(latest?.version||0)+1,dayBefore=isoDay(dayMs(effectiveFrom)-DAY),rate=money(tdsRatePct);
 await db.batch([
  // A version starting on or after the new start date is replaced; one still running then ends the day before.
  db.prepare("UPDATE contractor_pay_profiles SET status='superseded' WHERE provider_id=? AND status='active' AND effective_from>=?").bind(providerId,effectiveFrom),
  db.prepare("UPDATE contractor_pay_profiles SET effective_to=? WHERE provider_id=? AND status='active' AND effective_from<? AND (effective_to IS NULL OR effective_to>=?)").bind(dayBefore,providerId,effectiveFrom,effectiveFrom),
  db.prepare("INSERT INTO contractor_pay_profiles (id,provider_id,version,status,service_code,monthly_fee,effective_from,effective_to,tds_section,tds_rate_pct,petrol_rule,reason,created_by,created_at) VALUES (?,?,?,'active',?,?,?,?,?,?,?,?,?,?)").bind(id,providerId,version,serviceCode,money(monthlyFee),effectiveFrom,effectiveTo,tdsSection,rate,petrolRule,reason,actor,now),
  eventStatement(db,{providerId,subjectType:"pay_profile",subjectId:id,eventType:"pay_profile_saved",actor,reason,detail:{version,serviceCode,monthlyFee:money(monthlyFee),effectiveFrom,effectiveTo,tdsSection,tdsRatePct:rate,petrolRule,before},at:now}),
 ]);
 return profileOf((await db.prepare("SELECT * FROM contractor_pay_profiles WHERE id=?").bind(id).first<Row>())!);
}

/** End a contractor's pay on their last working day, so a leaving month is pro-rated. */
export async function endContractorPayProfile(db:Db,input:{providerId:string;lastDay:string;reason:string;actorId:string}){
 await ensureContractorPayTables(db);
 const providerId=text(input.providerId),lastDay=text(input.lastDay),reason=text(input.reason),actor=text(input.actorId);
 if(!providerId||!actor)throw refuse("Provider and the Finance user are required",400);
 if(reason.length<8)throw refuse("Give a reason of at least 8 characters for ending this pay",400);
 if(!validDay(lastDay))throw refuse("The last working day must be a real date (YYYY-MM-DD)",400);
 const running=await db.prepare("SELECT * FROM contractor_pay_profiles WHERE provider_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC LIMIT 1").bind(providerId,lastDay,lastDay).first<Row>();
 if(!running)throw refuse("This provider has no pay profile running on that date",404);
 const dayAfter=isoDay(dayMs(lastDay)+DAY);
 await assertNoApprovedMonthFrom(db,providerId,dayAfter);
 const now=Date.now();
 await db.batch([
  db.prepare("UPDATE contractor_pay_profiles SET status='superseded' WHERE provider_id=? AND status='active' AND effective_from>?").bind(providerId,lastDay),
  db.prepare("UPDATE contractor_pay_profiles SET effective_to=? WHERE id=?").bind(lastDay,running.id),
  eventStatement(db,{providerId,subjectType:"pay_profile",subjectId:text(running.id),eventType:"pay_profile_ended",actor,reason,detail:{lastDay,previousEffectiveTo:running.effective_to??null},at:now}),
 ]);
 return profileOf((await db.prepare("SELECT * FROM contractor_pay_profiles WHERE id=?").bind(running.id).first<Row>())!);
}

type Incentive={amount:number;source:string;detail:string;blocker?:string};
/** The month's incentive from the service's existing engine, with its petrol taken out: petrol is its own line. */
async function incentiveFor(db:Db,input:{providerId:string;serviceCode:string;monthStart:string}):Promise<Incentive>{
 const actorId="system:contractor_statement";
 if(input.serviceCode==="grooming"){
  await ensureGroomingIncentiveTables(db);
  // A result ops have finalised is used as it stands; otherwise the engine works it out now.
  const finalised=await db.prepare("SELECT result_json FROM groomer_incentive_results WHERE head_groomer_id=? AND month_start=? AND status='finalized'").bind(input.providerId,input.monthStart).first<Row>();
  let result:Record<string,unknown>;
  if(finalised)result=JSON.parse(text(finalised.result_json)||"{}") as Record<string,unknown>;
  else try{result=await computeGroomerMonthlyIncentive(db,{headGroomerId:input.providerId,monthStart:input.monthStart,actorId}) as unknown as Record<string,unknown>;}
  catch(error){if(/no bracket configured/i.test(error instanceof Error?error.message:String(error)))return{amount:0,source:"grooming_incentive",detail:"Not worked out yet",blocker:"Set this groomer's team or single incentive bracket for the month so the incentive can be worked out, then open the month again."};throw error;}
  const components=(result.components||{}) as Record<string,unknown>,amount=money(Number(result.headTotal||0)-Number(components.petrolAllowance||0));
  return{amount,source:finalised?"grooming_incentive_finalised":"grooming_incentive",detail:result.eligible?`Grooming incentive on ${rupees(Number(result.monthTotal||0))} of completed work${Number(components.gpayFine||0)>0?`, after a GPay pending fine of ${rupees(Number(components.gpayFine))}`:""}`:`${rupees(Number(result.monthTotal||0))} of completed grooming is below the Rs 1,00,000 incentive floor`};
 }
 if(input.serviceCode==="dog_training"||input.serviceCode==="training"){
  const result=await computeTrainerMonthlyIncentive(db,{trainerId:input.providerId,monthStart:input.monthStart,actorId});
  return{amount:money(result.total-result.petrolAllowance),source:"trainer_incentive",detail:`Training incentive on ${rupees(result.orderValue)} of completed training and ${result.meetGreetConversionCount} Meet & Greet conversion(s)`};
 }
 return{amount:0,source:"none",detail:"There is no incentive scheme for this service yet"};
}

export type ContractorStatementLine={code:"fixed_fee"|"incentive"|"petrol"|"tds";label:string;amount:number;detail:string};
export type ContractorStatement={id:string;providerId:string;periodCode:string;serviceCode:string;daysInMonth:number;activeDays:number;fixedFee:number;incentive:number;petrol:number;tdsSection:string;tdsRatePct:number;tdsBase:number;tdsAmount:number;netPayable:number;lines:ContractorStatementLine[];blockers:string[];notes:string[]};
export const contractorStatementId=(providerId:string,periodCode:string)=>`CTS-${periodCode}-${providerId}`;

/** Work out one provider's statement for one month. Reads only; null when no pay profile covers the month. */
export async function computeContractorStatement(db:Db,input:{providerId:string;periodCode:string}):Promise<ContractorStatement|null>{
 await ensureContractorPayTables(db);
 const providerId=text(input.providerId),month=contractorMonth(input.periodCode);
 const versions=rows(await db.prepare("SELECT * FROM contractor_pay_profiles WHERE provider_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from").bind(providerId,month.end,month.start).all<Row>()).map(profileOf);
 if(!versions.length)return null;
 // Fixed fee: each version's monthly fee x the days it was active in the month / days in the month.
 let fixedFee=0,activeDays=0;const parts:string[]=[];
 for(const version of versions){
  const from=version.effectiveFrom>month.start?version.effectiveFrom:month.start,to=version.effectiveTo&&version.effectiveTo<month.end?version.effectiveTo:month.end,days=Math.round((dayMs(to)-dayMs(from))/DAY)+1;
  activeDays+=days;fixedFee+=version.monthlyFee*days/month.days;parts.push(`${rupees(version.monthlyFee)} x ${days}/${month.days} days`);
 }
 fixedFee=money(fixedFee);
 const latest=versions[versions.length-1],first=versions[0];
 const windowStart=first.effectiveFrom>month.start?first.effectiveFrom:month.start,windowEnd=latest.effectiveTo&&latest.effectiveTo<month.end?latest.effectiveTo:month.end;
 const blockers:string[]=[];
 if(!(await fullTimeProviderIds(db)).has(providerId))blockers.push("This provider is no longer recorded as full-time. Check how they are engaged before paying a monthly fee.");
 let incentive:Incentive;
 try{incentive=await incentiveFor(db,{providerId,serviceCode:latest.serviceCode,monthStart:month.start});}
 catch(error){incentive={amount:0,source:"error",detail:"Not worked out",blocker:`The incentive could not be worked out: ${error instanceof Error?error.message:String(error)}`};}
 if(incentive.blocker)blockers.push(incentive.blocker);
 // Petrol is worked out on its own, over the active days only, whatever the incentive came to.
 const petrol=latest.petrolRule==="daily_travel_allowance"?await monthlyPetrolAllowance(db,{providerId,monthStartDate:windowStart,monthEndDate:windowEnd}):null;
 const petrolAmount=money(petrol?.totalAllowance??0),tdsBase=money(fixedFee+incentive.amount),tdsAmount=money(Math.max(0,tdsBase)*latest.tdsRatePct/100),netPayable=money(tdsBase+petrolAmount-tdsAmount);
 const lines:ContractorStatementLine[]=[
  {code:"fixed_fee",label:"Monthly fixed fee",amount:fixedFee,detail:activeDays===month.days&&versions.length===1?`Full month (${month.days} days)`:`Pro-rated for ${activeDays} of ${month.days} days: ${parts.join(" + ")}`},
  {code:"incentive",label:"Incentive",amount:incentive.amount,detail:incentive.detail},
  {code:"petrol",label:"Petrol reimbursement",amount:petrolAmount,detail:petrol?`${petrol.qualifyingDayCount} day(s) with more than ${petrol.thresholdKm} km of routed travel, at ${rupees(petrol.amountPerDay)} a day`:"No petrol allowance for this provider"},
  {code:"tds",label:`TDS (section ${latest.tdsSection} at ${latest.tdsRatePct}%)`,amount:-tdsAmount,detail:`On the fee and incentive of ${rupees(tdsBase)}. No TDS on the petrol reimbursement.`},
 ];
 return{id:contractorStatementId(providerId,input.periodCode),providerId,periodCode:input.periodCode,serviceCode:latest.serviceCode,daysInMonth:month.days,activeDays,fixedFee,incentive:incentive.amount,petrol:petrolAmount,tdsSection:latest.tdsSection,tdsRatePct:latest.tdsRatePct,tdsBase,tdsAmount,netPayable,lines,blockers,notes:["Paid as a contractor, not an employee: no PF, ESI or professional tax is deducted.","Never paid commission on jobs."]};
}

const statementOf=(r:Row)=>({id:text(r.id),providerId:text(r.provider_id),periodCode:text(r.period_code),serviceCode:text(r.service_code),status:text(r.status),daysInMonth:Number(r.days_in_month),activeDays:Number(r.active_days),fixedFee:money(r.fixed_fee),incentive:money(r.incentive),petrol:money(r.petrol),tdsSection:text(r.tds_section),tdsRatePct:Number(r.tds_rate_pct),tdsBase:money(r.tds_base),tdsAmount:money(r.tds_amount),netPayable:money(r.net_payable),lines:JSON.parse(text(r.lines_json)||"[]") as ContractorStatementLine[],blockers:JSON.parse(text(r.blockers_json)||"[]") as string[],journalGroup:r.journal_group==null?null:text(r.journal_group),approvedBy:r.approved_by==null?null:text(r.approved_by),approvedAt:r.approved_at==null?null:Number(r.approved_at)});
/** Save a worked-out statement as a draft. An approved statement is never rewritten. */
const upsertDraft=(db:Db,s:ContractorStatement,now:number)=>db.prepare("INSERT INTO contractor_monthly_statements (id,provider_id,period_code,service_code,status,days_in_month,active_days,fixed_fee,incentive,petrol,tds_section,tds_rate_pct,tds_base,tds_amount,net_payable,lines_json,blockers_json,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_id,period_code) DO UPDATE SET service_code=excluded.service_code,days_in_month=excluded.days_in_month,active_days=excluded.active_days,fixed_fee=excluded.fixed_fee,incentive=excluded.incentive,petrol=excluded.petrol,tds_section=excluded.tds_section,tds_rate_pct=excluded.tds_rate_pct,tds_base=excluded.tds_base,tds_amount=excluded.tds_amount,net_payable=excluded.net_payable,lines_json=excluded.lines_json,blockers_json=excluded.blockers_json,updated_at=excluded.updated_at WHERE contractor_monthly_statements.status<>'approved'").bind(s.id,s.providerId,s.periodCode,s.serviceCode,s.daysInMonth,s.activeDays,s.fixedFee,s.incentive,s.petrol,s.tdsSection,s.tdsRatePct,s.tdsBase,s.tdsAmount,s.netPayable,JSON.stringify(s.lines),JSON.stringify(s.blockers),now,now).run();

/** Work out every contractor's draft statement for a month. Approved statements are left exactly as approved. */
export async function refreshContractorStatements(db:Db,periodCode:string){
 await ensureContractorPayTables(db);
 const month=contractorMonth(periodCode),now=Date.now();
 const providers=rows(await db.prepare("SELECT DISTINCT provider_id FROM contractor_pay_profiles WHERE status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY provider_id").bind(month.end,month.start).all<Row>()).map(r=>text(r.provider_id));
 for(const providerId of providers){const statement=await computeContractorStatement(db,{providerId,periodCode});if(statement)await upsertDraft(db,statement,now);}
 // A draft whose pay profile no longer covers the month is dropped rather than left looking payable.
 const stale=rows(await db.prepare("SELECT id,provider_id FROM contractor_monthly_statements WHERE period_code=? AND status<>'approved'").bind(periodCode).all<Row>()).filter(r=>!providers.includes(text(r.provider_id)));
 for(const row of stale)await db.prepare("DELETE FROM contractor_monthly_statements WHERE id=? AND status<>'approved'").bind(row.id).run();
 return{periodCode,statements:providers.length};
}

/**
 * One Finance click. The statement is worked out again from current data; if expectedNetPayable is given
 * (the figure Finance was looking at) and it no longer matches, nothing is approved. Approving twice, or two
 * people clicking at once, approves and posts the journal exactly once.
 * Journal: Dr fee and incentive expense, Dr petrol expense; Cr 2110 Provider Payable (net), Cr 2150 TDS Payable.
 */
export async function approveContractorStatement(db:Db,input:{statementId:string;actorId:string;expectedNetPayable?:number|null;asOf?:number}){
 await ensureContractorPayTables(db);
 const actor=text(input.actorId);if(!actor)throw refuse("The Finance user approving this statement is required",400);
 const stored=await db.prepare("SELECT * FROM contractor_monthly_statements WHERE id=?").bind(text(input.statementId)).first<Row>();
 if(!stored)throw refuse("Contractor statement not found",404);
 if(text(stored.status)==="approved")return{...statementOf(stored),duplicatePrevented:true,liveMoney:false};
 const periodCode=text(stored.period_code),providerId=text(stored.provider_id),month=contractorMonth(periodCode);
 if((input.asOf??Date.now())<month.closesAt)throw refuse(`The ${periodCode} statement can be approved once the month is over, from ${month.nextMonthStart}.`);
 const fresh=await computeContractorStatement(db,{providerId,periodCode});
 if(!fresh)throw refuse("This provider no longer has a pay profile for that month. Open the month again to refresh it.");
 const now=Date.now();await upsertDraft(db,fresh,now);
 if(input.expectedNetPayable!=null&&String(input.expectedNetPayable).trim()!==""&&Math.abs(Number(input.expectedNetPayable)-fresh.netPayable)>0.01)throw refuse(`This statement changed since you opened it: the net payable is now ${rupees(fresh.netPayable)}. Check the new figures and approve again.`);
 if(fresh.blockers.length)throw refuse(fresh.blockers.join(" "));
 if(fresh.netPayable<0)throw refuse("The net payable cannot be below Rs 0");
 const accounts=contractorAccounts(fresh.serviceCode),vertical=fresh.serviceCode;
 const expense=(accountCode:string,amount:number)=>amount>=0?{accountCode,debit:amount,vertical}:{accountCode,credit:-amount,vertical};
 let plan:Awaited<ReturnType<typeof prepareJournalPosting>>;
 try{plan=await prepareJournalPosting(db,{groupKey:fresh.id,entryDate:month.end,periodCode,sourceType:"contractor_statement",sourceId:fresh.id,narration:`Full-time contractor pay for ${periodCode}: fixed fee, incentive and petrol, less TDS`,metadata:{serviceCode:vertical},lines:[expense(accounts.fee,fresh.fixedFee),expense(accounts.fee,fresh.incentive),expense(accounts.petrol,fresh.petrol),{accountCode:accounts.providerPayable,credit:fresh.netPayable,vertical},{accountCode:accounts.tdsPayable,credit:fresh.tdsAmount,vertical}]});}
 catch(error){const message=error instanceof Error?error.message:String(error);if(/^period_locked/.test(message))throw refuse(`The books for ${periodCode} are closed, so this statement cannot be approved into that month.`);throw error;}
 const approvalId=uid("CTA"),detail={fixedFee:fresh.fixedFee,incentive:fresh.incentive,petrol:fresh.petrol,tdsSection:fresh.tdsSection,tdsRatePct:fresh.tdsRatePct,tdsAmount:fresh.tdsAmount,netPayable:fresh.netPayable,journalGroup:plan.journalGroup,liveMoney:false};
 await db.batch([
  ...plan.statements,
  // The approval id marks the one click that won: a second click, or a second person at the same moment,
  // changes nothing and writes no second approval event.
  db.prepare("UPDATE contractor_monthly_statements SET status='approved',approval_id=?,approved_by=?,approved_at=?,journal_group=?,updated_at=? WHERE id=? AND status<>'approved'").bind(approvalId,actor,now,plan.journalGroup,now,fresh.id),
  db.prepare("INSERT INTO contractor_pay_events (id,provider_id,subject_type,subject_id,event_type,actor_email,reason,detail_json,created_at) SELECT ?,?,'statement',?,'statement_approved',?,NULL,?,? WHERE EXISTS (SELECT 1 FROM contractor_monthly_statements WHERE id=? AND approval_id=?)").bind(uid("CPE"),providerId,fresh.id,actor,JSON.stringify(detail),now,fresh.id,approvalId),
 ]);
 const after=await db.prepare("SELECT * FROM contractor_monthly_statements WHERE id=?").bind(fresh.id).first<Row>();
 const first=text(after?.approval_id)===approvalId;
 return{...statementOf(after!),duplicatePrevented:!first,liveMoney:false};
}

export async function contractorPayDashboard(db:Db,periodCode:string){
 await ensureContractorPayTables(db);contractorMonth(periodCode);
 await refreshContractorStatements(db,periodCode);
 const[profiles,statements,events,fullTime]=await Promise.all([
  db.prepare("SELECT * FROM contractor_pay_profiles WHERE status='active' ORDER BY provider_id,effective_from DESC").all<Row>(),
  db.prepare("SELECT * FROM contractor_monthly_statements WHERE period_code=? ORDER BY provider_id").bind(periodCode).all<Row>(),
  db.prepare("SELECT * FROM contractor_pay_events ORDER BY created_at DESC LIMIT 50").all<Row>(),
  fullTimeProviderIds(db),
 ]);
 const profileList=rows(profiles).map(profileOf),withProfile=new Set(profileList.map(p=>p.providerId));
 return{periodCode,defaults:{tdsSection:CONTRACTOR_TDS_DEFAULT.section,tdsRatePct:CONTRACTOR_TDS_DEFAULT.ratePct,tdsRatePctBySection:CONTRACTOR_TDS_DEFAULT_RATE_PCT,tdsSections:[...CONTRACTOR_TDS_SECTIONS],maxTdsRatePct:CONTRACTOR_TDS_MAX_RATE_PCT,petrolRule:"daily_travel_allowance",petrolRules:[...CONTRACTOR_PETROL_RULES]},profiles:profileList,statements:rows(statements).map(statementOf),fullTimeWithoutProfile:[...fullTime].filter(id=>!withProfile.has(id)).sort(),events:rows(events).map(e=>({id:text(e.id),providerId:text(e.provider_id),eventType:text(e.event_type),actor:text(e.actor_email),reason:e.reason==null?null:text(e.reason),createdAt:Number(e.created_at)})),livePayout:false};
}
