// Real P&L reporting engine built on top of the actual chart of accounts (lib/chart-of-accounts.ts)
// and the platform's real transactional data (canonical_bookings, finance_journal_entries).
// This computes real numbers from whatever data genuinely exists in the environment it runs in -
// it does not fabricate figures. In a pre-launch UAT environment the output will correctly be
// near-zero until real bookings and approved expenses exist.

import{revenueChartOfAccounts,indirectIncomeChartOfAccounts,expenseChartOfAccounts}from"./chart-of-accounts";

type D1=D1Database;
type Row=Record<string,unknown>;

export interface PnlLine{code:string;category:string;subCategory:string;serviceCode:string|null;trackedByPlatform:boolean;monthly:Record<string,number>;total:number;businessContributionPct:number|null}
export interface PnlSection{title:string;lines:PnlLine[];subtotal:Record<string,number>;subtotalAmount:number}
/**
 * A month that Finance has CLOSED, reported beside the live recomputation for the same month.
 *
 * monthlyCloseView serves the frozen snapshot for a closed period while this report recomputes the same
 * month live from canonical_bookings, so any post-close change to a booking makes the two published
 * figures for one locked month differ permanently - and neither surface used to say which was
 * authoritative. closeMonth freezes the snapshot and refuses a second close with "post corrections in
 * the next open period", so for a locked month the snapshot IS the board-approved figure. Both are
 * published here, with the difference stated, rather than one silently winning.
 */
export interface PnlClosedPeriod{month:string;status:string;closedAt:number|null;snapshotTurnoverAmount:number|null;liveTurnoverAmount:number;divergenceAmount:number}

export interface PnlReport{months:string[];revenue:PnlSection;indirectIncome:PnlSection;totalTurnover:Record<string,number>;totalTurnoverAmount:number;expenses:PnlSection;totalExpenses:Record<string,number>;totalExpensesAmount:number;nettProfit:Record<string,number>;nettProfitAmount:number;generatedAt:number;dataSource:"platform_live"|"platform_live_with_closed_periods";closedPeriods:PnlClosedPeriod[];note:string}

function monthKey(value:string|number):string{const date=new Date(value);return`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}`;}
function monthRange(fromMonth:string,toMonth:string):string[]{
  const months:string[]=[];let[y,m]=fromMonth.split("-").map(Number);const[toY,toM]=toMonth.split("-").map(Number);
  while(y<toY||(y===toY&&m<=toM)){months.push(`${y}-${String(m).padStart(2,"0")}`);m++;if(m>12){m=1;y++;}}
  return months;
}
function emptyMonthly(months:string[]):Record<string,number>{const out:Record<string,number>={};for(const month of months)out[month]=0;return out;}
function addToMonthly(monthly:Record<string,number>,month:string,amount:number){monthly[month]=(monthly[month]||0)+amount;}
function sumMonthly(monthly:Record<string,number>):number{return Object.values(monthly).reduce((sum,value)=>sum+value,0);}
function sumInto(target:Record<string,number>,source:Record<string,number>){for(const[month,value]of Object.entries(source))target[month]=(target[month]||0)+value;}

async function ensurePnlSourceTables(db:D1){
  await db.exec("CREATE TABLE IF NOT EXISTS finance_journal_entries (id text PRIMARY KEY NOT NULL,entry_date text NOT NULL,source_type text NOT NULL,source_id text NOT NULL,account_code text NOT NULL,cost_centre text,vertical text,debit real DEFAULT 0 NOT NULL,credit real DEFAULT 0 NOT NULL,narration text NOT NULL,period_code text NOT NULL,posted integer DEFAULT 0 NOT NULL,created_at integer NOT NULL)");
  const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").first();
  return Boolean(exists);
}

export async function generatePnlReport(db:D1,input:{fromMonth:string;toMonth:string}):Promise<PnlReport>{
  const months=monthRange(input.fromMonth,input.toMonth);
  const bookingsTableExists=await ensurePnlSourceTables(db);

  // --- Revenue side: real canonical_bookings, grouped by service_code -> mapped to MIS revenue categories.
  // Only non-cancelled bookings count as recognized revenue (matches BookingStatus in backend/src/domain.ts).
  const revenueByServiceMonth=new Map<string,Record<string,number>>();
  if(bookingsTableExists){
    const rows=await db.prepare("SELECT service_code,scheduled_start,total_amount FROM canonical_bookings WHERE status!='cancelled' AND status!='draft'").all<Row>();
    for(const row of rows.results){
      const service=String(row.service_code||""),month=monthKey(String(row.scheduled_start)),amount=Number(row.total_amount||0);
      if(!revenueByServiceMonth.has(service))revenueByServiceMonth.set(service,{});
      addToMonthly(revenueByServiceMonth.get(service)!,month,amount);
    }
  }
  // Several MIS sub-lines share one platform service_code (e.g. REV-GROOMING + REV-GROOMING-SUB are
  // both "grooming"; five training lines are all "dog_training"). Each canonical booking must be
  // counted exactly ONCE, so only the first chart line per service_code carries the platform total;
  // later same-code lines are sub-format placeholders with no distinct platform source yet.
  // Before this, grooming revenue was double-counted and training revenue counted five times over,
  // so total turnover disagreed with the canonical_bookings truth every other view derives from.
  const consumedServiceCodes=new Set<string>();
  const revenueLines:PnlLine[]=revenueChartOfAccounts.map(entry=>{
    const monthly=emptyMonthly(months);
    const primaryForService=Boolean(entry.serviceCode)&&!consumedServiceCodes.has(entry.serviceCode as string);
    if(entry.serviceCode&&primaryForService){
      consumedServiceCodes.add(entry.serviceCode);
      const byMonth=revenueByServiceMonth.get(entry.serviceCode);
      if(byMonth)for(const month of months)if(month in byMonth)monthly[month]=byMonth[month];
    }
    return{code:entry.code,category:entry.category,subCategory:entry.subCategory,serviceCode:entry.serviceCode,trackedByPlatform:entry.serviceCode!==null&&primaryForService,monthly,total:sumMonthly(monthly),businessContributionPct:null};
  });
  const revenueTotal=revenueLines.reduce((sum,line)=>sum+line.total,0);
  for(const line of revenueLines)line.businessContributionPct=revenueTotal>0?Math.round((line.total/revenueTotal)*1000)/10:0;
  const revenueSubtotal=emptyMonthly(months);for(const line of revenueLines)sumInto(revenueSubtotal,line.monthly);

  // --- Indirect income: no platform source exists yet for any of these lines (Amazon Discount, Balance
  // Writtenoff, Discount Received, Other Income are all manual/legacy bookkeeping entries today).
  const indirectIncomeLines:PnlLine[]=indirectIncomeChartOfAccounts.map(entry=>({code:entry.code,category:entry.category,subCategory:entry.subCategory,serviceCode:null,trackedByPlatform:false,monthly:emptyMonthly(months),total:0,businessContributionPct:0}));
  const indirectIncomeSubtotal=emptyMonthly(months);

  const totalTurnover=emptyMonthly(months);sumInto(totalTurnover,revenueSubtotal);sumInto(totalTurnover,indirectIncomeSubtotal);
  const totalTurnoverAmount=sumMonthly(totalTurnover);

  // --- Expense side: real finance_journal_entries (posted, debit side only = expense recognition),
  // grouped by account_code -> mapped back to the real chart of accounts.
  const expenseByAccountMonth=new Map<string,Record<string,number>>();
  const journalRows=await db.prepare("SELECT account_code,entry_date,debit FROM finance_journal_entries WHERE posted=1 AND debit>0").all<Row>();
  for(const row of journalRows.results){
    const account=String(row.account_code||""),month=monthKey(String(row.entry_date)),amount=Number(row.debit||0);
    if(!expenseByAccountMonth.has(account))expenseByAccountMonth.set(account,{});
    addToMonthly(expenseByAccountMonth.get(account)!,month,amount);
  }
  const expenseLines:PnlLine[]=expenseChartOfAccounts.map(entry=>{
    const monthly=emptyMonthly(months);
    const byMonth=expenseByAccountMonth.get(entry.accountCode);
    if(byMonth)for(const month of months)if(month in byMonth)monthly[month]+=byMonth[month];
    return{code:entry.code,category:entry.category,subCategory:entry.subCategory,serviceCode:null,trackedByPlatform:true,monthly,total:sumMonthly(monthly),businessContributionPct:null};
  });
  const expenseSubtotal=emptyMonthly(months);for(const line of expenseLines)sumInto(expenseSubtotal,line.monthly);
  const totalExpensesAmount=sumMonthly(expenseSubtotal);

  const nettProfit=emptyMonthly(months);for(const month of months)nettProfit[month]=(totalTurnover[month]||0)-(expenseSubtotal[month]||0);
  const nettProfitAmount=totalTurnoverAmount-totalExpensesAmount;

  // Closed months, reported beside this report's own recomputation of the same month. A missing
  // finance_monthly_closes table means no month has ever been closed, which is genuinely nothing to
  // declare - it cannot mask a close, because closing one would have created the table.
  const closedPeriods:PnlClosedPeriod[]=[];
  // Range-scanned rather than an IN list: `months` grows with the requested range, so an IN list here
  // would break past D1's 100-bound-parameter cap on a long report. Period codes are YYYY-MM, so they
  // compare lexicographically in calendar order.
  const closes=months.length?await db.prepare("SELECT period,status,snapshot_json,closed_at FROM finance_monthly_closes WHERE period>=? AND period<=?").bind(months[0],months[months.length-1]).all<Record<string,unknown>>().catch(()=>null):null;
  for(const row of closes?.results??[]){
    if(!["closed","locked"].includes(String(row.status||"")))continue;
    const month=String(row.period);
    let snapshotTurnover:number|null=null;
    try{
      const snapshot=JSON.parse(String(row.snapshot_json||"{}")) as {revenue?:{total?:unknown};totalTurnoverAmount?:unknown};
      const total=Number(snapshot?.revenue?.total??snapshot?.totalTurnoverAmount??NaN);
      if(Number.isFinite(total))snapshotTurnover=total;
    }catch{/* a malformed snapshot must not take the whole report down */}
    const live=Number(totalTurnover[month]||0);
    closedPeriods.push({month,status:String(row.status),closedAt:row.closed_at==null?null:Number(row.closed_at),snapshotTurnoverAmount:snapshotTurnover,liveTurnoverAmount:live,divergenceAmount:snapshotTurnover==null?0:Math.round((live-snapshotTurnover)*100)/100});
  }

  return{
    months,
    revenue:{title:"Sales Accounts",lines:revenueLines,subtotal:revenueSubtotal,subtotalAmount:revenueTotal},
    indirectIncome:{title:"Indirect Incomes",lines:indirectIncomeLines,subtotal:indirectIncomeSubtotal,subtotalAmount:0},
    totalTurnover,totalTurnoverAmount,
    expenses:{title:"Indirect Expenses",lines:expenseLines,subtotal:expenseSubtotal,subtotalAmount:totalExpensesAmount},
    totalExpenses:expenseSubtotal,totalExpensesAmount,
    nettProfit,nettProfitAmount,
    generatedAt:Date.now(),
    dataSource:closedPeriods.length?"platform_live_with_closed_periods":"platform_live",
    closedPeriods,
    note:"Computed from real canonical_bookings and finance_journal_entries in this environment. Lines marked trackedByPlatform:false (B2B events, Experience Centre, non-Bengaluru cities, Rapido) have no platform data source yet and will read zero until either a historical import or a new booking flow exists for them.",
  };
}
